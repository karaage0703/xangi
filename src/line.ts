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
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { LineBotClient, validateSignature, type webhook } from '@line/bot-sdk';
import type { AgentRunner } from './agent-runner.js';
import { ensureSession, getActiveSessionId, getSessionEntry, archiveSession } from './sessions.js';
import { threadIdFor, turnIdFor } from './events-emitter.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';

const DEFAULT_PORT = 8765;
const DEFAULT_PATH = '/webhook';
const LINE_CONTEXT_PREFIX = 'line:';

// LINE text message は 5000 chars 制限 (公式仕様)
const LINE_TEXT_MESSAGE_MAX = 5000;

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

export interface LineBotOptions {
  agentRunner: AgentRunner;
  channelSecret: string;
  channelAccessToken: string;
  allowedUsers?: string[];
  port?: number;
  path?: string;
  /** Loading animation (POST /v2/bot/chat/loading/start) 即時 ACK (default: true) */
  loadingAnimationEnabled?: boolean;
  /** Loading animation 表示秒数 (5/10/15/20/25/30/40/50/60、default: 60) */
  loadingAnimationSeconds?: number;
  /** Reply→Push 自動切替 (default: true)。無効なら reply 一択で 60s 超は返信失敗 */
  slowResponseEnabled?: boolean;
  /** Slow response 閾値 ms (default: 45000)。これを超えたら「考え中」を reply で送って Push に切替 */
  slowResponseThresholdMs?: number;
  /** Idle session reset (default: true)。一定時間 idle で次の発話時に session 自動切替 */
  idleResetEnabled?: boolean;
  /** Idle reset の閾値時間 (default: 4 時間) */
  idleResetHours?: number;
  /** Reset コマンドのテキストパターン (default: 規定パターン)。空配列を渡すと検出無効 */
  resetTextPatterns?: readonly string[];
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
export function startLineBot(options: LineBotOptions): void {
  const { agentRunner, channelSecret, channelAccessToken } = options;
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

  const client = LineBotClient.fromChannelAccessToken({ channelAccessToken });

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        path,
        channelSecret,
        agentRunner,
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
      });
    } catch (err) {
      console.error('[xangi-line] request handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
  });

  server.listen(port, () => {
    console.log(`[xangi-line] webhook listening on port ${port}, path ${path}`);
    if (allowAll) {
      console.log('[xangi-line] All LINE users are allowed');
    } else if (allowedUsers.length > 0) {
      console.log(`[xangi-line] Allowed users: ${allowedUsers.join(', ')}`);
    } else {
      console.warn(
        '[xangi-line] ⚠️  LINE_ALLOWED_USER is empty — incoming messages will be ignored. Set "*" or a specific userId to enable.'
      );
    }
  });
}

interface HandlerContext {
  path: string;
  channelSecret: string;
  agentRunner: AgentRunner;
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
  const rawBody = await readRawBody(req);
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

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleEvent(event: webhook.Event, ctx: HandlerContext): Promise<void> {
  if (event.type !== 'message') return;
  const message = event.message;
  if (!message || message.type !== 'text') return;

  const source = event.source;
  const userId = source && 'userId' in source ? source.userId : undefined;
  const replyToken = 'replyToken' in event ? event.replyToken : undefined;
  const text = message.text;
  const messageId = message.id;

  if (!userId || !replyToken || !text) {
    console.warn(
      '[xangi-line] skip event (missing userId / replyToken / text):',
      JSON.stringify({ hasUserId: !!userId, hasReplyToken: !!replyToken, hasText: !!text })
    );
    return;
  }

  // allowlist
  if (!ctx.allowAll && !ctx.allowedUsers.includes(userId)) {
    console.log(`[xangi-line] user ${userId} not in allowlist, ignoring`);
    return;
  }

  const contextKey = `${LINE_CONTEXT_PREFIX}${userId}`;

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

  const startTime = Date.now();
  let runResult: { result?: string } | null = null;
  let runError: unknown = null;

  try {
    runResult = await runWithBubbleEvents(
      ctx.agentRunner,
      text,
      {
        threadId: threadIdFor('line', userId),
        turnId: turnIdFor('line', messageId ?? String(Date.now())),
        threadLabel: `LINE 1:1 (${userId.slice(0, 8)}…)`,
        platform: 'line',
        userText: text,
      },
      {},
      { channelId: contextKey, appSessionId }
    );
  } catch (err) {
    runError = err;
    console.error('[xangi-line] run failed:', err);
  } finally {
    if (slowTimer !== null) {
      clearTimeout(slowTimer);
    }
  }

  const replyText = runError
    ? ERROR_FALLBACK_TEXT
    : (runResult?.result || '').slice(0, LINE_TEXT_MESSAGE_MAX) || '…';
  const elapsedMs = Date.now() - startTime;

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
