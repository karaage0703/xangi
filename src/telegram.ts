import { Bot, webhookCallback, type Context } from 'grammy';
import { Agent as HttpsAgent } from 'node:https';
import type { Config } from './config.js';
import type { AgentRunner } from './agent-runner.js';
import type { Scheduler } from './scheduler.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import { StreamSession, type StreamView } from './stream-session.js';
import {
  ensureSession,
  archiveSession,
  getActiveSessionId,
  getSessionEntry,
  hasSessionGoneIdle,
  getProviderSessionId,
} from './sessions.js';
import { threadIdFor, turnIdFor } from './events-emitter.js';
import { splitMessage } from './message-split.js';
import { formatAgentErrorForUser } from './errors.js';
import { registerStreamFinalizer } from './stream-finalizer.js';
import { buildAttachmentResult, buildPromptWithAttachments } from './file-utils.js';
import {
  DEFAULT_TELEGRAM_MEDIA_MIME_TYPES,
  TelegramMediaError,
  TelegramMediaGroupBuffer,
  cleanupTelegramMedia,
  discardTelegramMediaFiles,
  downloadTelegramMedia,
  extractTelegramMedia,
  sendTelegramAttachments,
  type TelegramAttachmentSendResult,
  type TelegramMediaCandidate,
} from './telegram-media.js';

const TELEGRAM_RETRY_BASE_MS = 1_000;
const TELEGRAM_RETRY_MAX_MS = 60_000;
const TELEGRAM_POLLING_STABLE_MS = 35_000;
const RETRYABLE_TELEGRAM_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

type ErrorRecord = Record<string, unknown>;

function asErrorRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as ErrorRecord) : undefined;
}

function telegramErrorChain(error: unknown): ErrorRecord[] {
  const records: ErrorRecord[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && records.length < 6 && !seen.has(current)) {
    seen.add(current);
    const record = asErrorRecord(current);
    if (!record) break;
    records.push(record);
    current = record.error ?? record.cause;
  }

  return records;
}

function telegramErrorCode(error: unknown): string | undefined {
  for (const record of telegramErrorChain(error)) {
    const code = record.code ?? record.errno;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function telegramErrorStatus(error: unknown): number | undefined {
  for (const record of telegramErrorChain(error)) {
    const status = record.error_code ?? record.statusCode ?? record.status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

export function redactTelegramSecrets(text: string): string {
  return text
    .replace(
      /https:\/\/api\.telegram\.org\/bot[^/\s"'?)]+/gi,
      'https://api.telegram.org/bot<redacted>'
    )
    .replace(/\b\d{6,15}:[A-Za-z0-9_-]{20,}\b/g, '<telegram-bot-token>');
}

export function formatTelegramError(error: unknown): string {
  const messages: string[] = [];
  for (const record of telegramErrorChain(error)) {
    if (typeof record.message === 'string' && !messages.includes(record.message)) {
      messages.push(record.message);
    }
  }

  if (messages.length === 0) {
    messages.push(error instanceof Error ? error.message : String(error));
  }

  const code = telegramErrorCode(error);
  const status = telegramErrorStatus(error);
  const metadata = [code ? `code=${code}` : '', status ? `status=${status}` : '']
    .filter(Boolean)
    .join(', ');
  const summary = `${messages.slice(0, 3).join(': ')}${metadata ? ` (${metadata})` : ''}`;
  return redactTelegramSecrets(summary);
}

export function isRetryableTelegramError(error: unknown): boolean {
  const status = telegramErrorStatus(error);
  if (status !== undefined) {
    if (status === 408 || status === 429 || status >= 500) return true;
    if (status >= 400 && status < 500) return false;
  }

  const code = telegramErrorCode(error);
  if (code?.startsWith('CERT_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return false;
  if (code && RETRYABLE_TELEGRAM_CODES.has(code)) return true;

  return /network request|fetch failed|socket hang up|timed?\s*out|temporar(?:y|ily)/i.test(
    formatTelegramError(error)
  );
}

export function getTelegramRetryDelayMs(attempt: number, random = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 16));
  const capped = Math.min(TELEGRAM_RETRY_MAX_MS, TELEGRAM_RETRY_BASE_MS * 2 ** exponent);
  return Math.round(capped * (0.75 + Math.max(0, Math.min(1, random())) * 0.25));
}

export async function retryTelegramOperation<T>(
  operationName: string,
  operation: () => Promise<T>,
  options: {
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {}
): Promise<T> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let failures = 0;

  for (;;) {
    try {
      const result = await operation();
      if (failures > 0) {
        console.info(`[xangi-telegram] ${operationName} connection restored`);
      }
      return result;
    } catch (error) {
      if (!isRetryableTelegramError(error)) throw error;

      failures++;
      const delayMs = getTelegramRetryDelayMs(failures, options.random);
      if (failures === 1 || failures % 10 === 0) {
        console.warn(
          `[xangi-telegram] ${operationName} unavailable: ${formatTelegramError(error)}. ` +
            `Retrying in ${Math.ceil(delayMs / 1000)}s`
        );
      }
      await sleep(delayMs);
    }
  }
}

function isTelegramMessageNotModified(error: unknown): boolean {
  return (
    telegramErrorStatus(error) === 400 &&
    /message is not modified/i.test(formatTelegramError(error))
  );
}

export async function retryTelegramEdit(
  operation: () => Promise<unknown>,
  options: {
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {}
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await operation();
      return { ok: true };
    } catch (error) {
      // The previous edit may have reached Telegram even when the client timed out.
      // Retrying the same message ID is idempotent; this response confirms delivery.
      if (isTelegramMessageNotModified(error)) return { ok: true };
      if (!isRetryableTelegramError(error) || attempt === maxAttempts) {
        return { ok: false, error };
      }
      await sleep(getTelegramRetryDelayMs(attempt, options.random));
    }
  }

  return { ok: false, error: new Error('Telegram edit retry exhausted') };
}

async function superviseTelegramPolling(bot: Bot): Promise<void> {
  let failures = 0;

  for (;;) {
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await bot.start({
        onStart: () => {
          console.log(
            failures > 0
              ? '[xangi-telegram] Long polling restart initiated'
              : '[xangi-telegram] Long polling started'
          );
          stableTimer = setTimeout(() => {
            if (!bot.isRunning()) return;
            if (failures > 0) {
              console.info('[xangi-telegram] Polling connection restored');
            }
            failures = 0;
          }, TELEGRAM_POLLING_STABLE_MS);
        },
      });
      if (stableTimer) clearTimeout(stableTimer);
      return;
    } catch (error) {
      if (stableTimer) clearTimeout(stableTimer);
      if (telegramErrorStatus(error) === 409) {
        console.error(
          '[xangi-telegram] Polling stopped: another process is using this bot token. ' +
            'Run only one polling instance (PM2 instances=1) and restart xangi.'
        );
        return;
      }
      if (!isRetryableTelegramError(error)) {
        console.error(
          `[xangi-telegram] Polling stopped permanently: ${formatTelegramError(error)}`
        );
        return;
      }

      failures++;
      const delayMs = getTelegramRetryDelayMs(failures);
      if (failures === 1 || failures % 10 === 0) {
        console.warn(
          `[xangi-telegram] Polling connection lost: ${formatTelegramError(error)}. ` +
            `Retrying in ${Math.ceil(delayMs / 1000)}s`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// メッセージIDの重複処理防止用
const processedMessageIds = new Set<string>();

// Chat ID 確認用ログを同じグループで繰り返さないための記録
const loggedGroupChatIds = new Set<string>();

const BOT_LOOP_WINDOW_MS = 5 * 60 * 1000;

export class TelegramBotLoopGuard {
  private readonly counters = new Map<string, { count: number; lastAcceptedAt: number }>();

  constructor(private readonly windowMs = BOT_LOOP_WINDOW_MS) {}

  resetChat(chatId: string): void {
    for (const key of this.counters.keys()) {
      if (key.startsWith(`${chatId}:`)) this.counters.delete(key);
    }
  }

  allow(chatId: string, botId: string, maxConsecutive: number, now = Date.now()): boolean {
    if (maxConsecutive <= 0) return false;

    const key = `${chatId}:${botId}`;
    const current = this.counters.get(key);
    if (!current || now - current.lastAcceptedAt >= this.windowMs) {
      this.counters.set(key, { count: 1, lastAcceptedAt: now });
      return true;
    }

    if (current.count >= maxConsecutive) return false;

    this.counters.set(key, {
      count: current.count + 1,
      lastAcceptedAt: now,
    });
    return true;
  }
}

const botLoopGuard = new TelegramBotLoopGuard();

export class TelegramChatQueue {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();

  getGeneration(contextKey: string): number {
    return this.generations.get(contextKey) ?? 0;
  }

  nextGeneration(contextKey: string): void {
    this.generations.set(contextKey, this.getGeneration(contextKey) + 1);
  }

  enqueue<T = void>(contextKey: string, task: () => Promise<T>): Promise<T> {
    let outerResolve!: (value: T) => void;
    let outerReject!: (err: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      outerResolve = res;
      outerReject = rej;
    });

    const prev = this.queues.get(contextKey) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        outerResolve(await task());
      } catch (err) {
        outerReject(err);
      }
    });
    this.queues.set(contextKey, next);
    next.then(() => {
      if (this.queues.get(contextKey) === next) this.queues.delete(contextKey);
    });

    return result;
  }
}

// /stop・/new 等のコマンドはキューを経由せず、generationだけを進める。
const telegramChatQueue = new TelegramChatQueue();

function getGeneration(contextKey: string): number {
  return telegramChatQueue.getGeneration(contextKey);
}

function nextGeneration(contextKey: string): void {
  telegramChatQueue.nextGeneration(contextKey);
}

function resetTelegramSession(
  contextKey: string,
  activeSessionId: string | undefined,
  agentRunner: AgentRunner
): void {
  if (activeSessionId) archiveSession(activeSessionId);
  agentRunner.cancel?.(contextKey);
  agentRunner.destroy?.(contextKey);
  nextGeneration(contextKey);
}

function enqueueForChat<T = void>(contextKey: string, task: () => Promise<T>): Promise<T> {
  return telegramChatQueue.enqueue(contextKey, task);
}

/**
 * UTF-16 長が maxUtf16 を超えないよう安全にトランケートする。
 * high surrogate (0xD800-0xDBFF) の直後で切らないようにする。
 */
function truncateSafe(str: string, maxUtf16: number): string {
  if (str.length <= maxUtf16) return str;
  let end = maxUtf16;
  if ((str.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
  return str.slice(0, end);
}

function telegramAttachmentFailureNotice(failed: number, total: number): string {
  return (
    `⚠️ 添付ファイル ${failed}/${total} 件の送信結果を確認できませんでした。` +
    '二重送信を避けるため、自動再送はしていません。'
  );
}

export function telegramMediaDownloadFailureNotice(
  total: number,
  succeeded: number,
  errors: readonly string[]
): string {
  const failed = Math.max(0, total - succeeded);
  const action =
    succeeded > 0
      ? `取得できた ${succeeded} 件のみで処理を続けます。`
      : '処理できる添付ファイルがないため、このメッセージの処理を中止します。';
  const reasons = [...new Set(errors)].map((error) => `・${error}`);
  return [`⚠️ 添付ファイル ${total} 件中 ${failed} 件を取得できませんでした。${action}`, ...reasons]
    .filter(Boolean)
    .join('\n');
}

export function telegramMediaDownloadContext(
  total: number,
  succeeded: number,
  errors: readonly string[]
): string {
  const failed = Math.max(0, total - succeeded);
  const reasons = [...new Set(errors)].join(' / ');
  return (
    `[Telegram添付処理: ${total}件中${succeeded}件を取得、${failed}件が失敗しました。` +
    `取得できた添付だけを対象に回答してください。${reasons ? ` 失敗理由: ${reasons}` : ''}]`
  );
}

export async function downloadTelegramMediaBatch(
  candidates: readonly TelegramMediaCandidate[],
  download: (candidate: TelegramMediaCandidate) => Promise<string>,
  isGenerationCurrent: () => boolean
): Promise<{ attachmentPaths: string[]; mediaErrors: string[]; stale: boolean }> {
  const attachmentPaths: string[] = [];
  const mediaErrors: string[] = [];

  for (const candidate of candidates) {
    if (!isGenerationCurrent()) {
      discardTelegramMediaFiles(attachmentPaths);
      return { attachmentPaths: [], mediaErrors, stale: true };
    }
    try {
      attachmentPaths.push(await download(candidate));
    } catch (error) {
      const userMessage =
        error instanceof TelegramMediaError
          ? error.userMessage
          : 'Telegramからファイルを取得できませんでした。';
      mediaErrors.push(userMessage);
      console.warn(
        `[xangi-telegram] Media download rejected or failed: ${formatTelegramError(error)}`
      );
    }
    if (!isGenerationCurrent()) {
      discardTelegramMediaFiles(attachmentPaths);
      return { attachmentPaths: [], mediaErrors, stale: true };
    }
  }

  return { attachmentPaths, mediaErrors, stale: false };
}

function appendTelegramNotice(text: string, notice: string, maxUtf16 = 4096): string {
  const suffix = `\n\n${notice}`;
  return `${truncateSafe(text, Math.max(0, maxUtf16 - suffix.length))}${suffix}`;
}

function logTelegramAttachmentFailures(scope: string, result: TelegramAttachmentSendResult): void {
  for (const failure of result.failures) {
    console.error(
      `[xangi-telegram] ${scope} attachment ${failure.index + 1} failed; retry suppressed to avoid duplicates: ` +
        formatTelegramError(failure.error)
    );
  }
}

/**
 * グループメッセージにのみ発言者・トリガー種別のコンテキストを付与する。
 */
export function buildPromptWithContext(
  text: string,
  chatType: string,
  from: { id: number; is_bot: boolean; first_name: string; username?: string },
  chatTitle: string | undefined,
  isMentioned: boolean,
  isReplyToMe: boolean
): string {
  if (chatType === 'private') return text;
  const senderDisplay = from.username ? `@${from.username}` : from.first_name;
  const senderType = from.is_bot ? 'Bot' : 'ユーザー';
  const trigger = isMentioned ? 'メンション' : isReplyToMe ? '返信' : '投稿';
  const label = chatTitle ? `グループ「${chatTitle}」` : 'グループ';
  return `[${label} / ${senderType} ${senderDisplay} からの${trigger}]\n${text}`;
}

/**
 * メンション文字列をメッセージ本文から除去する
 */
export function cleanMention(text: string, botMention: string): string {
  const regex = new RegExp(`\\s*${botMention}\\s*`, 'gi');
  return text.replace(regex, ' ').trim();
}

export function hasBotMention(text: string, username: string): boolean {
  return text.toLowerCase().includes(`@${username.toLowerCase()}`);
}

export function hasOtherBotMention(text: string, ownUsername: string): boolean {
  const own = ownUsername.toLowerCase();
  for (const match of text.matchAll(/@([A-Za-z0-9_]{5,32})/g)) {
    const mentionedUsername = match[1].toLowerCase();
    if (mentionedUsername !== own && mentionedUsername.endsWith('bot')) return true;
  }
  return false;
}

export function shouldStreamTelegramResponse(
  chatType: string,
  showThinking: boolean,
  streaming: boolean
): boolean {
  return chatType === 'private' && showThinking && streaming;
}

export function normalizeTelegramWebhookPath(path?: string): string {
  const value = path?.trim() || '/telegram/webhook';
  return `/${value.replace(/^\/+/, '')}`;
}

export function buildTelegramWebhookUrl(baseUrl: string, path?: string): string {
  return baseUrl.replace(/\/+$/, '') + normalizeTelegramWebhookPath(path);
}

/**
 * コマンドがリセットパターンに一致するか判定する
 */
export function isResetCommand(text: string, patterns: readonly string[]): boolean {
  const rawCmd = text.trim().toLowerCase();
  return patterns.some((p) => p.toLowerCase() === rawCmd);
}

/**
 * メッセージを処理すべきかどうかの判定を行う
 */
export function shouldProcessMessage(params: {
  from: { id: number; is_bot: boolean };
  chat: { id: number; type: string };
  text: string;
  botInfo: { id: number; username: string };
  allowedUsers?: string[];
  allowedBots?: string[];
  allowedChats?: string[];
  autoReplyChats?: string[];
  isReplyToMe?: boolean;
  isSessionActive?: boolean;
  replyToMentionInGroup?: boolean;
}): boolean {
  const {
    from,
    chat,
    text,
    botInfo,
    allowedUsers = [],
    allowedBots = [],
    allowedChats = [],
    autoReplyChats = [],
    isReplyToMe = false,
    isSessionActive = false,
    replyToMentionInGroup = true,
  } = params;

  // 1. 自分自身の投稿を除外
  if (from.id === botInfo.id) {
    return false;
  }

  const isBot = from.is_bot;
  const userIdStr = String(from.id);
  const chatIdStr = String(chat.id);
  const chatType = chat.type;

  // 2. 発話元 allowlist 検証
  if (!isBot) {
    const allowAll = allowedUsers.includes('*');
    if (!allowAll && !allowedUsers.includes(userIdStr)) {
      return false;
    }
  } else {
    if (!allowedBots.includes(userIdStr)) {
      return false;
    }
  }

  // 3. 会話形態の判定
  const isPrivate = chatType === 'private';
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isPrivate && !isGroup) {
    return false;
  }

  // グループチャット時の allowlist 検証
  if (isGroup) {
    if (allowedChats.length > 0 && !allowedChats.includes(chatIdStr)) {
      return false;
    }
  }

  // 他Bot宛ての投稿には、auto-reply対象やアクティブセッション中でも割り込まない。
  if (isGroup && hasOtherBotMention(text, botInfo.username)) return false;

  // 返信・メンション・トリガー判定
  const isMentioned = hasBotMention(text, botInfo.username);

  if (isPrivate) {
    return true;
  }

  if (isGroup) {
    if (isBot) {
      // Bot同士の返信連鎖を防ぐ。許可Botでも、自分への明示メンションだけを処理する。
      return isMentioned;
    } else {
      if ((replyToMentionInGroup && isMentioned) || isReplyToMe) {
        return true;
      }
      if (autoReplyChats.includes(chatIdStr)) {
        return true;
      }
      if (isSessionActive) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Telegram Botを起動する
 */
export async function startTelegramBot(opts: {
  config: Config;
  agentRunner: AgentRunner;
  scheduler: Scheduler;
}): Promise<void> {
  const { config, agentRunner, scheduler } = opts;
  const tcfg = config.telegram;

  if (!tcfg.enabled || !tcfg.botToken) {
    return;
  }

  const bot = new Bot(
    tcfg.botToken,
    tcfg.forceIpv4
      ? {
          client: {
            baseFetchConfig: {
              agent: new HttpsAgent({ keepAlive: true, family: 4 }),
            },
          },
        }
      : undefined
  );

  if (tcfg.forceIpv4) {
    console.log('[xangi-telegram] IPv4-only API connections enabled');
  }

  const mediaEnabled = tcfg.mediaEnabled === true;
  const mediaMaxBytes = (tcfg.mediaMaxDownloadMb ?? 20) * 1024 * 1024;
  const configuredMediaMimeTypes = tcfg.mediaAllowedMimeTypes;
  const mediaAllowedMimeTypes: string[] =
    configuredMediaMimeTypes && configuredMediaMimeTypes.length > 0
      ? configuredMediaMimeTypes
      : [...DEFAULT_TELEGRAM_MEDIA_MIME_TYPES];
  const mediaRetentionHours = tcfg.mediaRetentionHours ?? 24;
  if (mediaEnabled && mediaRetentionHours > 0) {
    const removed = cleanupTelegramMedia(mediaRetentionHours);
    if (removed > 0) {
      console.log(`[xangi-telegram] Removed ${removed} expired media file(s)`);
    }
    const cleanupTimer = setInterval(
      () => cleanupTelegramMedia(mediaRetentionHours),
      60 * 60 * 1000
    );
    cleanupTimer.unref();
  }

  // 未捕捉のハンドラエラーをキャッチしてポーリングを継続する
  bot.catch((err) => {
    console.error(
      `[xangi-telegram] Unhandled update error: ${formatTelegramError(err.error ?? err)}`
    );
  });

  // sendMessage は非冪等。応答待ちのタイムアウト時はTelegram側で成功済みの可能性があるため、
  // 自動再試行せずat-most-onceを優先して二重投函を防ぐ。
  scheduler.registerSender('telegram', async (chatId, msg) => {
    const chunks = splitMessage(msg, 4096);
    for (let i = 0; i < chunks.length; i++) {
      try {
        await bot.api.sendMessage(chatId, chunks[i]);
      } catch (error) {
        throw new Error(
          `[xangi-telegram] Scheduled send chunk ${i + 1} failed: ${formatTelegramError(error)}`
        );
      }
    }
  });

  // スケジューラーの生成結果も、通常メッセージと同様に「考え中」を編集して投稿する。
  // チャット単位のキューを経由し、メッセージハンドラとの並行実行を防ぐ。
  scheduler.registerAgentRunner('telegram', (prompt, chatId) => {
    const contextKey = `telegram:chat:${chatId}`;
    return enqueueForChat(contextKey, async () => {
      let thinkingMessage: Awaited<ReturnType<typeof bot.api.sendMessage>>;
      try {
        thinkingMessage = await bot.api.sendMessage(chatId, '考え中...');
      } catch (error) {
        throw new Error(
          `[xangi-telegram] Failed to send scheduled processing message: ${formatTelegramError(error)}`
        );
      }

      const unregisterFinalizer = registerStreamFinalizer(async () => {
        await bot.api
          .editMessageText(
            thinkingMessage.chat.id,
            thinkingMessage.message_id,
            'プロセス再起動により中断されました'
          )
          .catch(() => {});
      });

      try {
        const appSessionId = ensureSession(contextKey, { platform: 'telegram' });
        const messageId = `sched-${Date.now()}`;
        let runResult: Awaited<ReturnType<typeof runWithBubbleEvents>>;

        try {
          runResult = await runWithBubbleEvents(
            agentRunner,
            prompt,
            {
              threadId: threadIdFor('telegram', String(chatId)),
              turnId: turnIdFor('telegram', messageId),
              threadLabel: `Telegram Chat (${chatId})`,
              platform: 'telegram',
              userText: prompt,
            },
            {},
            {
              channelId: contextKey,
              appSessionId,
              sessionId: getProviderSessionId(contextKey),
            }
          );
        } catch (error) {
          const editResult = await retryTelegramEdit(() =>
            bot.api.editMessageText(
              thinkingMessage.chat.id,
              thinkingMessage.message_id,
              formatAgentErrorForUser(error)
            )
          );
          if (!editResult.ok) {
            console.error(
              '[xangi-telegram] Failed to edit scheduled error response: ' +
                formatTelegramError(editResult.error)
            );
          }
          throw error;
        }

        const { filePaths, displayText } = mediaEnabled
          ? buildAttachmentResult(runResult.result, runResult.attachments)
          : { filePaths: [], displayText: runResult.result };
        const result = displayText || (filePaths.length > 0 ? 'ファイルを生成しました。' : '✅');
        const chunks = splitMessage(result, 4096);
        const editResult = await retryTelegramEdit(() =>
          bot.api.editMessageText(
            thinkingMessage.chat.id,
            thinkingMessage.message_id,
            chunks[0] || '✅'
          )
        );
        if (!editResult.ok) {
          throw new Error(
            '[xangi-telegram] Failed to edit scheduled result: ' +
              formatTelegramError(editResult.error)
          );
        }

        for (let i = 1; i < chunks.length; i++) {
          try {
            await bot.api.sendMessage(chatId, chunks[i]);
          } catch (error) {
            throw new Error(
              `[xangi-telegram] Scheduled result chunk ${i + 1} failed: ${formatTelegramError(error)}`
            );
          }
        }

        const attachmentSendResult = await sendTelegramAttachments(bot.api, chatId, filePaths);
        if (attachmentSendResult.failures.length > 0) {
          logTelegramAttachmentFailures('Scheduled', attachmentSendResult);
          const notice = telegramAttachmentFailureNotice(
            attachmentSendResult.failures.length,
            filePaths.length
          );
          const noticeEdit = await retryTelegramEdit(() =>
            bot.api.editMessageText(
              thinkingMessage.chat.id,
              thinkingMessage.message_id,
              appendTelegramNotice(chunks[0] || '✅', notice)
            )
          );
          if (!noticeEdit.ok) {
            console.error(
              '[xangi-telegram] Failed to add scheduled attachment warning: ' +
                formatTelegramError(noticeEdit.error)
            );
          }
        }

        return runResult.result || '';
      } finally {
        unregisterFinalizer();
      }
    });
  });
  const botInfo = await retryTelegramOperation('Bot API', () => bot.api.getMe());
  bot.botInfo = botInfo;
  console.log(`[xangi-telegram] Ready! Logged in as @${botInfo.username} (${botInfo.id})`);
  console.log(`[xangi-telegram] Allowed group chats: ${tcfg.allowedChats?.join(', ') || '(all)'}`);
  console.log(
    `[xangi-telegram] Group auto-reply chats: ${tcfg.autoReplyChats?.join(', ') || '(none)'}`
  );

  // メッセージハンドラ
  // 処理対象の判定・コマンド処理を行い、Agent 実行はチャット単位キューに積んで返る。
  // これにより別 DM や /stop が Agent 完了を待たずに処理される。
  const handleTelegramMessage = async (
    ctx: Context,
    mediaCandidates: TelegramMediaCandidate[] = [],
    options: {
      interruptedBeforeStart?: boolean;
      receivedGeneration?: number;
      queuedGeneration?: number;
    } = {}
  ): Promise<void> => {
    const message = ctx.message;
    if (!message) return;

    const text = (message.text ?? message.caption ?? '').trim();
    const from = message.from;
    if (!from) return;

    const isBot = from.is_bot;
    const userIdStr = String(from.id);
    const chatIdStr = String(message.chat.id);
    const chatType = message.chat.type;
    const chatTitle = (message.chat as { title?: string }).title;
    const isGroupChat = chatType === 'group' || chatType === 'supergroup';
    const isQueued = options.queuedGeneration !== undefined;

    // 人間の発言は処理対象外でも、Bot同士の連続会話を明確に中断する。
    if (!isQueued && isGroupChat && !isBot) botLoopGuard.resetChat(chatIdStr);

    if ((chatType === 'group' || chatType === 'supergroup') && !loggedGroupChatIds.has(chatIdStr)) {
      loggedGroupChatIds.add(chatIdStr);
      console.log(
        `[xangi-telegram] group chat detected: chat=${chatIdStr}, sender=${userIdStr}, title=${chatTitle || '(unknown)'}`
      );
    }

    const contextKey =
      chatType === 'private' ? `telegram:dm:${userIdStr}` : `telegram:chat:${chatIdStr}`;

    const isReplyToMe = message.reply_to_message?.from?.id === botInfo.id;
    const botMention = `@${botInfo.username}`;
    const isMentioned = hasBotMention(text, botInfo.username);
    const mentionsOtherBot = hasOtherBotMention(text, botInfo.username);

    // セッションのアクティブ判定
    let isSessionActive = false;
    if (chatType !== 'private') {
      const activeSessionId = getActiveSessionId(contextKey);
      if (activeSessionId) {
        const entry = getSessionEntry(activeSessionId);
        const idleResetMs = (tcfg.idleResetHours ?? 4) * 60 * 60 * 1000;
        if (entry && !hasSessionGoneIdle(entry.updatedAt, idleResetMs)) {
          isSessionActive = true;
        }
      }
    }

    const shouldRespond =
      isQueued ||
      shouldProcessMessage({
        from,
        chat: { id: message.chat.id, type: chatType },
        text,
        botInfo,
        allowedUsers: tcfg.allowedUsers,
        allowedBots: tcfg.allowedBots,
        allowedChats: tcfg.allowedChats,
        autoReplyChats: tcfg.autoReplyChats,
        isReplyToMe,
        isSessionActive,
        replyToMentionInGroup: tcfg.replyToMentionInGroup,
      });

    if (!shouldRespond) {
      if ((chatType === 'group' || chatType === 'supergroup') && mentionsOtherBot) {
        console.log(
          `[xangi-telegram] Ignored group message addressed to another bot: chat=${chatIdStr}, sender=${userIdStr}`
        );
      } else if ((chatType === 'group' || chatType === 'supergroup') && isBot && !isMentioned) {
        console.log(
          `[xangi-telegram] Ignored bot message without explicit self mention: chat=${chatIdStr}, sender=${userIdStr}`
        );
      } else if (
        (chatType === 'group' || chatType === 'supergroup') &&
        (isMentioned || isReplyToMe)
      ) {
        const senderAllowed = isBot
          ? tcfg.allowedBots?.includes(userIdStr) === true
          : tcfg.allowedUsers?.includes('*') === true ||
            tcfg.allowedUsers?.includes(userIdStr) === true;
        const chatAllowed = !tcfg.allowedChats?.length || tcfg.allowedChats.includes(chatIdStr);
        console.warn(
          `[xangi-telegram] Ignored group mention: chat=${chatIdStr} (allowed=${chatAllowed}), ` +
            `sender=${userIdStr} (allowed=${senderAllowed})`
        );
      }
      return;
    }

    if (options.interruptedBeforeStart) {
      await ctx
        .reply(
          'プロセス再起動により添付ファイルの処理を開始できませんでした。もう一度送信してください。'
        )
        .catch((error) => {
          console.warn(
            `[xangi-telegram] Failed to send interrupted album notice: ${formatTelegramError(error)}`
          );
        });
      return;
    }

    // 明示メンションされた許可Botだけを、チャット・Bot・時間窓単位で制限する。
    if (!isQueued && isGroupChat && isBot) {
      const maxConsecutive = tcfg.allowedBotsMaxConsecutive ?? 3;
      if (!botLoopGuard.allow(chatIdStr, userIdStr, maxConsecutive)) {
        console.warn(
          `[xangi-telegram] Bot ${userIdStr} reached max consecutive responses (${maxConsecutive}) in chat ${chatIdStr}, ignoring until a human message or loop window reset`
        );
        return;
      }
    }

    const cleanText = isMentioned ? cleanMention(text, botMention) : text;
    const rawCmd = cleanText.toLowerCase();

    // リセットコマンド (/stop 同様キューを経由しない)
    const resetPatterns = tcfg.resetTextPatterns ?? ['/reset', '/new', '/clear'];
    if (isResetCommand(cleanText, resetPatterns)) {
      const activeId = getActiveSessionId(contextKey);
      resetTelegramSession(contextKey, activeId, agentRunner);
      ensureSession(contextKey, { platform: 'telegram' });
      await ctx.reply('新しく会話を始めます。').catch((err) => {
        console.warn(`[xangi-telegram] Failed to send reset reply: ${formatTelegramError(err)}`);
      });
      return;
    }

    // 停止コマンド (キューを経由せず即時キャンセル)
    if (rawCmd === '/stop') {
      agentRunner.cancel?.(contextKey);
      await ctx.reply('実行を停止しました。').catch((err) => {
        console.warn(`[xangi-telegram] Failed to send stop reply: ${formatTelegramError(err)}`);
      });
      return;
    }

    // ヘルプコマンド
    if (rawCmd === '/help') {
      await ctx
        .reply(
          '【使い方】\n' +
            '・話しかけるとAIエージェントが応答します。\n' +
            (mediaEnabled ? '・画像や動画には、キャプションで指示を添えられます。\n' : '') +
            '・/new, /reset, /clear : 新しい会話セッションを開始します。\n' +
            '・/stop : 現在実行中のタスクを停止します。\n' +
            '・/help : この案内を表示します。'
        )
        .catch((err) => {
          console.warn(`[xangi-telegram] Failed to send help reply: ${formatTelegramError(err)}`);
        });
      return;
    }

    // 本文も対応媒体も空の場合は Runner を起動しない
    if (!cleanText && mediaCandidates.length === 0) {
      await ctx.reply('何をお手伝いしましょうか？').catch((err) => {
        console.warn(
          `[xangi-telegram] Failed to send empty-text reply: ${formatTelegramError(err)}`
        );
      });
      return;
    }

    if (!isQueued) {
      const receivedGeneration = options.receivedGeneration ?? getGeneration(contextKey);
      enqueueForChat(contextKey, () =>
        handleTelegramMessage(ctx, mediaCandidates, {
          ...options,
          queuedGeneration: receivedGeneration,
        })
      ).catch((err) => {
        console.error(`[xangi-telegram] Unhandled queue error: ${formatTelegramError(err)}`);
      });
      return;
    }

    let currentGen = options.queuedGeneration!;
    const notifyResetBeforeStart = async () => {
      await ctx
        .reply('セッションがリセットされたため、このメッセージの処理を中断しました。')
        .catch((error) => {
          console.warn(
            `[xangi-telegram] Failed to send session reset notice: ${formatTelegramError(error)}`
          );
        });
    };
    if (getGeneration(contextKey) !== currentGen) {
      await notifyResetBeforeStart();
      return;
    }

    const mediaBatch = await downloadTelegramMediaBatch(
      mediaCandidates,
      (candidate) =>
        downloadTelegramMedia(candidate, {
          botToken: tcfg.botToken!,
          getFile: (fileId) => bot.api.getFile(fileId),
          maxBytes: mediaMaxBytes,
          allowedMimeTypes: mediaAllowedMimeTypes,
          forceIpv4: tcfg.forceIpv4,
        }),
      () => getGeneration(contextKey) === currentGen
    );
    if (mediaBatch.stale) {
      await notifyResetBeforeStart();
      return;
    }
    const { attachmentPaths, mediaErrors } = mediaBatch;

    const mediaFailureNotice =
      mediaErrors.length > 0
        ? telegramMediaDownloadFailureNotice(
            mediaCandidates.length,
            attachmentPaths.length,
            mediaErrors
          )
        : '';
    if (mediaFailureNotice) {
      await ctx.reply(mediaFailureNotice).catch((err) => {
        console.warn(
          `[xangi-telegram] Failed to send media error reply: ${formatTelegramError(err)}`
        );
      });
      if (getGeneration(contextKey) !== currentGen) {
        discardTelegramMediaFiles(attachmentPaths);
        await notifyResetBeforeStart();
        return;
      }
    }
    if (mediaCandidates.length > 0 && attachmentPaths.length === 0) {
      return;
    }

    // アイドルリセット
    if (tcfg.idleResetEnabled) {
      const activeId = getActiveSessionId(contextKey);
      if (activeId) {
        const entry = getSessionEntry(activeId);
        const idleResetMs = (tcfg.idleResetHours ?? 4) * 60 * 60 * 1000;
        if (entry && hasSessionGoneIdle(entry.updatedAt, idleResetMs)) {
          resetTelegramSession(contextKey, activeId, agentRunner);
          currentGen = getGeneration(contextKey);
          console.log(`[xangi-telegram] Idle reset for ${contextKey}, archived ${activeId}`);
        }
      }
    }

    const appSessionId = ensureSession(contextKey, { platform: 'telegram' });
    const showThinking = tcfg.showThinking !== false;
    const threadLabel =
      chatType === 'private'
        ? `Telegram DM (${from.username || from.first_name})`
        : `Telegram Group (${chatTitle || chatIdStr})`;

    // showThinking=true: 「考え中...」を先に送ってから編集するモード
    // showThinking=false: typing アクションのみ。最終回答は新規メッセージとして送信
    let replyMsg: Awaited<ReturnType<typeof ctx.reply>> | null = null;
    if (showThinking) {
      try {
        replyMsg = await ctx.reply('考え中...');
      } catch (err) {
        console.error(
          `[xangi-telegram] Failed to send initial processing message: ${formatTelegramError(err)}`
        );
        return;
      }
    } else {
      ctx.api.sendChatAction(message.chat.id, 'typing').catch(() => {});
    }

    const capturedReplyMsg = replyMsg;

    // グループではプロンプトに発言者・トリガー種別のコンテキストを付与する
    const promptBody = buildPromptWithContext(
      cleanText || '添付ファイルを確認してください。',
      chatType,
      { ...from, first_name: from.first_name ?? '' },
      chatTitle,
      isMentioned,
      !!isReplyToMe
    );
    const promptText = buildPromptWithAttachments(
      mediaErrors.length > 0
        ? `${promptBody}\n\n${telegramMediaDownloadContext(
            mediaCandidates.length,
            attachmentPaths.length,
            mediaErrors
          )}`
        : promptBody,
      attachmentPaths
    );

    let streamSession: StreamSession | null = null;
    let streamSessionFinished = false;
    let streamEditsPaused = false;
    let unregisterFinalizer = () => {};
    const finishStreamSession = () => {
      if (!streamSession || streamSessionFinished) return;
      streamSession.finish();
      streamSessionFinished = true;
    };
    if (capturedReplyMsg) {
      const capturedMsg = capturedReplyMsg;
      unregisterFinalizer = registerStreamFinalizer(async () => {
        finishStreamSession();
        const note = '⏸ プロセス再起動により中断されました';
        const view = streamSession?.view();
        const body = view?.text ? `${view.text.trimEnd()}\n\n${note}` : note;
        await ctx.api
          .editMessageText(capturedMsg.chat.id, capturedMsg.message_id, truncateSafe(body, 4096))
          .catch(() => {});
      });
    }

    const markSessionReset = async () => {
      if (!capturedReplyMsg) return;
      await ctx.api
        .editMessageText(
          capturedReplyMsg.chat.id,
          capturedReplyMsg.message_id,
          'セッションがリセットされました。'
        )
        .catch(() => {});
    };

    try {
      // セッションリセット後の旧世代タスクをスキップ
      if (getGeneration(contextKey) !== currentGen) {
        discardTelegramMediaFiles(attachmentPaths);
        await markSessionReset();
        return;
      }

      const render = async (view: StreamView) => {
        if (!capturedReplyMsg || streamEditsPaused) return;

        const toolPart = view.toolLines.length > 0 ? '\n' + view.toolLines.join('\n') : '';
        let displayText: string;
        if (view.phase === 'thinking') {
          displayText = view.statusLine + toolPart;
        } else {
          const textPart = view.text ? `${view.text} █` : '█';
          displayText = textPart + toolPart;
        }

        if (!displayText.trim()) {
          displayText = '考え中...';
        }

        const editResult = await retryTelegramEdit(
          () =>
            ctx.api.editMessageText(
              capturedReplyMsg.chat.id,
              capturedReplyMsg.message_id,
              truncateSafe(displayText, 4000)
            ),
          { maxAttempts: 1 }
        );
        if (!editResult.ok) {
          streamEditsPaused = true;
          console.warn(
            '[xangi-telegram] Streaming edits paused after API failure; final edit will still be attempted: ' +
              formatTelegramError(editResult.error)
          );
        }
      };

      if (shouldStreamTelegramResponse(chatType, showThinking, tcfg.streaming !== false)) {
        streamSession = new StreamSession({
          render,
          tickMs: 1000,
          streamUpdateIntervalMs: 1000,
          formatToolLine: (toolName) => `▸ ${toolName}`,
        });
        streamSession.start();
      }

      let runResult: Awaited<ReturnType<typeof runWithBubbleEvents>> | null = null;
      let runError: unknown = null;

      try {
        runResult = await runWithBubbleEvents(
          agentRunner,
          promptText,
          {
            threadId: threadIdFor('telegram', chatIdStr),
            turnId: turnIdFor('telegram', String(message.message_id)),
            threadLabel,
            platform: 'telegram',
            userText: promptText,
          },
          streamSession ? streamSession.callbacks() : {},
          {
            channelId: contextKey,
            appSessionId,
            sessionId: getProviderSessionId(contextKey),
          }
        );
      } catch (err) {
        runError = err;
        console.error('[xangi-telegram] Run error:', err);
      } finally {
        finishStreamSession();
      }

      // 実行中に /new や idle reset が入った場合、旧結果を投稿しない
      if (getGeneration(contextKey) !== currentGen) {
        discardTelegramMediaFiles(attachmentPaths);
        await markSessionReset();
        return;
      }

      const attachmentResult = runError
        ? { filePaths: [], displayText: formatAgentErrorForUser(runError) }
        : mediaEnabled
          ? buildAttachmentResult(runResult?.result || '', runResult?.attachments)
          : { filePaths: [], displayText: runResult?.result || '' };
      const finalAnswer =
        attachmentResult.displayText ||
        (attachmentResult.filePaths.length > 0 ? 'ファイルを生成しました。' : '✅');

      const chunks = splitMessage(finalAnswer, 4096);

      if (capturedReplyMsg) {
        // Editing the same message is idempotent. Never fall back to a new message after
        // a timeout because Telegram may already have applied the edit.
        const editResult = await retryTelegramEdit(() =>
          ctx.api.editMessageText(
            capturedReplyMsg.chat.id,
            capturedReplyMsg.message_id,
            chunks[0] || '✅'
          )
        );
        if (!editResult.ok) {
          console.error(
            '[xangi-telegram] Failed to edit final answer; duplicate fallback suppressed: ' +
              formatTelegramError(editResult.error)
          );
          return;
        }

        for (let i = 1; i < chunks.length; i++) {
          try {
            await ctx.reply(chunks[i]);
          } catch (sendError) {
            console.error(
              `[xangi-telegram] Failed to send final answer chunk ${i + 1}; retry suppressed to avoid duplicates: ` +
                formatTelegramError(sendError)
            );
            return;
          }
        }
      } else {
        // sendMessage is not idempotent. Send each chunk at most once so an ambiguous
        // timeout cannot create a duplicate response.
        for (let i = 0; i < chunks.length; i++) {
          try {
            await ctx.reply(chunks[i]);
          } catch (sendError) {
            console.error(
              `[xangi-telegram] Failed to send final answer chunk ${i + 1}; retry suppressed to avoid duplicates: ` +
                formatTelegramError(sendError)
            );
            return;
          }
        }
      }

      const attachmentSendResult = await sendTelegramAttachments(
        bot.api,
        message.chat.id,
        attachmentResult.filePaths,
        message.message_thread_id
      );
      if (attachmentSendResult.failures.length > 0) {
        logTelegramAttachmentFailures('Final', attachmentSendResult);
        const notice = telegramAttachmentFailureNotice(
          attachmentSendResult.failures.length,
          attachmentResult.filePaths.length
        );
        if (capturedReplyMsg) {
          const noticeEdit = await retryTelegramEdit(() =>
            ctx.api.editMessageText(
              capturedReplyMsg.chat.id,
              capturedReplyMsg.message_id,
              appendTelegramNotice(chunks[0] || '✅', notice)
            )
          );
          if (!noticeEdit.ok) {
            console.error(
              '[xangi-telegram] Failed to add attachment warning to final answer: ' +
                formatTelegramError(noticeEdit.error)
            );
          }
        } else {
          await ctx.reply(notice).catch((error) => {
            console.error(
              '[xangi-telegram] Failed to send attachment warning: ' + formatTelegramError(error)
            );
          });
        }
      }
    } finally {
      finishStreamSession();
      unregisterFinalizer();
    }
  };

  const mediaGroupBuffer = new TelegramMediaGroupBuffer<{
    ctx: Context;
    candidates: TelegramMediaCandidate[];
    receivedGeneration: number;
  }>(tcfg.mediaGroupDebounceMs ?? 750);
  type PendingMediaGroupItem = {
    ctx: Context;
    candidates: TelegramMediaCandidate[];
    receivedGeneration: number;
  };
  const primaryMediaGroupContext = (items: PendingMediaGroupItem[]): Context =>
    items.find((item) => item.ctx.message?.caption?.trim())?.ctx ?? items[0].ctx;
  let unregisterMediaGroupFinalizer: (() => void) | undefined;

  const unregisterMediaGroupFinalizerIfIdle = () => {
    if (mediaGroupBuffer.size > 0 || !unregisterMediaGroupFinalizer) return;
    unregisterMediaGroupFinalizer();
    unregisterMediaGroupFinalizer = undefined;
  };

  const ensureMediaGroupFinalizer = () => {
    if (unregisterMediaGroupFinalizer) return;
    unregisterMediaGroupFinalizer = registerStreamFinalizer(async () => {
      const pendingGroups = mediaGroupBuffer.drainAll();
      unregisterMediaGroupFinalizer = undefined;
      await Promise.all(
        pendingGroups.map(async (items) => {
          const primary = primaryMediaGroupContext(items);
          await handleTelegramMessage(
            primary,
            items.flatMap((item) => item.candidates),
            { interruptedBeforeStart: true }
          );
        })
      );
    });
  };

  const claimMessage = (ctx: Context): boolean => {
    const message = ctx.message;
    if (!message) return false;
    const msgId = `${message.chat.id}:${message.message_id}`;
    if (processedMessageIds.has(msgId)) return false;
    processedMessageIds.add(msgId);
    if (processedMessageIds.size > 10000) {
      const it = processedMessageIds.values();
      for (let i = 0; i < 2000; i++) {
        const value = it.next().value;
        if (value !== undefined) processedMessageIds.delete(value);
      }
    }
    return true;
  };

  bot.on('message', async (ctx: Context) => {
    const message = ctx.message;
    if (!message || !claimMessage(ctx)) return;

    const candidates = mediaEnabled ? extractTelegramMedia(message) : [];
    if (!message.text && candidates.length === 0) return;

    if (mediaEnabled && message.media_group_id && candidates.length > 0) {
      const groupKey = `${message.chat.id}:${message.media_group_id}`;
      const mediaContextKey =
        message.chat.type === 'private'
          ? `telegram:dm:${message.from?.id ?? message.chat.id}`
          : `telegram:chat:${message.chat.id}`;
      const receivedGeneration = getGeneration(mediaContextKey);
      ensureMediaGroupFinalizer();
      mediaGroupBuffer.add(groupKey, { ctx, candidates, receivedGeneration }, async (items) => {
        try {
          const primary = primaryMediaGroupContext(items);
          const groupedCandidates = items.flatMap((item) => item.candidates);
          await handleTelegramMessage(primary, groupedCandidates, {
            receivedGeneration: items[0].receivedGeneration,
          });
        } catch (error) {
          console.error(
            `[xangi-telegram] Unhandled media group error: ${formatTelegramError(error)}`
          );
        } finally {
          unregisterMediaGroupFinalizerIfIdle();
        }
      });
      return;
    }

    await handleTelegramMessage(ctx, candidates);
  });

  if (tcfg.mode === 'webhook') {
    const port = tcfg.webhookPort ?? 8766;
    const path = normalizeTelegramWebhookPath(tcfg.webhookPath);

    // webhook モードでは secret token を必須とする
    if (!tcfg.webhookSecretToken) {
      throw new Error(
        '[xangi-telegram] TELEGRAM_WEBHOOK_SECRET_TOKEN is required in webhook mode. ' +
          'Set it to prevent unauthorized access and restart.'
      );
    }

    if (tcfg.webhookUrl) {
      const webhookUrl = buildTelegramWebhookUrl(tcfg.webhookUrl, path);
      await retryTelegramOperation('Webhook registration', () =>
        bot.api.setWebhook(webhookUrl, { secret_token: tcfg.webhookSecretToken })
      );
      console.log(`[xangi-telegram] Webhook registered: ${webhookUrl}`);
    } else {
      console.warn(
        '[xangi-telegram] TELEGRAM_WEBHOOK_URL not set. Register webhook manually via Telegram Bot API.'
      );
    }

    const handleUpdate = webhookCallback(bot, 'http', {
      secretToken: tcfg.webhookSecretToken,
    });
    const http = await import('http');
    const server = http.createServer(async (req, res) => {
      if (req.url !== path) {
        res.writeHead(404).end();
        return;
      }
      try {
        await handleUpdate(req, res);
      } catch (err) {
        console.error(`[xangi-telegram] Webhook handler error: ${formatTelegramError(err)}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
    server.listen(port, () => {
      console.log(`[xangi-telegram] Webhook server listening on port ${port}, path: ${path}`);
    });
  } else {
    console.log('[xangi-telegram] Starting bot with long polling...');
    void superviseTelegramPolling(bot);
  }
}
