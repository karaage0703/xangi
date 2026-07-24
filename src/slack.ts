import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { Config } from './config.js';
import type { AgentRunner, RunResult } from './agent-runner.js';
import { processManager } from './process-manager.js';
import type { Skill } from './skills.js';
import { formatSkillList } from './skills.js';
import { downloadFile, buildAttachmentResult, buildPromptWithAttachments } from './file-utils.js';
import { loadReplySuggestionsEnabled, loadSettings, formatSettings } from './settings.js';
import { canSelfRestart, getSelfLifecyclePermission } from './self-lifecycle.js';
import { TIMEOUT_EXTEND_ENABLED } from './constants.js';
import { threadIdFor, turnIdFor } from './events-emitter.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import { prefetchSlackHistory } from './slack-history-prefetch.js';
import { StreamSession } from './stream-session.js';
import { registerStreamFinalizer } from './stream-finalizer.js';
import { formatAgentErrorForUser } from './errors.js';
import { markdownToSlackMrkdwn } from './slack-mrkdwn.js';
import { addToolHistory, appendToolHistory, formatToolHistoryDisclosure } from './tool-history.js';
import { ensureSession, getActiveSessionId, getProviderSessionId } from './sessions.js';
import { createSchedulerRunId } from './scheduler-run.js';
import {
  attachPlatformMessageIdToLast,
  findEntryByPlatformMessageId,
  updateMessageContent as updateTranscriptContent,
  deleteMessage as deleteTranscriptMessage,
} from './transcript-logger.js';
import type { KnownBlock } from '@slack/types';
import {
  appendReplySuggestionInstruction,
  fallbackReplySuggestions,
  formatNumberedSuggestions,
  sanitizeReplySuggestionOutput,
  stripReplySuggestionMarkup,
} from './reply-suggestions.js';

export function shouldReplyInSlackThread(
  slackConfig: Pick<Config['slack'], 'replyInThread' | 'replyInChannels'>,
  channelId: string
): boolean {
  if (slackConfig.replyInThread === false) return false;
  return !slackConfig.replyInChannels?.includes(channelId);
}

export function shouldProcessSlackMessage(
  slackConfig: Pick<Config['slack'], 'autoReplyChannels'>,
  input: {
    channel: string;
    channelType?: string;
    threadTs?: string;
    subtype?: string;
    hasActiveThreadSession?: boolean;
  }
): boolean {
  if (input.subtype && !['file_share', 'me_message'].includes(input.subtype)) return false;
  if (input.channelType === 'im') return true;
  if (input.threadTs && input.hasActiveThreadSession) return true;
  return slackConfig.autoReplyChannels?.includes(input.channel) ?? false;
}

export function slackConversationKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

export type SlackDeleteReactionTarget = {
  channelId: string;
  messageTs: string;
  userId: string;
  reaction: string;
};

export function resolveSlackDeleteReactionTarget(
  slackConfig: Pick<Config['slack'], 'allowedUsers' | 'reactionDeleteEnabled' | 'deleteReactions'>,
  event: {
    user?: string;
    reaction?: string;
    item?: { type?: string; channel?: string; ts?: string };
  }
): SlackDeleteReactionTarget | null {
  if (slackConfig.reactionDeleteEnabled === false) return null;
  const userId = event.user;
  if (!userId) return null;
  if (!slackConfig.allowedUsers?.includes('*') && !slackConfig.allowedUsers?.includes(userId)) {
    return null;
  }
  const reaction = event.reaction;
  const deleteReactions = slackConfig.deleteReactions ?? ['wastebasket', 'x'];
  if (!reaction || !deleteReactions.includes(reaction)) return null;
  if (event.item?.type !== 'message' || !event.item.channel || !event.item.ts) return null;
  return {
    channelId: event.item.channel,
    messageTs: event.item.ts,
    userId,
    reaction,
  };
}

function slackRunKeyFromActionBody(body: {
  channel?: { id?: string };
  message?: { thread_ts?: string; ts?: string };
}): string | undefined {
  const channelId = body.channel?.id;
  if (!channelId) return undefined;
  return slackConversationKey(channelId, body.message?.thread_ts);
}

function markSlackMessageProcessed(channelId: string, ts: string): boolean {
  const key = `${channelId}:${ts}`;
  if (processedSlackMessages.has(key)) return false;
  processedSlackMessages.add(key);
  setTimeout(() => processedSlackMessages.delete(key), 5 * 60 * 1000).unref?.();
  return true;
}

export function buildSlackCompletionNotification(input: {
  threadTs?: string;
  elapsedMs: number;
  thresholdMs: number;
}): string | null {
  if (input.threadTs) return null;
  if (input.elapsedMs < input.thresholdMs) return null;
  return `✅ 完了しました（${formatElapsed(input.elapsedMs)}）`;
}

function formatElapsed(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.round(elapsedMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}秒`;
  return `${min}分${sec.toString().padStart(2, '0')}秒`;
}

/** 残り時間を mm:ss でフォーマット */
function formatRemaining(remainingMs: number): string {
  const sec = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

/**
 * Slack Block Kit: 処理中ボタン (Stop / 延長 / 残り MM:SS の順)
 *
 * timeout 未指定なら従来通り Stop のみ。
 * extendEnabled=false (TIMEOUT_EXTEND_ENABLED=false) や canExtend=false (上限到達) なら
 * 延長ボタンを出さない。
 */
function createSlackProcessingBlocks(timeout?: {
  remainingMs: number;
  canExtend: boolean;
  extendEnabled: boolean;
}): KnownBlock[] {
  const elements: Array<{
    type: 'button';
    text: { type: 'plain_text'; text: string };
    action_id: string;
    style?: 'primary' | 'danger';
  }> = [];
  elements.push({
    type: 'button',
    text: { type: 'plain_text', text: 'Stop' },
    action_id: 'xangi_stop',
    style: 'danger',
  });
  if (timeout) {
    if (timeout.extendEnabled && timeout.canExtend) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: '延長' },
        action_id: 'xangi_extend',
        style: 'primary',
      });
    }
    const isWarn = timeout.remainingMs <= 30_000;
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: `⏱ ${formatRemaining(timeout.remainingMs)}` },
      action_id: 'xangi_timeout_display',
      ...(isWarn && { style: 'danger' as const }),
    });
  }
  return [{ type: 'actions', elements }];
}

/** チャンネルの現在のタイムアウト状態から UI 用に整形 (top-level 版) */
function getSlackTimeoutInfoFor(
  agentRunner: AgentRunner,
  channelId: string
): { remainingMs: number; canExtend: boolean; extendEnabled: boolean } | undefined {
  const state = agentRunner.getTimeoutState?.(channelId);
  if (!state?.active || state.timeoutAt == null) return undefined;
  const remainingMs = Math.max(0, state.timeoutAt - Date.now());
  // 延長 = 残り時間を 2 倍。残り時間を一度加算しても max を越えないか判定
  const canExtend =
    state.maxTimeoutAt != null && state.timeoutAt + remainingMs <= state.maxTimeoutAt;
  return { remainingMs, canExtend, extendEnabled: TIMEOUT_EXTEND_ENABLED };
}

/** Slack Block Kit: 完了後ボタン */
export function createSlackCompletedBlocks(options?: {
  showTools?: boolean;
  showReplySuggestions?: boolean;
  replySuggestionPayload?: { messageKey: string; suggestions: string[]; threadTs?: string };
}): KnownBlock[] {
  const elements: Array<{
    type: 'button';
    text: { type: 'plain_text'; text: string };
    action_id: string;
    value?: string;
  }> = [
    {
      type: 'button',
      text: { type: 'plain_text', text: 'New' },
      action_id: 'xangi_new',
    },
  ];
  if (options?.showTools) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Tools' },
      action_id: 'xangi_tools',
    });
  }
  if (options?.showReplySuggestions) {
    const payload = options.replySuggestionPayload;
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: '返信候補' },
      action_id: 'xangi_reply_suggestions',
      ...(payload && {
        value: JSON.stringify({
          messageKey: payload.messageKey,
          suggestions: payload.suggestions.map((suggestion) => suggestion.slice(0, 400)),
          ...(payload.threadTs && { threadTs: payload.threadTs }),
        }),
      }),
    });
  }
  return [
    {
      type: 'actions',
      elements,
    },
  ];
}

export function createSlackReplySuggestionBlocks(
  messageKey: string,
  suggestions: string[],
  threadTs?: string
): KnownBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: formatNumberedSuggestions(suggestions) },
    },
    {
      type: 'actions',
      elements: suggestions.map((_, index) => ({
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: String(index + 1) },
        action_id: `xangi_reply_suggestion_${index}`,
        value: JSON.stringify({ messageKey, index, ...(threadTs && { threadTs }) }),
      })),
    },
  ];
}

// セッション管理（conversationKey → provider session ID）
const sessions = new Map<string, string>();

// 最後のBotメッセージ（チャンネルID → メッセージts）
const lastBotMessages = new Map<string, string>();

/**
 * 処理中の Slack メッセージ管理 (タイムアウト UI 更新用)
 * runKey(conversationKey) -> { channelId, messageTs, threadTs, intervalId }。
 * runner の timeout-* イベントで残り時間 / +5m ブロックを 10 秒間隔で chat.update する。
 */
type SlackProcessingEntry = {
  channelId: string;
  messageTs: string;
  threadTs?: string;
  currentText: string;
  intervalId?: NodeJS.Timeout;
  /** タイムアウト UI が表示開始された時刻 (最小表示時間判定用) */
  startedAt?: number;
};
const slackProcessingMessages = new Map<string, SlackProcessingEntry>();
const slackToolHistoryByMessageKey = new Map<string, string[]>();
const slackReplySuggestionsByMessageKey = new Map<string, string[]>();
const busySlackConversations = new Set<string>();
const processedSlackMessages = new Set<string>();

// chat.update の本文と Block Kit の section を同じ上限で分割する。
// section text は最大3000文字のため、UTF-8で3000バイト以下なら両方の制限を満たす。
const SLACK_MAX_TEXT_BYTES = 3000;

function slackMessageKey(channelId: string, messageTs: string): string {
  return `${channelId}:${messageTs}`;
}

/**
 * 文字列をUTF-8バイト数で安全に切り詰める
 * マルチバイト文字の途中で切れないように処理
 */
function sliceByBytes(str: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(str).length <= maxBytes) {
    return str;
  }
  // バイナリサーチで最大文字位置を見つける
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(str.slice(0, mid)).length <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return str.slice(0, lo);
}

// 結果送信（長い場合は分割）
async function sendSlackResult(
  client: WebClient,
  channelId: string,
  messageTs: string,
  threadTs: string | undefined,
  result: string,
  blocks?: KnownBlock[]
): Promise<void> {
  // result は呼び出し側で mrkdwn へ変換済みの前提（ここでは変換しない）。
  // 変換は「finalテキスト確定時に一度だけ」行う（冪等でないため二重変換を避ける）。
  const text = sliceByBytes(result, SLACK_MAX_TEXT_BYTES);
  const textBytes = new TextEncoder().encode(text).length;
  console.log(
    `[slack] sendSlackResult: textChars=${text.length}, textBytes=${textBytes}, resultChars=${result.length}`
  );

  try {
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
      ...(blocks !== undefined && { blocks }),
    });

    // 残りのテキストがあれば分割送信
    if (text.length < result.length) {
      const remaining = result.slice(text.length);
      const chunks = splitTextByBytes(remaining, SLACK_MAX_TEXT_BYTES);
      console.log(
        `[slack] Sending remaining ${chunks.length} chunks (${remaining.length} chars left)`
      );
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel: channelId,
          text: chunk,
          ...(threadTs && { thread_ts: threadTs }),
        });
      }
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[slack] Failed to update final message:', errorMessage);

    if (errorMessage.includes('msg_too_long')) {
      console.log(`[slack] Fallback: trying shorter text (2000 bytes)`);
      // テキストを短くしてリトライ
      try {
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: sliceByBytes(result, 2000),
        });
        console.log(`[slack] Fallback: short update succeeded`);
      } catch {
        console.log(`[slack] Fallback: short update failed, using placeholder`);
        // それでもダメなら新規メッセージとして投稿
        await client.chat
          .update({
            channel: channelId,
            ts: messageTs,
            text: '（長文のため別メッセージで送信）',
          })
          .catch(() => {});
      }

      // 残りを分割送信
      const chunks = splitTextByBytes(result, SLACK_MAX_TEXT_BYTES);
      console.log(`[slack] Fallback: sending ${chunks.length} chunks`);
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel: channelId,
          text: chunk,
          ...(threadTs && { thread_ts: threadTs }),
        });
      }
      console.log(`[slack] Fallback: all chunks sent`);
    } else {
      // その他のエラーは再throw
      throw err;
    }
  }
}

// テキストをバイト数で分割
function splitTextByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = sliceByBytes(remaining, maxBytes);
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

// メッセージ削除の共通関数
async function deleteMessage(client: WebClient, channelId: string, arg: string): Promise<string> {
  let messageTs: string | undefined;

  if (arg) {
    // 引数がある場合: ts または メッセージリンクから抽出
    const linkMatch = arg.match(/\/p(\d{10})(\d{6})/);
    if (linkMatch) {
      messageTs = `${linkMatch[1]}.${linkMatch[2]}`;
    } else if (/^\d+\.\d+$/.test(arg)) {
      messageTs = arg;
    } else {
      return '無効な形式です。メッセージリンクまたは ts を指定してください';
    }
  } else {
    messageTs = lastBotMessages.get(channelId);
    if (!messageTs) {
      return '削除できるメッセージがありません';
    }
  }

  try {
    await client.chat.delete({
      channel: channelId,
      ts: messageTs,
    });
    if (!arg) {
      lastBotMessages.delete(channelId);
    }
    return '🗑️ メッセージを削除しました';
  } catch (err) {
    console.error('[slack] Failed to delete message:', err);
    return 'メッセージの削除に失敗しました';
  }
}

async function deleteMessageByReaction(
  client: WebClient,
  target: SlackDeleteReactionTarget
): Promise<string> {
  try {
    await client.chat.delete({
      channel: target.channelId,
      ts: target.messageTs,
    });
    for (const [channelId, messageTs] of lastBotMessages.entries()) {
      if (messageTs === target.messageTs) {
        lastBotMessages.delete(channelId);
      }
    }
    return '🗑️ メッセージを削除しました';
  } catch (err) {
    console.error('[slack] Failed to delete message by reaction:', err);
    return 'メッセージの削除に失敗しました';
  }
}

import type { Scheduler } from './scheduler.js';

export interface SlackChannelOptions {
  config: Config;
  agentRunner: AgentRunner;
  skills: Skill[];
  reloadSkills: () => Skill[];
  scheduler?: Scheduler;
}

export function registerSlackSchedulerBridge(deps: {
  scheduler: Scheduler;
  client: WebClient;
  config: Config;
  agentRunner: AgentRunner;
}): void {
  const { scheduler, client, config, agentRunner } = deps;

  scheduler.registerSender('slack', async (channelId, msg) => {
    await client.chat.postMessage({
      channel: channelId,
      text: msg,
    });
  });

  scheduler.registerAgentRunner('slack', async (prompt, channelId) => {
    const initialText = '🤔 考え中...';
    const thinking = await client.chat.postMessage({
      channel: channelId,
      text: initialText,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: initialText } },
        ...createSlackProcessingBlocks(),
      ],
    });
    const messageTs = thinking.ts;
    if (!messageTs) {
      throw new Error('Failed to get Slack message timestamp');
    }

    slackProcessingMessages.set(channelId, {
      channelId,
      messageTs,
      currentText: initialText,
      startedAt: Date.now(),
    });

    try {
      const freshAppSessionId = createSchedulerRunId('slack');
      const { result, attachments } = await runWithBubbleEvents(
        agentRunner,
        prompt,
        {
          threadId: `slack-schedule:${channelId}`,
          turnId: turnIdFor('slack', `sched-${freshAppSessionId}`),
          threadLabel: 'scheduled task',
          platform: 'slack',
          userText: prompt,
        },
        {},
        {
          skipPermissions: config.agent.config.skipPermissions ?? false,
          sessionId: undefined,
          channelId,
          appSessionId: freshAppSessionId,
        }
      );

      const { displayText } = buildAttachmentResult(result, attachments);
      await sendSlackResult(
        client,
        channelId,
        messageTs,
        undefined,
        markdownToSlackMrkdwn(displayText || '✅'),
        []
      );
      return result;
    } catch (error) {
      await client.chat
        .update({
          channel: channelId,
          ts: messageTs,
          text: formatAgentErrorForUser(error),
          blocks: [],
        })
        .catch(() => {});
      throw error;
    } finally {
      const entry = slackProcessingMessages.get(channelId);
      if (entry?.intervalId) clearInterval(entry.intervalId);
      slackProcessingMessages.delete(channelId);
    }
  });
}

export async function startSlackBot(options: SlackChannelOptions): Promise<void> {
  const { config, agentRunner, reloadSkills } = options;
  let { skills } = options;

  if (!config.slack.botToken || !config.slack.appToken) {
    throw new Error('Slack tokens not configured');
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // ボタンアクション: Stop
  app.action('xangi_stop', async ({ ack, body }) => {
    await ack();
    const channelId = body.channel?.id;
    if (!channelId) return;
    const runKey = slackRunKeyFromActionBody(body) ?? channelId;
    const userId = body.user?.id;
    if (
      !config.slack.allowedUsers?.includes('*') &&
      userId &&
      !config.slack.allowedUsers?.includes(userId)
    ) {
      return;
    }
    const stopped = processManager.stop(runKey) || agentRunner.cancel?.(runKey) || false;
    if (!stopped) {
      console.log(`[slack] No running task to stop for runKey ${runKey}`);
    }
  });

  // ボタンアクション: タイムアウト延長 (残り時間を 2 倍にする)
  app.action('xangi_extend', async ({ ack, body, client: actionClient }) => {
    await ack();
    const channelId = body.channel?.id;
    if (!channelId) return;
    const runKey = slackRunKeyFromActionBody(body) ?? channelId;
    const userId = body.user?.id;
    if (
      !config.slack.allowedUsers?.includes('*') &&
      userId &&
      !config.slack.allowedUsers?.includes(userId)
    ) {
      return;
    }
    // additionalMs を省略して runner 側の「残り時間 2 倍」デフォルト挙動を使う
    const result = agentRunner.extendTimeout?.(runKey) ?? {
      ok: false,
      reason: 'unsupported' as const,
    };
    if (!result.ok) {
      const text =
        result.reason === 'max_timeout_exceeded'
          ? '⏱ 上限に達したため延長できません'
          : result.reason === 'no_active_request'
            ? '⏱ 処理中のリクエストがありません'
            : '⏱ このバックエンドでは延長できません';
      await actionClient.chat
        .postEphemeral({ channel: channelId, user: userId || '', text })
        .catch(() => {});
    }
    // 成功時はメッセージ自体は timeout-extended イベント listener で update される
  });

  // 表示専用ボタン (残り時間バッジ): クリック無視
  app.action('xangi_timeout_display', async ({ ack }) => {
    await ack();
  });

  // ボタンアクション: ツール履歴を押した本人だけに表示
  app.action('xangi_tools', async ({ ack, body, client: actionClient }) => {
    await ack();
    const channelId = body.channel?.id;
    const userId = body.user?.id;
    if (!channelId || !userId) return;
    if (!config.slack.allowedUsers?.includes('*') && !config.slack.allowedUsers?.includes(userId)) {
      return;
    }
    const messageTs =
      'message' in body ? (body.message as { ts?: string } | undefined)?.ts : undefined;
    const toolHistory = messageTs
      ? slackToolHistoryByMessageKey.get(slackMessageKey(channelId, messageTs))
      : undefined;
    const text = formatToolHistoryDisclosure(toolHistory ?? []);
    const chunks = splitTextByBytes(text, SLACK_MAX_TEXT_BYTES);
    for (const chunk of chunks.length > 0 ? chunks : ['ツール履歴はありません']) {
      await actionClient.chat
        .postEphemeral({ channel: channelId, user: userId, text: chunk })
        .catch(() => {});
    }
  });

  app.action('xangi_reply_suggestions', async ({ ack, action, body, client: actionClient }) => {
    await ack();
    const channelId = body.channel?.id;
    const userId = body.user?.id;
    const message =
      'message' in body ? (body.message as { ts?: string; thread_ts?: string }) : undefined;
    if (!channelId || !userId || !message?.ts) return;
    if (!config.slack.allowedUsers?.includes('*') && !config.slack.allowedUsers?.includes(userId)) {
      return;
    }
    const messageKey = slackMessageKey(channelId, message.ts);
    const value = 'value' in action ? action.value : undefined;
    let embedded: { messageKey?: string; suggestions?: string[]; threadTs?: string } = {};
    try {
      embedded = JSON.parse(value || '{}') as {
        messageKey?: string;
        suggestions?: string[];
        threadTs?: string;
      };
    } catch {
      // 旧ボタンはプロセス内キャッシュへフォールバックする。
    }
    const embeddedSuggestions = Array.isArray(embedded.suggestions)
      ? embedded.suggestions.filter(
          (suggestion): suggestion is string => typeof suggestion === 'string'
        )
      : undefined;
    const suggestions =
      (embedded.messageKey === messageKey ? embeddedSuggestions : undefined) ??
      slackReplySuggestionsByMessageKey.get(messageKey);
    const threadTs = message.thread_ts ?? embedded.threadTs;
    if (!suggestions || suggestions.length === 0) {
      await actionClient.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'この返信候補は期限切れです',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }
    await actionClient.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: formatNumberedSuggestions(suggestions),
      blocks: createSlackReplySuggestionBlocks(messageKey, suggestions, threadTs),
      ...(threadTs && { thread_ts: threadTs }),
    });
  });

  app.action(
    /^xangi_reply_suggestion_\d+$/,
    async ({ ack, action, body, respond, client: actionClient }) => {
      await ack();
      const channelId = body.channel?.id;
      const userId = body.user?.id;
      if (!channelId || !userId) return;
      if (
        !config.slack.allowedUsers?.includes('*') &&
        !config.slack.allowedUsers?.includes(userId)
      ) {
        return;
      }
      const value = 'value' in action ? action.value : undefined;
      let parsed: { messageKey?: string; index?: number; threadTs?: string } = {};
      try {
        parsed = JSON.parse(value || '{}') as {
          messageKey?: string;
          index?: number;
          threadTs?: string;
        };
      } catch {
        // 下の期限切れ処理へ流す。
      }
      const suggestions = parsed.messageKey
        ? slackReplySuggestionsByMessageKey.get(parsed.messageKey)
        : undefined;
      const suggestion = Number.isInteger(parsed.index) ? suggestions?.[parsed.index!] : undefined;
      if (!suggestion) {
        await respond({ text: 'この返信候補は期限切れです', replace_original: true });
        return;
      }
      await respond({ text: `送信: ${suggestion}`, replace_original: true });
      const message =
        'message' in body ? (body.message as { thread_ts?: string; ts?: string }) : undefined;
      const threadTs = message?.thread_ts ?? parsed.threadTs;
      const conversationKey = slackConversationKey(channelId, threadTs);
      const selectedMessage = await actionClient.chat.postMessage({
        channel: channelId,
        text: `↪ ${suggestion}`,
        ...(threadTs && { thread_ts: threadTs }),
      });
      await processMessage(
        channelId,
        conversationKey,
        threadTs,
        suggestion,
        selectedMessage.ts ?? String(Date.now()),
        actionClient,
        agentRunner,
        config
      );
    }
  );

  // ボタンアクション: New Session
  app.action('xangi_new', async ({ ack, body, client: actionClient }) => {
    await ack();
    const channelId = body.channel?.id;
    if (!channelId) return;
    const runKey = slackRunKeyFromActionBody(body) ?? channelId;
    const userId = body.user?.id;
    if (
      !config.slack.allowedUsers?.includes('*') &&
      userId &&
      !config.slack.allowedUsers?.includes(userId)
    ) {
      return;
    }
    sessions.delete(runKey);
    agentRunner.destroy?.(runKey);
    // ボタンを消す
    if ('message' in body && body.message) {
      slackToolHistoryByMessageKey.delete(
        slackMessageKey(channelId, (body.message as { ts: string }).ts)
      );
      slackReplySuggestionsByMessageKey.delete(
        slackMessageKey(channelId, (body.message as { ts: string }).ts)
      );
      await actionClient.chat
        .update({
          channel: channelId,
          ts: (body.message as { ts: string }).ts,
          text: (body.message as { text?: string }).text || '✅',
          blocks: [],
        })
        .catch(() => {});
    }
  });

  // リアクションによる bot メッセージ削除
  app.event('reaction_added', async ({ event, client: eventClient }) => {
    const target = resolveSlackDeleteReactionTarget(config.slack, event);
    if (!target) return;
    const result = await deleteMessageByReaction(eventClient, target);
    await eventClient.chat
      .postEphemeral({
        channel: target.channelId,
        user: target.userId,
        text: result,
      })
      .catch(() => {});
  });

  // メンション時の処理
  app.event('app_mention', async ({ event, say, client }) => {
    const userId = event.user;
    if (!userId) return;

    // 許可リストチェック
    if (!config.slack.allowedUsers?.includes('*') && !config.slack.allowedUsers?.includes(userId)) {
      console.log(`[slack] Unauthorized user: ${userId}`);
      return;
    }

    let text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

    // 添付ファイルをダウンロード
    const attachmentPaths: string[] = [];
    const files = (event as unknown as Record<string, unknown>).files as
      Array<{ url_private_download?: string; name?: string }> | undefined;
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.url_private_download) {
          try {
            const filePath = await downloadFile(file.url_private_download, file.name || 'file', {
              Authorization: `Bearer ${config.slack.botToken}`,
            });
            attachmentPaths.push(filePath);
          } catch (err) {
            console.error(`[slack] Failed to download attachment: ${file.name}`, err);
          }
        }
      }
    }

    if (!text && attachmentPaths.length === 0) return;
    text = buildPromptWithAttachments(text || '添付ファイルを確認してください', attachmentPaths);

    const channelId = event.channel;
    const threadTs = shouldReplyInSlackThread(config.slack, channelId)
      ? event.thread_ts || event.ts
      : undefined;
    const conversationKey = slackConversationKey(channelId, threadTs);

    // セッションクリアコマンド
    if (['!new', 'new', '/new'].includes(text)) {
      sessions.delete(conversationKey);
      await say({
        text: '🆕 新しいセッションを開始しました',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 停止コマンド
    if (['!stop', 'stop', '/stop'].includes(text)) {
      const stopped =
        processManager.stop(conversationKey) || agentRunner.cancel?.(conversationKey) || false;
      await say({
        text: stopped ? '🛑 タスクを停止しました' : '実行中のタスクはありません',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 削除コマンド
    if (text === '!delete' || text === 'delete' || text.startsWith('!delete ')) {
      const arg = text.replace(/^!?delete\s*/, '').trim();
      const result = await deleteMessage(client, channelId, arg);
      await say({
        text: result,
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 👀 リアクション追加
    if (!markSlackMessageProcessed(channelId, event.ts)) {
      console.log(
        `[slack] Skipping duplicate app_mention event: channel=${channelId}, ts=${event.ts}`
      );
      return;
    }

    await client.reactions
      .add({
        channel: channelId,
        timestamp: event.ts,
        name: 'eyes',
      })
      .catch((err) => {
        console.error('[slack] Failed to add reaction:', err.message || err);
      });

    await processMessage(
      channelId,
      conversationKey,
      threadTs,
      text,
      event.ts,
      client,
      agentRunner,
      config
    );
  });

  // DMの処理 + autoReplyChannels
  app.event('message', async ({ event, say, client }) => {
    // ── Slack message_changed / message_deleted を transcript jsonl に反映 ──
    // bot 自身の chat.update 由来は subtype='message_changed' でも飛ばない
    // (Slack API 仕様)。ここに来るのはユーザが自分の投稿を編集 / 削除した時。
    const subtype = (event as { subtype?: string }).subtype;
    if (subtype === 'message_changed') {
      try {
        const channelId = (event as { channel: string }).channel;
        const inner = (
          event as { message?: { ts?: string; text?: string; user?: string; thread_ts?: string } }
        ).message;
        if (!inner?.ts || !channelId) return;
        const contextKey = slackConversationKey(channelId, inner.thread_ts);
        const appSessionId = getActiveSessionId(contextKey) || getActiveSessionId(channelId);
        if (!appSessionId) return;
        const workdir = config.agent.config.workdir || process.cwd();
        const entry = findEntryByPlatformMessageId(workdir, appSessionId, inner.ts);
        if (!entry) return;
        updateTranscriptContent(workdir, appSessionId, entry.id, inner.text ?? '');
        console.log(
          `[slack] Synced edit (${inner.ts}) → transcript ${entry.id} in session ${appSessionId}`
        );
      } catch (err) {
        console.warn('[slack] Failed to sync edit:', err);
      }
      return;
    }
    if (subtype === 'message_deleted') {
      try {
        const channelId = (event as { channel: string }).channel;
        const deletedTs = (event as { deleted_ts?: string }).deleted_ts;
        if (!deletedTs || !channelId) return;
        const contextKey = slackConversationKey(
          channelId,
          (event as { thread_ts?: string }).thread_ts
        );
        const appSessionId = getActiveSessionId(contextKey) || getActiveSessionId(channelId);
        if (!appSessionId) return;
        const workdir = config.agent.config.workdir || process.cwd();
        const entry = findEntryByPlatformMessageId(workdir, appSessionId, deletedTs);
        if (!entry) return;
        deleteTranscriptMessage(workdir, appSessionId, entry.id);
        console.log(
          `[slack] Synced delete (${deletedTs}) → transcript ${entry.id} in session ${appSessionId}`
        );
      } catch (err) {
        console.warn('[slack] Failed to sync delete:', err);
      }
      return;
    }

    // botのメッセージは無視
    if ('bot_id' in event || !('user' in event)) return;

    const messageEvent = event as {
      user: string;
      text?: string;
      channel: string;
      ts: string;
      thread_ts?: string;
      channel_type?: string;
      files?: Array<{ url_private_download?: string; name?: string }>;
    };

    console.log(
      `[slack] Message event: channel=${messageEvent.channel}, type=${messageEvent.channel_type}, autoReplyChannels=${config.slack.autoReplyChannels?.join(',')}`
    );

    // DM または autoReplyChannels を処理。
    // app_mention は別 handler で処理されるため、対象外チャンネルのスレッド返信は拾わない。
    const isDM = messageEvent.channel_type === 'im';
    const isAutoReplyChannel = config.slack.autoReplyChannels?.includes(messageEvent.channel);
    const isThreadReply = !!messageEvent.thread_ts;
    const textRaw = messageEvent.text || '';
    if (/<@[A-Z0-9]+>/i.test(textRaw)) {
      console.log(`[slack] Skipping bot mention in message event (handled by app_mention)`);
      return;
    }
    const contextKey = slackConversationKey(messageEvent.channel, messageEvent.thread_ts);
    const hasActiveThreadSession = isThreadReply && !!getActiveSessionId(contextKey);
    if (
      !shouldProcessSlackMessage(config.slack, {
        channel: messageEvent.channel,
        channelType: messageEvent.channel_type,
        threadTs: messageEvent.thread_ts,
        subtype,
        hasActiveThreadSession,
      })
    ) {
      console.log(
        `[slack] Skipping: isDM=${isDM}, isAutoReplyChannel=${isAutoReplyChannel}, isThread=${isThreadReply}, hasActiveThreadSession=${hasActiveThreadSession}, subtype=${subtype ?? 'none'}`
      );
      return;
    }

    if (!markSlackMessageProcessed(messageEvent.channel, messageEvent.ts)) {
      console.log(
        `[slack] Skipping duplicate message event: channel=${messageEvent.channel}, ts=${messageEvent.ts}`
      );
      return;
    }

    // 許可リストチェック
    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(messageEvent.user)
    ) {
      console.log(`[slack] Unauthorized user: ${messageEvent.user}`);
      return;
    }

    let text = messageEvent.text || '';

    // 添付ファイルをダウンロード
    const dmAttachmentPaths: string[] = [];
    if (messageEvent.files && messageEvent.files.length > 0) {
      for (const file of messageEvent.files) {
        if (file.url_private_download) {
          try {
            const filePath = await downloadFile(file.url_private_download, file.name || 'file', {
              Authorization: `Bearer ${config.slack.botToken}`,
            });
            dmAttachmentPaths.push(filePath);
          } catch (err) {
            console.error(`[slack] Failed to download attachment: ${file.name}`, err);
          }
        }
      }
    }

    if (!text && dmAttachmentPaths.length === 0) return;
    text = buildPromptWithAttachments(text || '添付ファイルを確認してください', dmAttachmentPaths);

    const channelId = messageEvent.channel;
    const threadTs = shouldReplyInSlackThread(config.slack, channelId)
      ? messageEvent.thread_ts || messageEvent.ts
      : undefined;
    const conversationKey = slackConversationKey(channelId, threadTs);

    // セッションクリアコマンド
    if (['!new', 'new', '/new'].includes(text)) {
      sessions.delete(conversationKey);
      await say({
        text: '🆕 新しいセッションを開始しました',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 停止コマンド
    if (['!stop', 'stop', '/stop'].includes(text)) {
      const stopped =
        processManager.stop(conversationKey) || agentRunner.cancel?.(conversationKey) || false;
      await say({
        text: stopped ? '🛑 タスクを停止しました' : '実行中のタスクはありません',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 削除コマンド
    if (text === '!delete' || text === 'delete' || text.startsWith('!delete ')) {
      const arg = text.replace(/^!?delete\s*/, '').trim();
      const result = await deleteMessage(client, channelId, arg);
      await say({
        text: result,
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 👀 リアクション追加
    await client.reactions
      .add({
        channel: channelId,
        timestamp: messageEvent.ts,
        name: 'eyes',
      })
      .catch((err) => {
        console.error('[slack] Failed to add reaction:', err.message || err);
      });

    await processMessage(
      channelId,
      conversationKey,
      threadTs,
      text,
      messageEvent.ts,
      client,
      agentRunner,
      config
    );
  });

  // /new コマンド
  app.command('/new', async ({ command, ack, respond }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    sessions.delete(command.channel_id);
    await respond({ text: '🆕 新しいセッションを開始しました' });
  });

  // /skills コマンド
  app.command('/skills', async ({ command, ack, respond }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    skills = reloadSkills();
    await respond({ text: formatSkillList(skills) });
  });

  // /delete コマンド（Botメッセージを削除）
  // /delete → 直前のメッセージ
  // /delete <ts> → 指定のメッセージ（tsまたはメッセージリンクから抽出）
  app.command('/delete', async ({ command, ack, respond, client }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    const result = await deleteMessage(client, command.channel_id, command.text.trim());
    await respond({ text: result, response_type: 'ephemeral' });
  });

  // /skill コマンド
  app.command('/skill', async ({ command, ack, respond }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    const args = command.text.trim().split(/\s+/);
    const skillName = args[0];
    const skillArgs = args.slice(1).join(' ');

    if (!skillName) {
      await respond({ text: '使い方: `/skill <スキル名> [引数]`' });
      return;
    }

    const channelId = command.channel_id;
    const skipPermissions = config.agent.config.skipPermissions ?? false;

    try {
      const prompt = `スキル「${skillName}」を実行してください。${skillArgs ? `引数: ${skillArgs}` : ''}`;
      const sessionId = sessions.get(channelId);
      const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
        skipPermissions,
        sessionId,
        channelId,
      });

      sessions.set(channelId, newSessionId);
      await respond({ text: sliceByBytes(result, SLACK_MAX_TEXT_BYTES) });
    } catch (error) {
      console.error('[slack] Error:', error);
      await respond({ text: 'エラーが発生しました' });
    }
  });

  // /settings コマンド
  app.command('/settings', async ({ command, ack, respond }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    const settings = loadSettings();
    await respond({ text: formatSettings(settings) });
  });

  // /restart コマンド
  app.command('/restart', async ({ command, ack, respond }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    const selfLifecycle = getSelfLifecyclePermission();
    if (!canSelfRestart(selfLifecycle)) {
      await respond({
        text: '⚠️ 自己再起動が無効です。管理者が `.env` の `XANGI_SELF_LIFECYCLE=restart-only` を設定し、xangi を再起動してください。',
      });
      return;
    }
    await respond({ text: '🔄 再起動します...' });
    setTimeout(() => process.exit(0), 1000);
  });

  await app.start();
  console.log('[slack] ⚡️ Slack bot is running!');

  // runner の timeout-* イベントを Slack メッセージ更新に紐付け
  const getSlackTimeoutInfo = (
    runKey: string
  ): { remainingMs: number; canExtend: boolean; extendEnabled: boolean } | undefined => {
    return getSlackTimeoutInfoFor(agentRunner, runKey);
  };

  const refreshSlackProcessingBlocks = async (runKey: string): Promise<void> => {
    const entry = slackProcessingMessages.get(runKey);
    if (!entry) return;
    const info = getSlackTimeoutInfo(runKey);
    if (!info) return;
    try {
      await app.client.chat.update({
        channel: entry.channelId,
        ts: entry.messageTs,
        text: entry.currentText,
        blocks: [
          {
            type: 'section' as const,
            text: { type: 'mrkdwn' as const, text: entry.currentText },
          },
          ...createSlackProcessingBlocks(info),
        ],
      });
    } catch (e: unknown) {
      console.warn(
        '[slack] Failed to refresh processing blocks:',
        e instanceof Error ? e.message : String(e)
      );
    }
  };

  const runnerEmitter = agentRunner as unknown as {
    on?: (e: string, l: (p: unknown) => void) => void;
  };
  if (typeof runnerEmitter.on === 'function') {
    runnerEmitter.on('timeout-started', (payload: unknown) => {
      const p = payload as { channelId?: string };
      if (!p.channelId) return;
      const entry = slackProcessingMessages.get(p.channelId);
      if (!entry) return; // Slack 経由でなければ無視
      void refreshSlackProcessingBlocks(p.channelId);
      // 10 秒ごとに残り時間を chat.update。
      // Slack API レート (Tier 3 ≈ 50/min) を考慮、複数チャンネル並列起動時にも
      // 余裕を持たせるため。thinking/stream interval も毎秒 update するが
      // そちらは getSlackTimeoutInfoFor 経由で最新の timeout 情報を載せている。
      if (entry.intervalId) clearInterval(entry.intervalId);
      entry.intervalId = setInterval(() => {
        const info = getSlackTimeoutInfo(p.channelId!);
        if (!info) {
          if (entry.intervalId) clearInterval(entry.intervalId);
          return;
        }
        void refreshSlackProcessingBlocks(p.channelId!);
      }, 10_000);
    });
    runnerEmitter.on('timeout-extended', (payload: unknown) => {
      const p = payload as { channelId?: string };
      if (!p.channelId) return;
      void refreshSlackProcessingBlocks(p.channelId);
    });
    runnerEmitter.on('timeout-cleared', (payload: unknown) => {
      const p = payload as { channelId?: string };
      if (!p.channelId) return;
      const entry = slackProcessingMessages.get(p.channelId);
      if (!entry) return;
      if (entry.intervalId) clearInterval(entry.intervalId);
      slackProcessingMessages.delete(p.channelId);
    });
  }

  if (options.scheduler) {
    registerSlackSchedulerBridge({
      scheduler: options.scheduler,
      client: app.client,
      config,
      agentRunner,
    });
  }
}

export async function processMessage(
  channelId: string,
  conversationKey: string,
  threadTs: string | undefined,
  text: string,
  originalTs: string,
  client: WebClient,
  agentRunner: AgentRunner,
  config: Config
): Promise<void> {
  const runKey = conversationKey;
  const skipPermissions = config.agent.config.skipPermissions ?? false;
  const startedAt = Date.now();
  let prompt = text;

  // スキップ設定
  if (prompt.startsWith('!skip')) {
    prompt = prompt.replace(/^!skip\s*/, '').trim();
  }

  // プラットフォーム情報をプロンプトに注入
  prompt = `[プラットフォーム: Slack]\n[チャンネル: ${channelId}]${threadTs ? `\n[スレッド: ${threadTs}]` : ''}\n${prompt}`;

  // xangi-events 用 ID とラベル（fire-and-forget）
  const threadId = threadIdFor('slack', conversationKey);
  const turnId = turnIdFor('slack', originalTs);
  // チャンネル名は conversations.info で取得 (失敗時は undefined)
  let threadLabel: string | undefined;
  try {
    const info = await client.conversations.info({ channel: channelId });
    if (info.channel) {
      const ch = info.channel as { name?: string; is_im?: boolean };
      threadLabel = ch.is_im ? 'Slack DM' : ch.name ? `#${ch.name}` : undefined;
    }
  } catch {
    // 取得失敗時はラベルなしで続行
  }
  const eventCtx = {
    threadId,
    turnId,
    threadLabel,
    platform: 'slack' as const,
    userText: text,
  };

  let messageTs = '';
  // プロセス終了時に実行中表示を「中断」表示で確定させる finalizer の登録解除関数 (issue #293)
  let unregisterStreamFinalizer: (() => void) | undefined;
  // appSessionId は xangi 内部 (sessions.json) のセッション ID。
  // transcript-logger / 編集・削除同期で必要。
  const appSessionId = ensureSession(conversationKey, { platform: 'slack' });
  const tWorkdir = config.agent.config.workdir || process.cwd();
  try {
    if (busySlackConversations.has(runKey)) {
      console.log(`[slack] Skipping busy conversation: runKey=${runKey}`);
      return;
    }
    busySlackConversations.add(runKey);
    console.log(`[slack] Processing message: channel=${channelId}, runKey=${runKey}`);

    const sessionId = getProviderSessionId(conversationKey) ?? sessions.get(conversationKey);
    if (!sessionId && config.historyPrefetch?.enabled) {
      const prefetchedHistory = await prefetchSlackHistory(
        client,
        channelId,
        threadTs,
        originalTs,
        config.historyPrefetch.count
      );
      prompt = `${prefetchedHistory}\n\n${prompt}`;
    }
    const useStreaming = config.slack.streaming ?? true;
    const showThinking = config.slack.showThinking ?? true;

    const showButtons = config.slack.showThinking ?? true;
    const replySuggestionCount = config.slack.replySuggestionCount ?? 3;
    const replySuggestionsEnabled = loadReplySuggestionsEnabled(
      config.slack.replySuggestions !== false
    );
    if (replySuggestionsEnabled) {
      prompt = appendReplySuggestionInstruction(prompt, replySuggestionCount);
    }
    const toolHistory: string[] = [];
    const captureCallbacks = {
      onToolUse: (toolName: string, toolInput: Record<string, unknown>) => {
        addToolHistory(toolHistory, toolName, toolInput);
      },
    };

    // ストリーミング表示のプラットフォーム非依存コア (stream-session.ts)。
    // Slack 固有の描画 (chat.update / blocks / バイト制限での切り詰め) はこの render に集約する
    const session = new StreamSession({
      formatToolLine: (toolName, toolInput) => {
        const lines: string[] = [];
        addToolHistory(lines, toolName, toolInput);
        return lines[0] ?? null;
      },
      render: async (view) => {
        if (!messageTs) return;
        const text =
          view.phase === 'thinking'
            ? `${view.toolLines.length > 0 ? `${view.toolLines.join('\n')}\n\n` : ''}${view.statusLine}`
            : sliceByBytes(
                appendToolHistory(stripReplySuggestionMarkup(view.text), view.toolLines, ' ▌'),
                SLACK_MAX_TEXT_BYTES
              );
        // 1 秒ごとの chat.update でタイムアウト UI を消さないよう、
        // 最新の timeout 状態を渡して blocks を再生成する
        const timeoutInfo = getSlackTimeoutInfoFor(agentRunner, runKey);
        await client.chat
          .update({
            channel: channelId,
            ts: messageTs,
            text,
            ...(showButtons && {
              blocks: [
                { type: 'section' as const, text: { type: 'mrkdwn' as const, text } },
                ...createSlackProcessingBlocks(timeoutInfo),
              ],
            }),
          })
          .catch((err) => {
            console.error('[slack] Failed to update message:', err?.message);
          });
      },
    });

    // 最初のメッセージを送信（Stopボタン付き）
    const initialText = session.view().statusLine;
    const initialResponse = await client.chat.postMessage({
      channel: channelId,
      text: initialText,
      ...(threadTs && { thread_ts: threadTs }),
      ...(showButtons && {
        blocks: [
          { type: 'section' as const, text: { type: 'mrkdwn' as const, text: initialText } },
          ...createSlackProcessingBlocks(),
        ],
      }),
    });

    messageTs = initialResponse.ts ?? '';
    if (!messageTs) {
      throw new Error('Failed to get message timestamp');
    }

    // 最後のBotメッセージを保存
    lastBotMessages.set(channelId, messageTs);

    // タイムアウト UI の自動更新対象として登録 (runner.timeout-* で update される)
    if (showButtons) {
      slackProcessingMessages.set(runKey, {
        channelId,
        messageTs,
        threadTs,
        currentText: initialText,
        startedAt: Date.now(),
      });
    }

    // プロセス再起動 (SIGTERM) で turn が中断されたとき、ストリーミング表示
    // (スピナー / 本文 + ▌) を放置せず「中断」表示で確定させる (issue #293)
    unregisterStreamFinalizer = registerStreamFinalizer(async () => {
      session.finish();
      if (!messageTs) return;
      const note = '⏸ プロセス再起動により中断されました';
      const lastText = stripReplySuggestionMarkup(session.lastText);
      const text = lastText ? `${lastText.trimEnd()}\n\n${note}` : note;
      await client.chat
        .update({ channel: channelId, ts: messageTs, text, blocks: [] })
        .catch(() => {});
    });

    let result: string;
    let newSessionId: string;
    let structuredAttachments: string[] | undefined;

    if (useStreaming && showThinking) {
      // ストリーミング + 思考表示モード
      session.start();
      let streamResult: RunResult;
      try {
        streamResult = await runWithBubbleEvents(
          agentRunner,
          prompt,
          eventCtx,
          session.callbacks(captureCallbacks),
          { skipPermissions, sessionId, channelId: runKey, appSessionId }
        );
      } finally {
        session.finish();
      }
      result = streamResult.result;
      newSessionId = streamResult.sessionId;
      structuredAttachments = streamResult.attachments;
    } else {
      // 非ストリーミング or 思考非表示モード
      // useStreaming=false の意図（本文の逐次表示をしない）を保つため
      // callbacks は渡さず、思考中アニメーションだけ更新する
      session.start();
      const sessionCallbacks = session.callbacks(captureCallbacks);
      try {
        const runResult = await runWithBubbleEvents(
          agentRunner,
          prompt,
          eventCtx,
          { onToolUse: sessionCallbacks.onToolUse },
          { skipPermissions, sessionId, channelId: runKey, appSessionId }
        );
        result = runResult.result;
        newSessionId = runResult.sessionId;
        structuredAttachments = runResult.attachments;
      } finally {
        session.finish();
      }
    }

    sessions.set(conversationKey, newSessionId);
    // transcript の最後の user / assistant エントリに Slack の messageTs を
    // 紐付ける (PR ③、Discord と同じ post-hoc attach 戦略)。
    try {
      attachPlatformMessageIdToLast(tWorkdir, appSessionId, 'user', originalTs);
      if (messageTs) {
        attachPlatformMessageIdToLast(tWorkdir, appSessionId, 'assistant', messageTs);
      }
    } catch (err) {
      console.warn('[slack] Failed to attach platform message ids:', err);
    }
    console.log(`[slack] Final result length: ${result.length}`);

    // ファイルパスを抽出して添付送信（テキスト由来 + 構造化 attachments を合算・重複排除）
    const extracted = sanitizeReplySuggestionOutput(
      result,
      replySuggestionsEnabled,
      replySuggestionCount
    );
    if (replySuggestionsEnabled && extracted.suggestions.length === 0) {
      extracted.suggestions = fallbackReplySuggestions(replySuggestionCount);
    }
    const { filePaths, displayText } = buildAttachmentResult(extracted.text, structuredAttachments);
    // finalテキストを mrkdwn へ一度だけ変換し、以降の全描画（本文更新・ボタン付与）で共有する
    const renderedText = markdownToSlackMrkdwn(displayText || '✅');
    const showToolsButton = toolHistory.length > 0;
    if (showToolsButton) {
      slackToolHistoryByMessageKey.set(slackMessageKey(channelId, messageTs), [...toolHistory]);
    }
    if (extracted.suggestions.length > 0) {
      slackReplySuggestionsByMessageKey.set(
        slackMessageKey(channelId, messageTs),
        extracted.suggestions
      );
    }

    // 最終結果を更新（長い場合は分割送信）
    await sendSlackResult(client, channelId, messageTs, threadTs, renderedText);

    // 完了後: StopボタンをNewボタンに切り替え
    // ただしタイムアウト UI ([+5m][⏱ MM:SS]) が表示された直後だと一瞬で
    // 上書きされて視認できない。最低 2.5 秒は表示を残してから完了表示に切り替える。
    if (showButtons) {
      const entry = slackProcessingMessages.get(runKey);
      const MIN_TIMEOUT_DISPLAY_MS = 2500;
      if (entry?.startedAt) {
        const elapsed = Date.now() - entry.startedAt;
        const wait = Math.max(0, MIN_TIMEOUT_DISPLAY_MS - elapsed);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      await client.chat
        .update({
          channel: channelId,
          ts: messageTs,
          text: sliceByBytes(renderedText, SLACK_MAX_TEXT_BYTES),
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: sliceByBytes(renderedText, SLACK_MAX_TEXT_BYTES),
              },
            },
            ...createSlackCompletedBlocks({
              showTools: showToolsButton,
              showReplySuggestions: extracted.suggestions.length > 0,
              replySuggestionPayload: {
                messageKey: slackMessageKey(channelId, messageTs),
                suggestions: extracted.suggestions,
                threadTs,
              },
            }),
          ],
        })
        .catch(() => {});
    }

    if (filePaths.length > 0) {
      try {
        for (const fp of filePaths) {
          const fileContent = await import('fs').then((fs) => fs.default.readFileSync(fp));
          const filename = await import('path').then((path) => path.default.basename(fp));
          const uploadArgs: Record<string, unknown> = {
            channel_id: channelId,
            file: fileContent,
            filename,
          };
          if (threadTs) {
            uploadArgs.thread_ts = threadTs;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await client.filesUploadV2(uploadArgs as any);
        }
        console.log(`[slack] Sent ${filePaths.length} file(s)`);
      } catch (err) {
        console.error('[slack] Failed to upload files:', err);
      }
    }

    const completionNotification = buildSlackCompletionNotification({
      threadTs,
      elapsedMs: Date.now() - startedAt,
      thresholdMs: config.slack.completionNotifyAfterMs ?? 10_000,
    });
    if (completionNotification) {
      await client.chat
        .postMessage({
          channel: channelId,
          text: completionNotification,
        })
        .catch((err) => {
          console.error('[slack] Failed to send completion notification:', err?.message || err);
        });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('Request cancelled by user')) {
      console.log('[slack] Request cancelled by user');
      if (messageTs) {
        await client.chat
          .update({
            channel: channelId,
            ts: messageTs,
            text: '🛑 停止しました',
            blocks: [],
          })
          .catch(() => {});
      }
    } else {
      console.error('[slack] Error:', error);
      await client.chat.postMessage({
        channel: channelId,
        text: formatAgentErrorForUser(error),
        ...(threadTs && { thread_ts: threadTs }),
      });
    }
  } finally {
    busySlackConversations.delete(runKey);
    // 正常完了・エラー処理後は shutdown finalizer の対象から外す
    unregisterStreamFinalizer?.();
    // 👀 リアクションを削除
    await client.reactions
      .remove({
        channel: channelId,
        timestamp: originalTs,
        name: 'eyes',
      })
      .catch((err) => {
        console.error('[slack] Failed to remove reaction:', err.message || err);
      });
  }
}

export function _resetSlackStateForTest(): void {
  sessions.clear();
  lastBotMessages.clear();
  for (const entry of slackProcessingMessages.values()) {
    if (entry.intervalId) clearInterval(entry.intervalId);
  }
  slackProcessingMessages.clear();
  slackToolHistoryByMessageKey.clear();
  slackReplySuggestionsByMessageKey.clear();
  busySlackConversations.clear();
  processedSlackMessages.clear();
}
