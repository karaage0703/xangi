/**
 * Slack Web API direct command module.
 *
 * xangi tool uses this for Slack operations that do not need the running Bolt app.
 */

import { ValidationError } from '../errors.js';

const API_BASE = 'https://slack.com/api';
const DEFAULT_HISTORY_LIMIT = 15;
const MAX_HISTORY_LIMIT = 100;
const MAX_CHANNEL_LIMIT = 1000;

interface SlackCommandContext {
  channelId?: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  ts: string;
  thread_ts?: string;
}

interface SlackHistoryResponse extends SlackApiResponse {
  messages?: SlackMessage[];
}

interface SlackPostMessageResponse extends SlackApiResponse {
  channel?: string;
  ts?: string;
}

interface SlackChannel {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
}

interface SlackChannelsResponse extends SlackApiResponse {
  channels?: SlackChannel[];
}

function getToken(): string {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error('SLACK_BOT_TOKEN environment variable is not set');
  }
  return token;
}

function clampInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function resolveChannelId(
  flags: Record<string, string>,
  context: SlackCommandContext | undefined,
  command: string
): string {
  const explicitChannelId = flags['channel'];
  if (explicitChannelId) return explicitChannelId;

  const currentChannelId = context !== undefined ? context.channelId : process.env.XANGI_CHANNEL_ID;
  if (currentChannelId) return currentChannelId;

  throw new ValidationError(
    [
      `${command}: channel が未指定です。`,
      'xangi上で実行中なら現在のSlackチャンネルIDを自動補完します。',
      'CLI単体実行では `--channel <SlackチャンネルID>` を付けてください。',
    ].join(' ')
  );
}

async function slackFetch<T extends SlackApiResponse>(
  method: string,
  options?: {
    query?: Record<string, string | undefined>;
    body?: Record<string, unknown>;
  }
): Promise<T> {
  const url = new URL(`${API_BASE}/${method}`);
  for (const [key, value] of Object.entries(options?.query ?? {})) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, value);
    }
  }

  const hasBody = options?.body !== undefined;
  const res = await fetch(url, {
    method: hasBody ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(hasBody ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  let payload: T;
  try {
    payload = (await res.json()) as T;
  } catch {
    const text = await res.text().catch(() => '');
    throw new Error(`Slack API error ${res.status}: ${text || 'invalid JSON response'}`);
  }

  if (!res.ok || !payload.ok) {
    throw new Error(`Slack API error ${res.status}: ${payload.error ?? 'unknown_error'}`);
  }

  return payload;
}

function formatSlackTime(ts: string): string {
  const seconds = Number(ts.split('.')[0]);
  if (!Number.isFinite(seconds)) return ts;
  return new Date(seconds * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function formatSender(message: SlackMessage): string {
  return message.user ?? message.username ?? message.bot_id ?? 'unknown';
}

function messageText(message: SlackMessage): string {
  return (message.text || '(textなし)').replace(/\s+/g, ' ').trim();
}

async function slackSend(
  flags: Record<string, string>,
  context?: SlackCommandContext
): Promise<string> {
  const channelId = resolveChannelId(flags, context, 'slack_send');
  const message = flags['message'];
  const threadTs = flags['thread-ts'] || flags['thread'];
  if (!message) throw new ValidationError('--message is required');

  const response = await slackFetch<SlackPostMessageResponse>('chat.postMessage', {
    body: {
      channel: channelId,
      text: message,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
  });

  const tsLabel = response.ts ? ` (ts: ${response.ts})` : '';
  return `✅ Slackメッセージを送信しました${tsLabel}`;
}

async function slackChannels(flags: Record<string, string>): Promise<string> {
  const limit = clampInt(flags['limit'], 100, MAX_CHANNEL_LIMIT);
  const types = flags['types'] || 'public_channel,private_channel';
  const includeArchived = flags['include-archived'] === 'true';
  let cursor: string | undefined;
  const channels: SlackChannel[] = [];

  while (channels.length < limit) {
    const pageLimit = Math.min(200, limit - channels.length);
    const response = await slackFetch<SlackChannelsResponse>('conversations.list', {
      query: {
        types,
        limit: String(pageLimit),
        cursor,
        exclude_archived: includeArchived ? 'false' : 'true',
      },
    });
    channels.push(...(response.channels ?? []));
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  if (channels.length === 0) return '📺 Slackチャンネル一覧: 0件';

  const lines = channels.map((c) => {
    const privacy = c.is_private ? 'private' : 'public';
    const archived = c.is_archived ? ', archived' : '';
    return `- #${c.name ?? c.id} (${c.id}, ${privacy}${archived})`;
  });

  return `📺 Slackチャンネル一覧 (${channels.length}件):\n${lines.join('\n')}`;
}

async function slackSearch(
  flags: Record<string, string>,
  context?: SlackCommandContext
): Promise<string> {
  const channelId = resolveChannelId(flags, context, 'slack_search');
  const keyword = flags['keyword'];
  if (!keyword) throw new ValidationError('--keyword is required');

  const limit = clampInt(
    flags['count'] || flags['limit'],
    DEFAULT_HISTORY_LIMIT,
    MAX_HISTORY_LIMIT
  );
  const response = await slackFetch<SlackHistoryResponse>('conversations.history', {
    query: {
      channel: channelId,
      limit: String(limit),
    },
  });
  const messages = response.messages ?? [];
  const needle = keyword.toLowerCase();
  const matched = messages.filter((m) => messageText(m).toLowerCase().includes(needle));

  if (matched.length === 0) {
    return `🔍 Slackで「${keyword}」に一致するメッセージが見つかりませんでした（最新${messages.length}件）`;
  }

  const results = matched
    .slice(0, 10)
    .map(
      (m) =>
        `[${formatSlackTime(m.ts)}] (ts:${m.ts}) ${formatSender(m)}: ${messageText(m).slice(0, 200)}`
    )
    .join('\n');

  return `🔍 Slackで「${keyword}」の検索結果 (${matched.length}件 / 最新${messages.length}件):\n${results}`;
}

async function slackEdit(
  flags: Record<string, string>,
  context?: SlackCommandContext
): Promise<string> {
  const channelId = resolveChannelId(flags, context, 'slack_edit');
  const messageTs = flags['message-ts'] || flags['message-id'] || flags['ts'];
  const content = flags['content'];
  if (!messageTs) throw new ValidationError('--message-ts is required');
  if (!content) throw new ValidationError('--content is required');

  await slackFetch<SlackApiResponse>('chat.update', {
    body: {
      channel: channelId,
      ts: messageTs,
      text: content,
    },
  });

  return '✏️ Slackメッセージを編集しました';
}

async function slackDelete(
  flags: Record<string, string>,
  context?: SlackCommandContext
): Promise<string> {
  const channelId = resolveChannelId(flags, context, 'slack_delete');
  const messageTs = flags['message-ts'] || flags['message-id'] || flags['ts'];
  if (!messageTs) throw new ValidationError('--message-ts is required');

  await slackFetch<SlackApiResponse>('chat.delete', {
    body: {
      channel: channelId,
      ts: messageTs,
    },
  });

  return '🗑️ Slackメッセージを削除しました';
}

export async function slackApi(
  command: string,
  flags: Record<string, string>,
  context?: SlackCommandContext
): Promise<string> {
  switch (command) {
    case 'slack_send':
      return slackSend(flags, context);
    case 'slack_channels':
      return slackChannels(flags);
    case 'slack_search':
      return slackSearch(flags, context);
    case 'slack_edit':
      return slackEdit(flags, context);
    case 'slack_delete':
      return slackDelete(flags, context);
    default:
      throw new ValidationError(`Unknown slack command: ${command}`);
  }
}
