/**
 * LINE Messaging API platform integration.
 *
 * 1:1 chat 想定のシンプル実装:
 * - `http.createServer` ベース (web-chat.ts と同じ並び、express 依存なし)
 * - `@line/bot-sdk` の `validateSignature` で raw body + X-Line-Signature 検証
 * - text message を Runner 経由で処理して `client.replyMessage` で返信
 * - contextKey = `line:<userId>` で per-userId セッション分離
 * - allowedUsers (LINE userId allowlist) で送受信を絞れる ("*" で全許可)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { LineBotClient, validateSignature, type webhook } from '@line/bot-sdk';
import type { AgentRunner, RunResult } from './agent-runner.js';
import { buildCompletionSummary, type CompletionDisplayOptions } from './completion-summary.js';
import type { BackendResolver } from './backend-resolver.js';
import {
  ensureSession,
  getActiveSessionId,
  getSessionEntry,
  getProviderSessionId,
  archiveSession,
} from './sessions.js';
import { threadIdFor, turnIdFor } from './events-emitter.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import { downloadFile, buildPromptWithAttachments } from './file-utils.js';
import { executeModelsCommand, parseModelsCommand } from './models-command.js';
import { splitMessage } from './message-split.js';
import { listenHttpServer } from './http-server-startup.js';
import { readRawBody } from './web-http.js';
import type { Config } from './config.js';

const DEFAULT_PORT = 8765;
const DEFAULT_PATH = '/webhook';
const LINE_CONTEXT_PREFIX = 'line:';

// LINE text message は 5000 chars 制限 (公式仕様)
const LINE_TEXT_MESSAGE_MAX = 5000;

export function appendLineCompletionSummary(
  text: string,
  summary: string | undefined,
  maxLength = LINE_TEXT_MESSAGE_MAX
): string {
  const suffix = summary ? `\n\n${summary}` : '';
  return `${text.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

// Loading animation の許容値 (5の倍数、最大60)
const LINE_LOADING_SECONDS_VALID: readonly number[] = [5, 10, 15, 20, 25, 30, 40, 50, 60];
const LINE_LOADING_SECONDS_DEFAULT = 60;

// Slow response 閾値 (reply token は 60s で失効するため、安全マージン込みで 45s)
const LINE_SLOW_RESPONSE_THRESHOLD_DEFAULT_MS = 45000;
const SLOW_RESPONSE_NOTICE_TEXT = '🤔 ちょっと待ってね、考えてる…';

// Idle session reset の default 閾値 (子どもの会話クラスタを自然に分ける程度)
const LINE_IDLE_RESET_HOURS_DEFAULT = 4;

// Reset コマンドのテキストパターン (大文字小文字 / 前後空白を吸収するため小文字 trim 済の形で持つ)
// メイン境界は idle reset (時間ベース)、コマンドは「明示的にリセットしたい」用の保険なので
// 曖昧さの無い slash 形式 3 つに絞る。日本語自然言語パターン (リセット / 最初から / やり直し
// 等) は誤発火境界 (「リセットってどういう意味？」/「最初からお話したい」等) との切り分けが
// 難しいので default からは外す。必要なら LINE_RESET_TEXT_PATTERNS で個別に追加できる。
const LINE_RESET_TEXT_PATTERNS_DEFAULT: readonly string[] = ['/reset', '/new', '/clear'];

const RESET_REPLY_TEXT = '最初からお話するね！何かあった？';

const ERROR_FALLBACK_TEXT = 'ごめんなさい、ちょっと調子わるいみたい…';

/**
 * テキストが reset コマンドに一致するか判定する。
 * 前後の空白を除き lowercase した比較。日本語パターンは normalize 不要 (元のまま)。
 */
export function isResetCommand(text: string, patterns: readonly string[]): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  for (const p of patterns) {
    if (!p) continue;
    if (normalized === p.toLowerCase()) return true;
  }
  return false;
}

/**
 * セッションが idle threshold を超えているか判定する。
 * `lastActivityIso` が無い / 不正なら false (= 既存 session 継続)。
 * `idleMs <= 0` の場合は無効化扱いで false。
 */
export function hasSessionGoneIdle(
  lastActivityIso: string | undefined,
  idleMs: number,
  now: number = Date.now()
): boolean {
  if (!lastActivityIso || idleMs <= 0) return false;
  const last = Date.parse(lastActivityIso);
  if (!Number.isFinite(last)) return false;
  return now - last >= idleMs;
}

/**
 * Loading animation 秒数を LINE API が受け付ける値 (5/10/15/20/25/30/40/50/60)
 * にスナップする。範囲外 / 無効値は default の 60 にフォールバック。
 */
export function snapLoadingSeconds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return LINE_LOADING_SECONDS_DEFAULT;
  }
  if (LINE_LOADING_SECONDS_VALID.includes(value)) {
    return value;
  }
  // 60 超は 60 にクリップ、5 未満は 5 に切り上げ、それ以外は近い valid 値に
  const clamped = Math.max(5, Math.min(60, Math.floor(value)));
  let best = LINE_LOADING_SECONDS_VALID[0];
  let bestDiff = Math.abs(clamped - best);
  for (const v of LINE_LOADING_SECONDS_VALID) {
    const diff = Math.abs(clamped - v);
    if (diff < bestDiff) {
      best = v;
      bestDiff = diff;
    }
  }
  return best;
}

export interface LineBotOptions extends Omit<
  Config['line'],
  | 'enabled'
  | 'channelSecret'
  | 'channelAccessToken'
  | 'webhookPort'
  | 'webhookPath'
  | 'resetTextPatterns'
> {
  agentRunner: AgentRunner;
  resolver: BackendResolver;
  channelSecret: string;
  channelAccessToken: string;
  port?: number;
  path?: string;
  resetTextPatterns?: readonly string[];
  completionDisplay?: CompletionDisplayOptions;
  completionNotifyAfterMs?: number;
}

/**
 * LINE Bot を起動する。`config.line.enabled` が true のときのみ呼ばれる想定。
 *
 * webhook サーバは `LINE_WEBHOOK_PORT` (default 8765) で待ち受け、
 * `LINE_WEBHOOK_PATH` (default `/webhook`) で POST を受ける。
 *
 * Tailscale Funnel / Cloudflare Tunnel 等で外部公開する場合は、
 * `https://<funnel-host>/webhook` を LINE Developers コンソールの
 * Webhook URL に登録する。
 */
export async function startLineBot(options: LineBotOptions): Promise<Server> {
  const { agentRunner, resolver, channelSecret, channelAccessToken } = options;
  const port = options.port ?? DEFAULT_PORT;
  const path = options.path ?? DEFAULT_PATH;
  const allowedUsers = options.allowedUsers ?? [];
  const allowAll = allowedUsers.includes('*');
  const loadingAnimationEnabled = options.loadingAnimationEnabled ?? true;
  const loadingAnimationSeconds = snapLoadingSeconds(options.loadingAnimationSeconds);
  const slowResponseEnabled = options.slowResponseEnabled ?? true;
  const slowResponseThresholdMs =
    options.slowResponseThresholdMs ?? LINE_SLOW_RESPONSE_THRESHOLD_DEFAULT_MS;
  const idleResetEnabled = options.idleResetEnabled ?? true;
  const idleResetHours = options.idleResetHours ?? LINE_IDLE_RESET_HOURS_DEFAULT;
  const idleResetMs = Math.max(0, idleResetHours * 3600 * 1000);
  const resetTextPatterns = options.resetTextPatterns ?? LINE_RESET_TEXT_PATTERNS_DEFAULT;
  const completionDisplay = options.completionDisplay ?? {
    showElapsed: true,
  };
  const completionNotifyAfterMs = options.completionNotifyAfterMs ?? 10_000;

  const client = LineBotClient.fromChannelAccessToken({ channelAccessToken });

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        path,
        channelSecret,
        channelAccessToken,
        agentRunner,
        resolver,
        client,
        allowedUsers,
        allowAll,
        loadingAnimationEnabled,
        loadingAnimationSeconds,
        slowResponseEnabled,
        slowResponseThresholdMs,
        idleResetEnabled,
        idleResetMs,
        resetTextPatterns,
        completionDisplay,
        completionNotifyAfterMs,
      });
    } catch (err) {
      console.error('[xangi-line] request handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
  });

  await listenHttpServer(server, port);
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`[xangi-line] webhook listening on port ${actualPort}, path ${path}`);
  if (allowAll) {
    console.log('[xangi-line] All LINE users are allowed');
  } else if (allowedUsers.length > 0) {
    console.log(`[xangi-line] Allowed users: ${allowedUsers.join(', ')}`);
  } else {
    console.warn(
      '[xangi-line] ⚠️  LINE_ALLOWED_USER is empty — incoming messages will be ignored. Set "*" or a specific userId to enable.'
    );
  }
  return server;
}

interface HandlerContext {
  path: string;
  channelSecret: string;
  /** コンテンツ取得 (api-data.line.me) の Bearer に使う。client は内部に隠している */
  channelAccessToken: string;
  agentRunner: AgentRunner;
  resolver: BackendResolver;
  client: LineBotClient;
  allowedUsers: string[];
  allowAll: boolean;
  loadingAnimationEnabled: boolean;
  loadingAnimationSeconds: number;
  slowResponseEnabled: boolean;
  slowResponseThresholdMs: number;
  idleResetEnabled: boolean;
  idleResetMs: number;
  resetTextPatterns: readonly string[];
  completionDisplay: CompletionDisplayOptions;
  completionNotifyAfterMs: number;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext
): Promise<void> {
  const url = (req.url || '/').split('?')[0];

  // health check (GET / or GET /webhook)
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('xangi-line webhook ok');
    return;
  }

  if (req.method !== 'POST' || url !== ctx.path) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  // raw body 取得 (署名検証は raw bytes 必須)
  const rawBody = await readRawBody(req, Number.MAX_SAFE_INTEGER);
  const signature = (req.headers['x-line-signature'] as string | undefined) ?? '';

  if (!signature || !validateSignature(rawBody, ctx.channelSecret, signature)) {
    console.warn('[xangi-line] Invalid signature');
    res.writeHead(401);
    res.end('Invalid signature');
    return;
  }

  // ack を先に返す (LINE は 30 秒以内に 200 期待、処理は非同期で続行)
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));

  let payload: webhook.CallbackRequest;
  try {
    payload = JSON.parse(rawBody) as webhook.CallbackRequest;
  } catch (err) {
    console.warn('[xangi-line] Invalid JSON body:', err);
    return;
  }

  const events = payload.events ?? [];
  for (const event of events) {
    handleEvent(event, ctx).catch((err) => {
      console.error('[xangi-line] handleEvent error:', err);
    });
  }
}

/**
 * runner へ渡す resume 用のセッション ID を決める。
 *
 * **これが undefined だと毎ターン新規セッションになる。** codex なら `resume <id>`、
 * grok / cursor なら `--resume <id>`、antigravity なら `--conversation <id>` ……と
 * 引数の形は違うが、いずれも `options.sessionId` が無ければ会話を引き継がない。
 * Claude Code だけは persistent-runner が別経路で保つため影響を受けない。
 *
 * `/reset` は `archiveSession` で `activeByContext` から外すので、ここは自然に
 * undefined を返し、次のターンが新規セッションになる。
 */
export function resolveResumeSessionId(contextKey: string): string | undefined {
  return getProviderSessionId(contextKey);
}

/** スタンプの keywords は最大15語返る。全部渡すとノイズになるので先頭だけ使う。 */
const STICKER_KEYWORD_LIMIT = 3;

/** 画像が無いときにエージェントへ渡す既定の指示 (Discord 側と揃える) */
const LINE_ATTACHMENT_ONLY_PROMPT = '添付ファイルを確認してください';

/**
 * コンテンツ取得のエンドポイント。
 * **送信系の api.line.me とはホストが違う。** 取り違えると 404 になる。
 */
export function lineContentUrl(messageId: string): string {
  return `https://api-data.line.me/v2/bot/message/${messageId}/content`;
}

/** コンテンツ取得の認証ヘッダ。Bearer が無いと 401 になる。 */
export function lineContentAuthHeader(channelAccessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${channelAccessToken}` };
}

/**
 * 取得元を決める。**コンテンツが LINE サーバにあるとは限らない。**
 * contentProvider.type が external のときは originalContentUrl から取る。
 */
export function resolveContentSource(
  contentProvider: { type?: string; originalContentUrl?: string } | undefined,
  messageId: string
): string {
  if (contentProvider?.type === 'external' && contentProvider.originalContentUrl) {
    return contentProvider.originalContentUrl;
  }
  return lineContentUrl(messageId);
}

/**
 * スタンプをテキストにする。
 *
 * **メッセージスタンプは入力文字を主に置く。** keywords はスタンプ側の属性だが、
 * text は本人が打った言葉で意図に近い。
 */
export function stickerToText(sticker: { keywords?: string[]; text?: string }): string {
  const head = 'ユーザーがスタンプを送った。';
  const meaning = (sticker.keywords ?? []).slice(0, STICKER_KEYWORD_LIMIT).join(', ');
  if (sticker.text) {
    return meaning
      ? `${head}「${sticker.text}」（意味: ${meaning}）`
      : `${head}「${sticker.text}」`;
  }
  return meaning ? `${head}意味: ${meaning}` : head;
}

/**
 * 位置情報をテキストにする。
 * **地図から地点を選ぶと title は付かず address だけが返る**ので、どちらも省略されうる。
 */
export function locationToText(location: {
  title?: string;
  address?: string;
  latitude: number;
  longitude: number;
}): string {
  const label = [location.title, location.address].filter(Boolean).join(' / ');
  const coords = `(${location.latitude}, ${location.longitude})`;
  return label
    ? `ユーザーが位置情報を送った。${label} ${coords}`
    : `ユーザーが位置情報を送った。${coords}`;
}

/**
 * 本体を取得できなかったときに、何が届いたかだけをエージェントへ伝える。
 *
 * **ユーザーへ直接送る文面ではない。** プロンプトに載せて、返事はエージェントに任せる。
 * 固定文面で直接返すと、導入環境ごとの口調と合わなくなる。
 */
export function mediaNoticeText(kind: string, fileName?: string): string {
  const label =
    kind === 'video' ? '動画' : kind === 'audio' ? '音声' : kind === 'file' ? 'ファイル' : '画像';
  const head = `ユーザーが${label}を送った。`;
  return fileName ? `${head}名前: ${fileName}` : head;
}

/**
 * メディアの本体を取得してローカルへ保存する。取得できなければ null。
 *
 * **受信と同じターンで取りに行く。** LINE は "Content that users send is automatically
 * deleted after a certain period of time" と明記しており、保持期間は公開されていない。
 *
 * **transcoding の状態は見て回らない。** image / file では 400 が返り
 * (`Transcoding status doesn't support this type of content`)、video / audio でも
 * 実測では常に `succeeded` だった。`processing` は「準備中」であって失敗ではないので、
 * どの状態でも一度は取得を試し、取れなければ諦める。
 */
async function fetchLineMedia(
  message: { type: string; contentProvider?: { type?: string; originalContentUrl?: string } },
  messageId: string,
  ctx: HandlerContext
): Promise<string | null> {
  const url = resolveContentSource(message.contentProvider, messageId);
  // 拡張子は保存名の見た目のためだけに付ける。実体の判定はしない。
  const ext =
    message.type === 'video'
      ? 'mp4'
      : message.type === 'audio'
        ? 'm4a'
        : message.type === 'image'
          ? 'jpg'
          : 'bin';
  try {
    return await downloadFile(
      url,
      `line_${messageId}.${ext}`,
      lineContentAuthHeader(ctx.channelAccessToken)
    );
  } catch (err) {
    console.error(`[xangi-line] failed to download ${message.type} (${messageId}):`, err);
    return null;
  }
}

async function handleEvent(event: webhook.Event, ctx: HandlerContext): Promise<void> {
  if (event.type !== 'message') return;
  const message = event.message;
  if (!message) return;

  const source = event.source;
  const userId = source && 'userId' in source ? source.userId : undefined;
  const replyToken = 'replyToken' in event ? event.replyToken : undefined;
  const messageId = message.id;

  if (!userId || !replyToken) {
    console.warn(
      '[xangi-line] skip event (missing userId / replyToken):',
      JSON.stringify({ hasUserId: !!userId, hasReplyToken: !!replyToken, type: message.type })
    );
    return;
  }

  // **allowlist は本体取得より先に見る。** 後ろに置くと、許可していない相手の
  // ファイルまでダウンロードしてしまう。
  if (!ctx.allowAll && !ctx.allowedUsers.includes(userId)) {
    console.log(`[xangi-line] user ${userId} not in allowlist, ignoring`);
    return;
  }

  // 種別ごとに、エージェントへ渡すテキストを決める。
  // **本体の取得はここではしない。** 取得は slow-response タイマーを張った後に行う
  // (実測で 356MB / 41秒。先に取ると 45 秒の通知が出る頃には replyToken が失効する)。
  let text: string;
  let pendingMedia: { kind: string; fileName?: string } | null = null;

  switch (message.type) {
    case 'text':
      if (!message.text) {
        console.warn('[xangi-line] skip event (empty text)');
        return;
      }
      text = message.text;
      break;
    case 'sticker':
      text = stickerToText(message);
      break;
    case 'location':
      text = locationToText(message);
      break;
    case 'image':
    case 'video':
    case 'audio':
    case 'file': {
      const fileName = message.type === 'file' ? message.fileName : undefined;
      text = mediaNoticeText(message.type, fileName);
      if (messageId) {
        pendingMedia = { kind: message.type, fileName };
      }
      break;
    }
    default: {
      // 型の上では全種別を網羅しているが、LINE 側が新しい種別を追加する可能性がある。
      // **無言で捨てず、何が届いたかだけはエージェントへ渡す。**
      const unknownType = (message as { type?: string }).type ?? 'unknown';
      console.log(`[xangi-line] unknown message type: ${unknownType}`);
      text = `ユーザーが${unknownType}を送った。`;
      break;
    }
  }

  const contextKey = `${LINE_CONTEXT_PREFIX}${userId}`;

  const modelsBackend = parseModelsCommand(text);
  if (modelsBackend !== null) {
    try {
      const result = await executeModelsCommand(modelsBackend, ctx.resolver);
      await ctx.client.replyMessage({
        replyToken,
        messages: splitMessage(result, LINE_TEXT_MESSAGE_MAX)
          .slice(0, 5)
          .map((chunk) => ({ type: 'text' as const, text: chunk })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'モデル一覧の取得に失敗しました';
      await ctx.client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: message.slice(0, LINE_TEXT_MESSAGE_MAX) }],
      });
    }
    return;
  }

  // Reset コマンド検出: テキストが reset patterns に一致したら現 session を archive、
  // 新 session を発番、確認テキストを返して Runner 起動はしない。
  // ユーザが明示的に「新しく話したい」と言ったときの即時応答経路。
  if (ctx.resetTextPatterns.length > 0 && isResetCommand(text, ctx.resetTextPatterns)) {
    const activeId = getActiveSessionId(contextKey);
    if (activeId) {
      archiveSession(activeId);
      console.log(
        `[xangi-line] reset command (${text.trim()}) for user ${userId.slice(0, 8)}…, archived ${activeId}`
      );
    }
    ensureSession(contextKey, { platform: 'line' });
    try {
      await ctx.client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: RESET_REPLY_TEXT }],
      });
    } catch (replyErr) {
      console.error('[xangi-line] reset reply failed:', replyErr);
    }
    return;
  }

  // Idle reset: 既存 session の最終発話から idleResetMs 以上経過していたら
  // session を archive (logs/sessions/*.jsonl は残る) し、ensureSession で
  // 新規発番する。LINE は UI 境界が無いため時間ベースで会話クラスタを区切る。
  if (ctx.idleResetEnabled && ctx.idleResetMs > 0) {
    const activeId = getActiveSessionId(contextKey);
    if (activeId) {
      const entry = getSessionEntry(activeId);
      if (entry && hasSessionGoneIdle(entry.updatedAt, ctx.idleResetMs)) {
        archiveSession(activeId);
        console.log(
          `[xangi-line] idle reset for user ${userId.slice(0, 8)}…, last=${entry.updatedAt}, archived ${activeId}`
        );
      }
    }
  }

  // 即時 ACK: Loading animation を webhook 受信直後・Runner 起動前に叩く。
  // 失敗してもユーザ体験は (loading 出ない) 程度なので致命的でない。warn のみ。
  // 1:1 DM のみ機能、グループ・ルームでは LINE 側で無視されるが API call 自体は成功する。
  if (ctx.loadingAnimationEnabled) {
    ctx.client
      .showLoadingAnimation({ chatId: userId, loadingSeconds: ctx.loadingAnimationSeconds })
      .catch((err) => {
        console.warn('[xangi-line] showLoadingAnimation failed (non-fatal):', err);
      });
  }

  const appSessionId = ensureSession(contextKey, { platform: 'line' });

  // Slow response 制御: replyToken は LINE 仕様で 60s で失効するため、threshold ms
  // (default 45s) を超えそうな時は (a) 先に replyToken で「考え中」テンプレを送って
  // token を消費し、(b) 本回答を Push API で後追い送信する。
  // - slowFiredRef.value=false → 完了が threshold 未満で、replyToken がまだ生きている → reply で本回答
  // - slowFiredRef.value=true  → 「考え中」を reply で送信済 (token 消費済) → push で本回答
  const slowFiredRef = { value: false };
  let slowTimer: NodeJS.Timeout | null = null;

  if (ctx.slowResponseEnabled) {
    slowTimer = setTimeout(() => {
      slowFiredRef.value = true;
      ctx.client
        .replyMessage({
          replyToken,
          messages: [{ type: 'text', text: SLOW_RESPONSE_NOTICE_TEXT }],
        })
        .catch((err) => {
          // notice の reply 失敗 = token 失効や rate limit。push へのフォールバックは本回答側で行うのでここでは warn のみ
          console.warn('[xangi-line] slow-response notice reply failed (non-fatal):', err);
        });
    }, ctx.slowResponseThresholdMs);
  }

  // **取得はタイマーを張った後に行う。** 大きいファイルで数十秒かかっても、
  // 45 秒の「考え中」は replyToken が生きているうちに届く。
  const attachmentPaths: string[] = [];
  if (pendingMedia && messageId) {
    const saved = await fetchLineMedia(message, messageId, ctx);
    if (saved) {
      attachmentPaths.push(saved);
      // 添付があるときは Discord と同じ既定文に寄せる。種別の通知は添付で代替される。
      text = LINE_ATTACHMENT_ONLY_PROMPT;
    }
    // 取得できなければ text は mediaNoticeText のまま。
    // **固定文面で直接返さない。** 何が届いたかを渡して、返事はエージェントに任せる。
  }

  const startTime = Date.now();
  let runResult: RunResult | null = null;
  let runError: unknown = null;

  try {
    runResult = await runWithBubbleEvents(
      ctx.agentRunner,
      buildPromptWithAttachments(text, attachmentPaths),
      {
        threadId: threadIdFor('line', userId),
        turnId: turnIdFor('line', messageId ?? String(Date.now())),
        threadLabel: `LINE 1:1 (${userId.slice(0, 8)}…)`,
        platform: 'line',
        userText: text,
      },
      {},
      { channelId: contextKey, appSessionId, sessionId: resolveResumeSessionId(contextKey) }
    );
  } catch (err) {
    runError = err;
    console.error('[xangi-line] run failed:', err);
  } finally {
    if (slowTimer !== null) {
      clearTimeout(slowTimer);
    }
  }

  const elapsedMs = Date.now() - startTime;
  const rawReplyText = runError ? ERROR_FALLBACK_TEXT : runResult?.result || '…';
  const completionSummary =
    !runError && elapsedMs >= ctx.completionNotifyAfterMs
      ? buildCompletionSummary({ elapsedMs }, ctx.completionDisplay)
      : undefined;
  const replyText = appendLineCompletionSummary(rawReplyText, completionSummary);

  // 送信経路の決定:
  //   - slow notice が発火済 → reply token 消費済なので push 必須
  //   - 発火していない + 経過時間が threshold 未満 → reply 可
  //   - 発火していない + 経過時間が threshold 以上 → タイマー実行前に completed したか、
  //     slow response 無効化中。reply token はまだ生きてる可能性あるが安全側で push にフォールバック
  const usePush =
    slowFiredRef.value || (ctx.slowResponseEnabled && elapsedMs >= ctx.slowResponseThresholdMs);

  try {
    if (usePush) {
      await ctx.client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: replyText }],
      });
    } else {
      await ctx.client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: replyText }],
      });
    }
  } catch (sendErr) {
    console.error('[xangi-line] final send failed:', sendErr);
    // reply が失敗 (token 失効など) なら push にフォールバック (まだ試してない場合のみ)
    if (!usePush) {
      try {
        await ctx.client.pushMessage({
          to: userId,
          messages: [{ type: 'text', text: replyText }],
        });
      } catch (pushErr) {
        console.error('[xangi-line] push fallback also failed:', pushErr);
      }
    }
  }
}
