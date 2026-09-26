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
import { unlinkSync } from 'fs';
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
  createSchedulerSession,
  closeSession,
} from './sessions.js';
import { threadIdFor, turnIdFor } from './events-emitter.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import { downloadFile, buildPromptWithAttachments } from './file-utils.js';
import { executeModelsCommand, parseModelsCommand } from './models-command.js';
import { splitMessage } from './message-split.js';
import { listenHttpServer } from './http-server-startup.js';
import { readRawBody } from './web-http.js';
import type { Config } from './config.js';
import type { Scheduler } from './scheduler.js';
import { appendScheduleRunCompletion, createSchedulerRunId } from './scheduler-run.js';
import { NonRetryableError } from './errors.js';
import { parseLineScheduleTarget, type LineScheduleTarget } from './line-schedule-target.js';

export { parseLineScheduleTarget, type LineScheduleTarget } from './line-schedule-target.js';

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

// 同時送信の一部しか届いていないときの通知。本回答ではなく「待っている」ことだけを伝える。
// **他の固定文とテイストを揃えない。** 上の3つはアシスタント本人の発話だが、これは
// 配送の状態であって、アシスタントに見えている事柄ではない。システム表記として出す。
const IMAGE_SET_WAIT_NOTICE_TEXT = '[画像セットを待機中]';

/** 控えに積んだ 1 枚分 */
interface PendingImage {
  /** webhook の message ID。再配信されたイベントの重複排除に使う */
  messageId: string;
  /** 1 始まり。省略されうるので到着順の保険を持つ */
  index?: number;
  /** 到着順。index が無いときの並べ替えに使う */
  arrivedSeq: number;
  replyToken: string;
  /** 取得できた添付のパス。失敗したら null */
  path: string | null;
  /** 取得処理が終わったか */
  completed: boolean;
  /** 取得完了を待つ。次の発言が取得中に来た場合の合流に使う */
  ready: Promise<void>;
  resolveReady: () => void;
}

interface PendingImageSet {
  contextKey: string;
  userId: string;
  /** 宣言された枚数。欠けていたら undefined（この場合セットは揃わない） */
  total?: number;
  images: PendingImage[];
  /** 最後にイベントを受け取った時刻。idle reset で古い控えだけを捨てる */
  lastArrivalAt: number;
  state: 'buffered' | 'claimed' | 'discarded' | 'completed';
  /** 最後の到着から張り直すタイマー。待機通知と「考え中」を兼ねる */
  notice: NoticeTimer;
}

/**
 * 同時送信された画像を 1 ターンにまとめるための控え。
 *
 * LINE は同時送信でも 1 枚ずつ別イベントで届ける。`imageSet.id` が共通なので、
 * それを鍵に集めて `total` 枚そろった時点で 1 ターンとして処理する。
 *
 * 締め切りは持たない。送信が完了するまで webhook が出ないため、揃わないのは
 * 「まだ送信中」か「送信に失敗した」のどちらかで、締め切ると送信中のユーザーへ
 * 「N 枚しか届いていない」と返すことになる。
 *
 * **再送で揃うとは限らない。** PC 版は同じ `imageSet.id` のまま届いたが (実測で
 * 3 分 24 秒後)、Android 版は再送分に `imageSet` が付かず単発として届いた。
 * `imageSet.id` を振るのは送信側クライアントなので、揃わないまま残った控えは
 * 次の発言へ合流させて渡す。
 */
export class LineImageSetBuffer {
  private readonly sets = new Map<string, PendingImageSet>();
  private seq = 0;

  nextSeq(): number {
    return ++this.seq;
  }

  /**
   * 控えを取り出す。無ければ作って登録する。
   *
   * **await をまたがずに呼ぶこと。** 同時送信の複数イベントは 1 回の webhook に
   * まとまって届き、`handleRequest` がそれらを待ち合わせずに回す。取得と作成が
   * 別々だと、各イベントがそれぞれ自分の控えとタイマーを作ってしまい、揃った
   * 判定に使われなかったタイマーが待機通知を出す。
   */
  ensure(setId: string, create: () => PendingImageSet): PendingImageSet {
    const existing = this.sets.get(setId);
    if (existing) return existing;
    const created = create();
    this.sets.set(setId, created);
    return created;
  }

  /** download 前に 1 枚分の場所を予約する。重複イベントなら null */
  reserve(set: PendingImageSet, messageId: string, index: number | undefined): PendingImage | null {
    if (set.images.some((image) => image.messageId === messageId)) return null;
    if (index !== undefined && set.images.some((image) => image.index === index)) return null;
    let resolveReady = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const image: PendingImage = {
      messageId,
      index,
      arrivedSeq: this.nextSeq(),
      replyToken: '',
      path: null,
      completed: false,
      ready,
      resolveReady,
    };
    set.images.push(image);
    set.lastArrivalAt = Date.now();
    return image;
  }

  /** 予約済み画像の取得を完了し、セットが揃っていれば控えから外す */
  complete(
    setId: string,
    set: PendingImageSet,
    image: PendingImage,
    path: string | null
  ): PendingImage[] | null {
    image.path = path;
    image.completed = true;
    image.resolveReady();

    if (set.state === 'discarded') {
      removeBufferedFile(path);
      return null;
    }
    if (set.state !== 'buffered' || this.sets.get(setId) !== set) return null;
    if (
      set.total !== undefined &&
      set.images.length >= set.total &&
      set.images.every((entry) => entry.completed)
    ) {
      this.sets.delete(setId);
      set.state = 'completed';
      return sortPendingImages(set.images);
    }
    return null;
  }

  /** contextKey に紐づく控えを取り出して空にする（次の発言へ合流させる用） */
  async takeFor(contextKey: string): Promise<PendingImage[]> {
    const taken: PendingImage[] = [];
    for (const [id, set] of this.sets.entries()) {
      if (set.contextKey !== contextKey) continue;
      clearNoticeTimer(set.notice);
      set.state = 'claimed';
      taken.push(...set.images);
      this.sets.delete(id);
    }
    await Promise.all(taken.map((image) => image.ready));
    return sortPendingImages(taken);
  }

  /** contextKey に紐づく控えを捨てる。取得済みのファイルも消す */
  dropFor(contextKey: string): void {
    for (const [id, set] of this.sets.entries()) {
      if (set.contextKey !== contextKey) continue;
      clearNoticeTimer(set.notice);
      set.state = 'discarded';
      for (const image of set.images) removeBufferedFile(image.path);
      this.sets.delete(id);
    }
  }

  /** idle 境界より前から止まっている控えだけを捨てる。境界後に届いた新着は残す */
  dropIdleFor(contextKey: string, cutoffMs: number): void {
    for (const [id, set] of this.sets.entries()) {
      if (set.contextKey !== contextKey || set.lastArrivalAt > cutoffMs) continue;
      clearNoticeTimer(set.notice);
      set.state = 'discarded';
      for (const image of set.images) removeBufferedFile(image.path);
      this.sets.delete(id);
    }
  }
}

function removeBufferedFile(path: string | null): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch (err) {
    console.warn('[xangi-line] failed to remove buffered attachment:', err);
  }
}

/** index があればその順、無ければ到着順 */
function sortPendingImages(images: PendingImage[]): PendingImage[] {
  return [...images].sort((a, b) => {
    if (a.index !== undefined && b.index !== undefined) return a.index - b.index;
    return a.arrivedSeq - b.arrivedSeq;
  });
}

/**
 * 待機通知と「考え中」を兼ねる 1 本のタイマー。
 *
 * 期限も使う replyToken も同じなので分けない。発火時の文面だけが状態で変わる。
 * イベントが届くたびに張り替えるため、届き続けているあいだは発火しない。
 */
interface NoticeTimer {
  handle: NodeJS.Timeout | null;
  /** 発火して replyToken を消費したか */
  fired: boolean;
  /** 発火時に使う replyToken。最後に届いたイベントのもの */
  replyToken: string;
  /** 'waiting' なら揃うのを待っている、'running' ならターン実行中 */
  phase: 'waiting' | 'running';
}

function clearNoticeTimer(timer: NoticeTimer): void {
  if (timer.handle !== null) {
    clearTimeout(timer.handle);
    timer.handle = null;
  }
}

/** 前のタイマーを解除して張り直す。replyToken も最新のものへ入れ替える */
function armNoticeTimer(ctx: HandlerContext, timer: NoticeTimer, replyToken: string): void {
  clearNoticeTimer(timer);
  timer.replyToken = replyToken;
  if (!ctx.slowResponseEnabled) return;
  timer.handle = setTimeout(() => {
    timer.handle = null;
    timer.fired = true;
    const text = timer.phase === 'waiting' ? IMAGE_SET_WAIT_NOTICE_TEXT : SLOW_RESPONSE_NOTICE_TEXT;
    ctx.client
      .replyMessage({ replyToken: timer.replyToken, messages: [{ type: 'text', text }] })
      .catch((err) => {
        // token 失効や rate limit。本回答側で push へ落とすのでここでは warn のみ
        console.warn('[xangi-line] notice reply failed (non-fatal):', err);
      });
  }, ctx.slowResponseThresholdMs);
}

/**
 * 同一 contextKey のターンを直列化するキュー。
 *
 * LINE には Discord の `turnCoordinator` や Telegram の `enqueueForChat` に当たる
 * 仕組みが無く、連投すると同じユーザーのランが並行して起動していた。claude-code では
 * `PersistentRunner` の内部キューに救われるが、`CliRunnerBase` 系 (codex / grok /
 * cursor / antigravity / github-copilot / opencode) はリクエストのたびに spawn するため、
 * 同じセッションを二重に resume して失敗する。さらに `registerManagedCliProcess` は
 * `channelId` を鍵にするので、2 本目の登録が 1 本目を上書きし、上書きされた側は
 * `/stop` もタイムアウトも効かなくなる。
 *
 * 弾く (Discord / Slack) ではなく積む (Telegram) 方を採る。追加メッセージを失わない。
 *
 * `generation` はリセット用。`/reset` 等はキューを経由せず即応答し、世代を進めることで
 * 待機中のターンを無効化する。積んだままにすると、archive 済みのセッションに対して
 * 古い発言が実行されてしまう。
 */
export class LineChatQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();

  /** その contextKey で実行中・待機中のターンがあるか */
  isBusy(contextKey: string): boolean {
    return this.tails.has(contextKey);
  }

  getGeneration(contextKey: string): number {
    return this.generations.get(contextKey) ?? 0;
  }

  /** 待機中のターンを無効化する (リセット系コマンド用) */
  nextGeneration(contextKey: string): void {
    this.generations.set(contextKey, this.getGeneration(contextKey) + 1);
  }

  /**
   * contextKey ごとに task を直列化する。
   * 直前の task が失敗しても後続を止めない (`then(task, task)`)。
   */
  enqueue(contextKey: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(contextKey) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );

    this.tails.set(contextKey, tail);
    void tail.then(() => {
      if (this.tails.get(contextKey) === tail) {
        this.tails.delete(contextKey);
      }
    });

    return result;
  }
}

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
  /** 指定すると LINE 宛のスケジュール配信・エージェント実行を登録する */
  scheduler?: Scheduler;
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
  const queue = new LineChatQueue();
  const imageSets = new LineImageSetBuffer();

  if (options.scheduler) {
    registerLineSchedulerBridge({
      scheduler: options.scheduler,
      client,
      queue,
      agentRunner,
      allowedUsers,
      allowAll,
      completionDisplay,
    });
  }

  if (options.codexTransport === 'app-server') {
    await Promise.all(
      allowedUsers
        .filter((id) => id !== '*')
        .map((id) =>
          agentRunner.warmLineCodex?.(`${LINE_CONTEXT_PREFIX}${id}`).catch(() => {
            console.warn(
              '[xangi-line] Codex warmup failed; next request will retry initialization'
            );
          })
        )
    );
  }

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        codexTransport: options.codexTransport,
        path,
        channelSecret,
        channelAccessToken,
        agentRunner,
        resolver,
        client,
        queue,
        imageSets,
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

async function pushLineText(client: LineBotClient, userId: string, text: string): Promise<void> {
  const chunks = splitMessage(text, LINE_TEXT_MESSAGE_MAX);
  for (let i = 0; i < chunks.length; i++) {
    try {
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: chunks[i] }] });
    } catch (error) {
      throw new Error(`[xangi-line] Scheduled push chunk ${i + 1} failed: ${String(error)}`);
    }
  }
}

/**
 * scheduler に LINE 宛の送信とエージェント実行を登録する。
 *
 * LINE には送信済みメッセージの編集 API が無いため、Discord / Slack のように
 * 「考え中」を差し替える方式は採らず、完了時に結果だけを push する。
 */
export function registerLineSchedulerBridge(deps: {
  scheduler: Scheduler;
  client: LineBotClient;
  queue: LineChatQueue;
  agentRunner: AgentRunner;
  allowedUsers: readonly string[];
  allowAll: boolean;
  completionDisplay?: CompletionDisplayOptions;
}): void {
  const { scheduler, client, queue, agentRunner, allowedUsers, allowAll, completionDisplay } = deps;

  const requireAllowedTarget = (channelId: string): LineScheduleTarget => {
    const target = parseLineScheduleTarget(channelId);
    if (!allowAll && !allowedUsers.includes(target.userId)) {
      throw new NonRetryableError(
        `[xangi-line] Scheduled target is not in LINE_ALLOWED_USER: ${target.userId}`
      );
    }
    return target;
  };

  // pushMessage は非冪等。応答待ちのタイムアウト時は LINE 側で成功済みの
  // 可能性があるため、自動再試行せず at-most-once を優先する。
  scheduler.registerSender('line', async (channelId, message) => {
    const { userId } = requireAllowedTarget(channelId);
    await pushLineText(client, userId, message);
  });

  scheduler.registerAgentRunner('line', async (prompt, channelId, schedule, runContext) => {
    const { userId, contextKey } = requireAllowedTarget(channelId);

    const deliver = async (text: string): Promise<void> => {
      try {
        await pushLineText(client, userId, text);
        runContext?.onDelivery?.({ platform: 'line', destinationId: userId });
      } catch (pushError) {
        // pushMessage は非冪等で、途中チャンクまで届いている可能性がある。
        // 失敗を成功扱いにはせず、かつ agent 全体の再実行も止める。
        throw new NonRetryableError('[xangi-line] Scheduled result delivery failed', {
          cause: pushError,
        });
      }
    };

    let agentResult = '';
    // メッセージハンドラと同じキューを通し、同一ユーザーのターンと並行実行しない。
    await queue.enqueue(contextKey, async () => {
      runContext?.onStart?.();
      const appSessionId = createSchedulerRunId('line');
      createSchedulerSession(appSessionId, contextKey, {
        platform: 'line',
        title: schedule?.label || prompt,
      });
      const startedAt = Date.now();
      try {
        let runResult: RunResult;
        try {
          runResult = await runWithBubbleEvents(
            agentRunner,
            prompt,
            {
              threadId: threadIdFor('line', userId),
              turnId: turnIdFor('line', appSessionId),
              threadLabel: `LINE 1:1 (${userId.slice(0, 8)}…)`,
              platform: 'line',
              userText: prompt,
            },
            {},
            { channelId: contextKey, appSessionId }
          );
        } catch (error) {
          console.error('[xangi-line] scheduled run failed:', error);
          await deliver(
            appendScheduleRunCompletion(
              ERROR_FALLBACK_TEXT,
              Date.now() - startedAt,
              completionDisplay,
              'error'
            )
          );
          // 一時的なネットワークエラーの再試行判定は scheduler 側が行うため送出する。
          throw error;
        }

        agentResult = runResult.result || '…';
        await deliver(
          appendScheduleRunCompletion(agentResult, Date.now() - startedAt, completionDisplay)
        );
      } finally {
        closeSession(appSessionId, 'other');
      }
    });
    return agentResult;
  });
}

export interface HandlerContext {
  codexTransport?: 'exec' | 'app-server';
  path: string;
  channelSecret: string;
  /** コンテンツ取得 (api-data.line.me) の Bearer に使う。client は内部に隠している */
  channelAccessToken: string;
  agentRunner: AgentRunner;
  /** 同一 contextKey のターンを直列化するキュー */
  queue: LineChatQueue;
  /** 同時送信された画像を 1 ターンにまとめるための控え */
  imageSets: LineImageSetBuffer;
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
    handleLineEvent(event, ctx).catch((err) => {
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

/**
 * 添付だけが届いたときにエージェントへ渡す指示。
 *
 * **LINE は画像やファイルにテキストを添えられない。** キャプション付きの送信が
 * できないので、添付だけのイベントが普通に発生する。エージェントがその事情を
 * 知らないと「何をしてほしいのか指示してくれ」と突き返してしまう。
 *
 * 種別 (画像 / 動画 / 音声 / ファイル) を差し込んで使う。
 */
export function attachmentOnlyPrompt(label: string): string {
  return [
    `ユーザーが${label}を送った。`,
    '- LINEでは画像やファイルにテキストを添えられないため、指示は無い',
    '- 内容を確認し、これまでの文脈に応じて答える',
    '- 文脈から求められることが分からない場合は、ユーザーに質問を返す',
  ].join('\n');
}

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
 * コンテンツ取得先と認証を組にして決める。
 *
 * Channel Access Token は LINE の api-data endpoint 専用。external の
 * originalContentUrl は LINE 外のサーバーなので、Bearer を送ってはならない。
 */
export function resolveContentRequest(
  contentProvider: { type?: string; originalContentUrl?: string } | undefined,
  messageId: string,
  channelAccessToken: string
): { url: string; authHeader?: Record<string, string> } {
  const url = resolveContentSource(contentProvider, messageId);
  if (contentProvider?.type === 'external' && contentProvider.originalContentUrl) {
    return { url };
  }
  return { url, authHeader: lineContentAuthHeader(channelAccessToken) };
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
export function mediaLabel(kind: string): string {
  return kind === 'video'
    ? '動画'
    : kind === 'audio'
      ? '音声'
      : kind === 'file'
        ? 'ファイル'
        : '画像';
}

export function mediaNoticeText(kind: string, fileName?: string): string {
  const head = `ユーザーが${mediaLabel(kind)}を送った。`;
  return fileName ? `${head}名前: ${fileName}` : head;
}

/**
 * 保存名の拡張子。`file` は webhook の `fileName` から取る。
 * 実体の判定はしない — 見た目を実物に寄せるためだけのもの。
 */
export function extensionForMedia(message: { type: string; fileName?: string }): string {
  if (message.type === 'file' && message.fileName) {
    const dot = message.fileName.lastIndexOf('.');
    if (dot > 0 && dot < message.fileName.length - 1) {
      const candidate = message.fileName.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]{1,8}$/.test(candidate)) return candidate;
    }
  }
  return message.type === 'video'
    ? 'mp4'
    : message.type === 'audio'
      ? 'm4a'
      : message.type === 'image'
        ? 'jpg'
        : 'bin';
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
  message: {
    type: string;
    fileName?: string;
    contentProvider?: { type?: string; originalContentUrl?: string };
  },
  messageId: string,
  ctx: HandlerContext
): Promise<string | null> {
  const { url, authHeader } = resolveContentRequest(
    message.contentProvider,
    messageId,
    ctx.channelAccessToken
  );
  // 拡張子は保存名の見た目のためだけに付ける。実体の判定はしない。
  // **file は webhook に fileName が載っているので、その拡張子を使う。**
  // .bin にすると「拡張子は .bin だが中身は PDF だ」という余計な但し書きを
  // エージェントが付ける羽目になる。
  const ext = extensionForMedia(message);
  try {
    return await downloadFile(url, `line_${messageId}.${ext}`, authHeader);
  } catch (err) {
    console.error(`[xangi-line] failed to download ${message.type} (${messageId}):`, err);
    return null;
  }
}

/**
 * ローディング表示を出す。
 *
 * **受信時とターン開始時の両方で呼ぶ。** 直列化を入れる前は受信＝処理開始だったので
 * 受信時の1回で足りていたが、待機が入ると、待っている間に前のターンの返信が届いて
 * 表示が消える。待ち時間はむしろ直列化後の方が長いので、表示が要る場面で出なくなる。
 */
function showLoading(ctx: HandlerContext, userId: string): void {
  if (!ctx.loadingAnimationEnabled) return;
  ctx.client
    .showLoadingAnimation({ chatId: userId, loadingSeconds: ctx.loadingAnimationSeconds })
    .catch((err) => {
      console.warn('[xangi-line] showLoadingAnimation failed (non-fatal):', err);
    });
}

export async function handleLineEvent(event: webhook.Event, ctx: HandlerContext): Promise<void> {
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
    // キューを経由しない。実行中のターンの完了を待つと、リセットが即応答でなくなる。
    // 世代を進めて、リセット前に積まれたターンが archive 済みセッションに対して
    // 実行されるのを防ぐ。
    ctx.queue.nextGeneration(contextKey);
    // 明示的な区切りなので控えも捨てる。残すと、リセット後の最初の発言へ
    // 前の会話の画像が合流して、読み込みの分だけ遅くなる。
    ctx.imageSets.dropFor(contextKey);
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

  // 即時 ACK: Loading animation を webhook 受信直後・Runner 起動前に叩く。
  // 失敗してもユーザ体験は (loading 出ない) 程度なので致命的でない。warn のみ。
  // 1:1 DM のみ機能、グループ・ルームでは LINE 側で無視されるが API call 自体は成功する。
  showLoading(ctx, userId);

  // Slow response 制御: replyToken は LINE 仕様で 60s で失効するため、threshold ms
  // (default 45s) を超えそうな時は先に replyToken で通知を送って token を消費し、
  // 本回答を Push API で後追い送信する。通知の文面は phase で変わる。
  // **控えの鍵は会話ごとに分ける。** imageSet.id は LINE が振る値で、別の
  // 会話のセットと同じ鍵にぶつかると、他人へ渡る画像が出る。
  const rawSetId = message.type === 'image' ? message.imageSet?.id : undefined;
  const setId = rawSetId ? `${contextKey}\u0000${rawSetId}` : undefined;
  // 控えの取得と作成は await をまたがずに済ませる。1 回の webhook に複数の
  // イベントが入っていると、この関数は並行に走る。
  const pendingSet = setId
    ? ctx.imageSets.ensure(setId, () => ({
        contextKey,
        userId,
        total: message.type === 'image' ? message.imageSet?.total : undefined,
        images: [],
        lastArrivalAt: Date.now(),
        state: 'buffered',
        notice: { handle: null, fired: false, replyToken, phase: 'waiting' },
      }))
    : undefined;
  const notice: NoticeTimer = pendingSet?.notice ?? {
    handle: null,
    fired: false,
    replyToken,
    phase: 'running',
  };
  // イベントが届くたびに張り替える。届き続けているあいだは発火しない。
  armNoticeTimer(ctx, notice, replyToken);

  // 同時送信された画像は控えへ積み、揃うまでターンを起動しない。
  // **取得は届いた時点で始める。** 揃ってからまとめて取ると、最後の 1 枚が
  // 届いてから N 枚分のダウンロードが走り、replyToken の 60 秒を使い切る。
  let bundled: PendingImage[] | null = null;
  if (setId) {
    const imageSetIndex = message.type === 'image' ? message.imageSet?.index : undefined;
    const reserved = ctx.imageSets.reserve(
      pendingSet!,
      messageId ?? `${rawSetId}:${imageSetIndex ?? 'unknown'}`,
      imageSetIndex
    );
    if (!reserved) return;
    reserved.replyToken = replyToken;
    const saved = messageId ? await fetchLineMedia(message, messageId, ctx) : null;
    bundled = ctx.imageSets.complete(setId, pendingSet!, reserved, saved);
    if (!bundled) {
      // まだ揃っていない。本回答はせず、待機の通知だけがタイマーから出る。
      return;
    }
    notice.phase = 'running';
    pendingMedia = null;
  }

  // キューに積む。ここから先が Runner を起動する経路。
  // 世代を控えておき、待っている間に /reset が入ったターンは実行しない。
  const queuedGeneration = ctx.queue.getGeneration(contextKey);
  // 待たされるターンだけ、開始時に表示を出し直す。待たないターンで二重に出さない。
  const willWait = ctx.queue.isBusy(contextKey);

  await ctx.queue.enqueue(contextKey, async () => {
    if (ctx.queue.getGeneration(contextKey) !== queuedGeneration) {
      clearNoticeTimer(notice);
      console.log(
        `[xangi-line] skip queued turn for user ${userId.slice(0, 8)}… (session was reset)`
      );
      return;
    }

    if (willWait) showLoading(ctx, userId);

    // Idle reset: 既存 session の最終発話から idleResetMs 以上経過していたら
    // session を archive (logs/sessions/*.jsonl は残る) し、ensureSession で
    // 新規発番する。LINE は UI 境界が無いため時間ベースで会話クラスタを区切る。
    if (ctx.idleResetEnabled && ctx.idleResetMs > 0) {
      const activeId = getActiveSessionId(contextKey);
      if (activeId) {
        const entry = getSessionEntry(activeId);
        if (entry && hasSessionGoneIdle(entry.updatedAt, ctx.idleResetMs)) {
          archiveSession(activeId);
          // 会話の区切りに合わせて控えも捨てる。3 日前の画像が今日の発言へ
          // 合流すると意味が通らなくなる。
          ctx.imageSets.dropIdleFor(contextKey, Date.now() - ctx.idleResetMs);
          console.log(
            `[xangi-line] idle reset for user ${userId.slice(0, 8)}…, last=${entry.updatedAt}, archived ${activeId}`
          );
        }
      }
    }

    const appSessionId = ensureSession(contextKey, { platform: 'line' });

    const attachmentPaths: string[] = [];

    if (bundled) {
      // 同時送信がそろった。index 順に並んだ添付をまとめて 1 ターンで渡す。
      for (const image of bundled) {
        if (image.path) attachmentPaths.push(image.path);
      }
      text = attachmentOnlyPrompt(`${bundled.length}枚の画像`);
      if (attachmentPaths.length < bundled.length) {
        text = `${text}\n- ${bundled.length}枚のうち${attachmentPaths.length}枚しか取得できていない`;
      }
    } else {
      // 揃わないまま残っている控えがあれば、このターンへ合流させる。
      // ターンを走らせずにセッションへ文脈を足す口が無いため、次の発言に便乗させる。
      // 取得に失敗した控えは渡すものが無いので数えない。
      const carried = await ctx.imageSets.takeFor(contextKey);
      for (const image of carried) {
        if (image.path) attachmentPaths.push(image.path);
      }
      const carriedCount = attachmentPaths.length;
      if (carriedCount > 0) {
        text = `${text}\n\n（先に画像が${carriedCount}枚届いている）`;
      }

      // **取得はタイマーを張った後に行う。** 大きいファイルで数十秒かかっても、
      // 45 秒の通知は replyToken が生きているうちに届く。
      if (pendingMedia && messageId) {
        const saved = await fetchLineMedia(message, messageId, ctx);
        if (saved) {
          attachmentPaths.push(saved);
          // **合流の注記より後に組み立てる。** 上書きになるので、控えの分はここで足し直す。
          text = attachmentOnlyPrompt(mediaLabel(pendingMedia.kind));
          if (carriedCount > 0) {
            text = `${text}\n- 先に画像が${carriedCount}枚届いている`;
          }
        }
        // 取得できなければ text は mediaNoticeText のまま。
        // **固定文面で直接返さない。** 何が届いたかを渡して、返事はエージェントに任せる。
      }
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
        {
          channelId: contextKey,
          appSessionId,
          sessionId: resolveResumeSessionId(contextKey),
          codexLineTransport: ctx.codexTransport,
        }
      );
    } catch (err) {
      runError = err;
      console.error('[xangi-line] run failed:', err);
    } finally {
      clearNoticeTimer(notice);
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
      notice.fired || (ctx.slowResponseEnabled && elapsedMs >= ctx.slowResponseThresholdMs);

    try {
      if (usePush) {
        await ctx.client.pushMessage({
          to: userId,
          messages: [{ type: 'text', text: replyText }],
        });
      } else {
        await ctx.client.replyMessage({
          replyToken: notice.replyToken,
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
  });
}
