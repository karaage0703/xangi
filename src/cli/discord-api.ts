/**
 * Discord REST API 直叩きモジュール
 *
 * xangiプロセスのDiscord.jsクライアントに依存せず、
 * REST APIで直接Discord操作を行う。
 */

import { ValidationError } from '../errors.js';

const API_BASE = 'https://discord.com/api/v10';
const MAX_MESSAGE_LENGTH = 2000;

function getToken(): string {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN environment variable is not set');
  }
  return token;
}

function getBotId(): string | undefined {
  return process.env.DISCORD_BOT_ID;
}

async function discordFetch(path: string, options?: RequestInit): Promise<unknown> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord API error ${res.status}: ${body}`);
  }

  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

// ─── Discord Message Type ───────────────────────────────────────────

interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string; discriminator: string };
  timestamp: string;
  attachments: { id: string; filename: string; url: string }[];
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

interface DiscordCommandContext {
  channelId?: string;
}

// ─── Commands ───────────────────────────────────────────────────────

function resolveHistoryChannelId(
  flags: Record<string, string>,
  context?: DiscordCommandContext
): string {
  const explicitChannelId = flags['channel'];
  if (explicitChannelId) return explicitChannelId;

  const currentChannelId = context?.channelId ?? process.env.XANGI_CHANNEL_ID;
  if (currentChannelId) return currentChannelId;

  throw new ValidationError(
    [
      'discord_history: channel が未指定です。',
      'xangi上で実行中なら現在のチャンネルIDを自動補完します。',
      'CLI単体実行では `--channel <チャンネルID>` を付けてください。',
    ].join(' ')
  );
}

async function discordHistory(
  flags: Record<string, string>,
  context?: DiscordCommandContext
): Promise<string> {
  const channelId = resolveHistoryChannelId(flags, context);

  const count = Math.min(parseInt(flags['count'] || '10', 10), 100);
  const offset = parseInt(flags['offset'] || '0', 10);

  let beforeId: string | undefined;

  // offset指定時: まずoffset分のメッセージを取得してスキップ
  if (offset > 0) {
    const skipMessages = (await discordFetch(
      `/channels/${channelId}/messages?limit=${offset}`
    )) as DiscordMessage[];
    if (skipMessages.length > 0) {
      beforeId = skipMessages[skipMessages.length - 1].id;
    }
  }

  const query = new URLSearchParams({ limit: String(count) });
  if (beforeId) query.set('before', beforeId);

  const messages = (await discordFetch(
    `/channels/${channelId}/messages?${query}`
  )) as DiscordMessage[];

  // 古い順にソート
  messages.reverse();

  const rangeStart = offset;
  const rangeEnd = offset + messages.length;
  const offsetLabel = offset > 0 ? `${rangeStart}〜${rangeEnd}件目` : `最新${messages.length}件`;

  const lines = messages.map((m) => {
    const time = new Date(m.timestamp).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
    });
    const content = (m.content || '(添付ファイルのみ)').slice(0, 200);
    const attachments =
      m.attachments.length > 0
        ? '\n' + m.attachments.map((a) => `  📎 ${a.filename} ${a.url}`).join('\n')
        : '';
    return `[${time}] (ID:${m.id}) ${m.author.username}: ${content}${attachments}`;
  });

  return `📺 チャンネル履歴（${offsetLabel}）:\n${lines.join('\n')}`;
}

async function discordSend(flags: Record<string, string>): Promise<string> {
  const channelId = flags['channel'];
  const message = flags['message'];
  if (!channelId) throw new ValidationError('--channel is required');
  if (!message) throw new ValidationError('--message is required');

  // 2000文字制限に合わせて分割送信
  const chunks: string[] = [];
  for (let i = 0; i < message.length; i += MAX_MESSAGE_LENGTH) {
    chunks.push(message.slice(i, i + MAX_MESSAGE_LENGTH));
  }

  for (const chunk of chunks) {
    await discordFetch(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: chunk,
        allowed_mentions: { parse: [] },
      }),
    });
  }

  return `✅ メッセージを送信しました (${chunks.length} chunk(s))`;
}

async function discordChannels(flags: Record<string, string>): Promise<string> {
  const guildId = flags['guild'];
  if (!guildId) throw new ValidationError('--guild is required');

  const channels = (await discordFetch(`/guilds/${guildId}/channels`)) as DiscordChannel[];

  // テキストチャンネルのみ (type 0)
  const textChannels = channels
    .filter((c) => c.type === 0)
    .map((c) => `- #${c.name} (${c.id})`)
    .join('\n');

  return `📺 チャンネル一覧:\n${textChannels}`;
}

async function discordSearch(flags: Record<string, string>): Promise<string> {
  const channelId = flags['channel'];
  const keyword = flags['keyword'];
  if (!channelId) throw new ValidationError('--channel is required');
  if (!keyword) throw new ValidationError('--keyword is required');

  // Discord REST APIにはメッセージ検索がないため、最新100件を取得してフィルタ
  const messages = (await discordFetch(
    `/channels/${channelId}/messages?limit=100`
  )) as DiscordMessage[];

  const matched = messages.filter((m) => m.content.toLowerCase().includes(keyword.toLowerCase()));

  if (matched.length === 0) {
    return `🔍 「${keyword}」に一致するメッセージが見つかりませんでした`;
  }

  const results = matched
    .slice(0, 10)
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
      });
      return `[${time}] ${m.author.username}: ${m.content.slice(0, 200)}`;
    })
    .join('\n');

  return `🔍 「${keyword}」の検索結果 (${matched.length}件):\n${results}`;
}

async function discordEdit(flags: Record<string, string>): Promise<string> {
  const channelId = flags['channel'];
  const messageId = flags['message-id'];
  const content = flags['content'];
  if (!channelId) throw new ValidationError('--channel is required');
  if (!messageId) throw new ValidationError('--message-id is required');
  if (!content) throw new ValidationError('--content is required');

  // 自分のメッセージか確認
  const botId = getBotId();
  if (botId) {
    const msg = (await discordFetch(
      `/channels/${channelId}/messages/${messageId}`
    )) as DiscordMessage;
    if (msg.author.id !== botId) {
      return '❌ 自分のメッセージのみ編集できます';
    }
  }

  await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });

  return '✏️ メッセージを編集しました';
}

async function discordDelete(flags: Record<string, string>): Promise<string> {
  const channelId = flags['channel'];
  const messageId = flags['message-id'];
  if (!channelId) throw new ValidationError('--channel is required');
  if (!messageId) throw new ValidationError('--message-id is required');

  // 自分のメッセージか確認
  const botId = getBotId();
  if (botId) {
    const msg = (await discordFetch(
      `/channels/${channelId}/messages/${messageId}`
    )) as DiscordMessage;
    if (msg.author.id !== botId) {
      return '❌ 自分のメッセージのみ削除できます';
    }
  }

  await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE',
  });

  return '🗑️ メッセージを削除しました';
}

async function mediaSend(flags: Record<string, string>): Promise<string> {
  const channelId = flags['channel'];
  const filePath = flags['file'];
  if (!channelId) throw new ValidationError('--channel is required');
  if (!filePath) throw new ValidationError('--file is required');

  const { readFileSync, existsSync } = await import('fs');
  const { basename } = await import('path');

  if (!existsSync(filePath)) {
    throw new ValidationError(`File not found: ${filePath}`);
  }

  const fileName = basename(filePath);
  const fileData = readFileSync(filePath);
  const token = getToken();

  // multipart/form-data で送信
  const boundary = '----XangiFormBoundary' + Date.now();
  const parts: Buffer[] = [];

  // JSON payload part
  const jsonPayload = JSON.stringify({ content: '' });
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${jsonPayload}\r\n`
    )
  );

  // File part
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    )
  );
  parts.push(fileData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Failed to upload file: ${res.status} ${errBody}`);
  }

  return `📎 ファイルを送信しました: ${fileName}`;
}

// ─── Router ─────────────────────────────────────────────────────────

export async function discordApi(
  command: string,
  flags: Record<string, string>,
  context?: DiscordCommandContext
): Promise<string> {
  switch (command) {
    case 'discord_history':
      return discordHistory(flags, context);
    case 'discord_send':
      return discordSend(flags);
    case 'discord_channels':
      return discordChannels(flags);
    case 'discord_search':
      return discordSearch(flags);
    case 'discord_edit':
      return discordEdit(flags);
    case 'discord_delete':
      return discordDelete(flags);
    case 'media_send':
      return mediaSend(flags);
    default:
      throw new ValidationError(`Unknown discord command: ${command}`);
  }
}
