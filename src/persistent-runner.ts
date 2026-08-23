import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type {
  RunOptions,
  RunResult,
  StreamCallbacks,
  AgentRunner,
  TimeoutState,
  ExtendTimeoutResult,
} from './agent-runner.js';
import { mergeTexts, sanitizeSurrogates, prependRuntimeContext } from './agent-runner.js';
import { stripToolCallArtifacts, finalizeDisplayText } from './tool-call-sanitize.js';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, TIMEOUT_EXTEND_ENABLED } from './constants.js';
import { buildPersistentSystemPrompt } from './base-runner.js';
import type { ChatPlatform } from './prompts/index.js';
import { logPrompt, logResponse, logError } from './transcript-logger.js';
import { buildCliEnv } from './cli-process.js';
import { appendJsonlChunk } from './jsonl-buffer.js';
import { configuredBackendCommand } from './setup/backend-executable.js';

/**
 * リクエストキューのアイテム
 */
interface QueueItem {
  prompt: string;
  options?: RunOptions;
  callbacks?: StreamCallbacks;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
}

/**
 * Claude Code CLI を常駐プロセスとして実行するランナー
 *
 * --input-format=stream-json を使用して、1つのプロセスで複数のリクエストを処理
 */
export class PersistentRunner extends EventEmitter implements AgentRunner {
  private process: ChildProcess | null = null;
  private processAlive = false;
  private queue: QueueItem[] = [];
  private currentItem: QueueItem | null = null;
  private buffer = '';
  private sessionId = '';
  private fullText = '';
  private shuttingDown = false;
  private cancelling = false;

  // サーキットブレーカー: 連続クラッシュ対策
  private crashCount = 0;
  private lastCrashTime = 0;
  private static readonly MAX_CRASHES = 3;
  private static readonly CRASH_WINDOW_MS = 60000; // 1分以内に3回クラッシュで停止

  private model?: string;
  private timeoutMs: number;
  /** 動的延長の絶対上限 (リクエスト開始時刻 + maxTimeoutMs)。constants.MAX_TIMEOUT_MS で固定 */
  private readonly maxTimeoutMs: number;
  /** 現在のリクエスト用のタイムアウト状態 (currentItem が null のときは未設定) */
  private currentTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private currentRequestStartedAt = 0;
  private currentTimeoutAt = 0;
  private currentMaxTimeoutAt = 0;
  /** 累積タイムアウト幅 (初期は timeoutMs、extendTimeout で増える) */
  private currentTimeoutMs = 0;
  private workdir?: string;
  private skipPermissions: boolean;
  private systemPrompt: string;
  private resumeSessionId?: string; // プロセス再起動時に --resume で復元するセッションID
  private channelId?: string; // トランスクリプトログ用
  private appSessionId?: string; // xangi側のセッションID
  private platform?: ChatPlatform;
  private effort?: string; // Claude Code の --effort オプション
  private bare: boolean;
  private maxBudgetUsd?: string;

  constructor(options?: {
    model?: string;
    timeoutMs?: number;
    workdir?: string;
    skipPermissions?: boolean;
    channelId?: string;
    platform?: ChatPlatform;
    effort?: string;
  }) {
    super();
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = MAX_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
    this.systemPrompt = buildPersistentSystemPrompt(options?.platform);
    this.channelId = options?.channelId;
    this.platform = options?.platform;
    this.effort = options?.effort;
    this.bare = process.env.CLAUDE_CODE_BARE === 'true';
    this.maxBudgetUsd = process.env.CLAUDE_CODE_MAX_BUDGET_USD?.trim() || undefined;
  }

  /**
   * appSessionIdを設定（外部から呼ぶ）
   */
  setAppSessionId(appSessionId: string): void {
    this.appSessionId = appSessionId;
  }

  /**
   * 常駐プロセスを起動
   */
  private ensureProcess(): ChildProcess {
    if (this.process && this.processAlive) {
      return this.process;
    }

    // サーキットブレーカーチェック
    if (this.crashCount >= PersistentRunner.MAX_CRASHES) {
      const elapsed = Date.now() - this.lastCrashTime;
      if (elapsed < PersistentRunner.CRASH_WINDOW_MS) {
        throw new Error(
          `Circuit breaker open: ${this.crashCount} crashes in ${elapsed}ms. Waiting for cooldown.`
        );
      }
      // クールダウン経過後はリセット（セッションは既にクリア済みなので新規セッションで起動）
      console.log(
        '[persistent-runner] Circuit breaker reset after cooldown. Starting fresh session.'
      );
      this.crashCount = 0;
    }

    const args: string[] = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ];

    if (this.bare) {
      args.push('--bare');
    }

    if (this.maxBudgetUsd) {
      args.push('--max-budget-usd', this.maxBudgetUsd);
    }

    if (this.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.effort) {
      args.push('--effort', this.effort);
    }

    // セッション復元: 保存済みセッションIDがあれば --resume で継続
    const resumeId = this.resumeSessionId || this.sessionId;
    if (resumeId) {
      args.push('--resume', resumeId);
      console.log(`[persistent-runner] Resuming session: ${resumeId.slice(0, 8)}...`);
    }

    args.push('--append-system-prompt', this.systemPrompt);

    console.log('[persistent-runner] Starting persistent process...');

    const env = this.buildEnv();
    const proc = spawn(configuredBackendCommand('claude', env), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.workdir,
      env,
    });
    this.process = proc;
    this.processAlive = true;

    proc.stdout?.on('data', (data) => this.handleOutput(data.toString()));
    proc.stderr?.on('data', (data) => {
      console.error('[persistent-runner] stderr:', data.toString());
    });

    proc.on('close', (code) => {
      // kill 後に次のプロセスを起動済みの場合、古いプロセスの close が遅れて
      // 届くことがある。新プロセスの状態 (process / currentItem / buffer) を
      // 壊さないよう、別プロセスに置き換わっている場合のみ無視する。
      // this.process === null (cancel/timeout が kill 直後に null 化した) の
      // 場合はこの close が現行プロセスの死亡通知そのものなので、後始末
      // (cancelling リセット + キュー再開) を必ず実行する。null まで stale
      // 扱いすると、キューに並んだ次のリクエストが永久に開始されない
      if (this.process !== null && this.process !== proc) {
        console.log(`[persistent-runner] Stale process exited with code ${code} (ignored)`);
        return;
      }

      console.log(`[persistent-runner] Process exited with code ${code}`);
      const wasShuttingDown = this.shuttingDown;
      this.process = null;
      this.processAlive = false;
      this.buffer = ''; // バッファをクリア

      // シャットダウン中またはキャンセル中なら正常終了。
      // ただし currentItem が残っていたら必ず reject する（reject しないと
      // 呼び出し側の Promise が永久に settle せず、Discord 等のメッセージが
      // ライブツール履歴のまま固定される。issue #286）
      if (wasShuttingDown) {
        this.failCurrentItem(new Error(`Process exited during shutdown (code ${code})`));
        return;
      }
      if (this.cancelling) {
        this.cancelling = false;
        this.failCurrentItem(new Error(`Process exited during cancellation (code ${code})`));
        // キューに次のリクエストがあれば処理
        if (this.queue.length > 0) {
          this.processNext();
        }
        return;
      }

      // クラッシュカウンタを更新
      this.crashCount++;
      this.lastCrashTime = Date.now();
      console.warn(
        `[persistent-runner] Crash count: ${this.crashCount}/${PersistentRunner.MAX_CRASHES}`
      );

      // 現在処理中のリクエストがあればエラーで終了
      this.failCurrentItem(new Error(`Process exited unexpectedly with code ${code}`));

      // サーキットブレーカーがオープンでなければ再処理
      if (this.queue.length > 0 && this.crashCount < PersistentRunner.MAX_CRASHES) {
        console.log('[persistent-runner] Restarting process for queued requests...');
        this.processNext();
      } else if (this.crashCount >= PersistentRunner.MAX_CRASHES) {
        // サーキットブレーカーオープン: セッションを破棄して次回は新規セッションで起動
        console.error(
          '[persistent-runner] Circuit breaker OPEN. Clearing session to recover on next request.'
        );
        const oldSessionId = this.sessionId || this.resumeSessionId;
        this.sessionId = '';
        this.resumeSessionId = undefined;
        this.emit('session-invalidated', this.channelId, oldSessionId);

        // キューを全部エラーにする
        for (const item of this.queue) {
          item.reject(
            new Error(
              'Circuit breaker open: too many process crashes. Session cleared for recovery.'
            )
          );
        }
        this.queue = [];
      }
    });

    proc.on('error', (err) => {
      console.error('[persistent-runner] Process error:', err);
      if (this.process !== null && this.process !== proc) return; // 別プロセスに置き換わり済みのエラーは無視
      this.process = null;
      this.processAlive = false;

      this.failCurrentItem(err);
    });

    return proc;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = buildCliEnv(this.channelId, this.platform, this.workdir);
    if (process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    return env;
  }

  /**
   * 現在処理中のリクエストをエラーで終了させる（未設定なら no-op）。
   * close / error / processNext 内の例外など「どの経路でプロセスを失っても
   * 呼び出し側の Promise を必ず settle させる」ための共通出口。
   */
  private failCurrentItem(error: Error): void {
    if (!this.currentItem) return;
    const item = this.currentItem;
    this.currentItem = null;
    this.fullText = '';
    item.callbacks?.onError?.(error);
    item.reject(error);
  }

  /**
   * stdout からの出力を処理
   */
  private handleOutput(data: string): void {
    const parsed = appendJsonlChunk(this.buffer, data);
    this.buffer = parsed.buffer;

    for (const line of parsed.lines) {
      try {
        const json = JSON.parse(line);
        this.handleJsonMessage(json);
      } catch (e) {
        // 予期しないCLI出力をログ（デバッグ用）
        console.warn('[persistent-runner] Failed to parse JSON line:', line.slice(0, 100), e);
      }
    }
  }

  /**
   * JSON メッセージを処理
   */
  private handleJsonMessage(json: {
    type: string;
    subtype?: string;
    session_id?: string;
    message?: {
      content?: Array<{
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
    };
    result?: string;
    error?: string;
    is_error?: boolean;
  }): void {
    if (json.type === 'system' && json.session_id) {
      this.sessionId = json.session_id;
      console.log(`[persistent-runner] Session initialized: ${this.sessionId.slice(0, 8)}...`);
    }

    if (json.type === 'assistant' && json.message?.content) {
      for (const block of json.message.content) {
        if (block.type === 'text' && block.text) {
          const clean = stripToolCallArtifacts(block.text);
          if (clean) {
            this.fullText += clean;
            this.currentItem?.callbacks?.onText?.(clean, this.fullText);
          }
        }
        if (block.type === 'tool_use' && block.name) {
          this.currentItem?.callbacks?.onToolUse?.(block.name, block.input ?? {});
        }
      }
    }

    if (json.type === 'result') {
      if (json.session_id) {
        this.sessionId = json.session_id;
      }

      // providerSessionIdをemit（sessions.tsへの後付け保存用）
      if (json.session_id) {
        this.emit('provider-session-id', json.session_id);
      }

      // トランスクリプトログ: 最終結果を記録
      const resultAppSessionId = this.currentItem?.options?.appSessionId || this.appSessionId;
      if (resultAppSessionId && this.workdir) {
        if (json.is_error) {
          logError(this.workdir, resultAppSessionId, this.formatClaudeError(json));
        } else {
          logResponse(this.workdir, resultAppSessionId, json as Record<string, unknown>);
        }
      }

      if (json.is_error) {
        // --resume で起動して失敗した場合、セッションが古い可能性が高い
        // セッションをクリアしてリトライする（1回だけ）
        const resumeId = this.resumeSessionId;
        if (resumeId) {
          console.warn(
            `[persistent-runner] Resume failed with session ${resumeId.slice(0, 8)}... Clearing stale session and retrying.`
          );
          const oldSessionId = resumeId;
          this.resumeSessionId = undefined;
          this.sessionId = '';
          this.emit('session-invalidated', this.channelId, oldSessionId);

          // プロセスをkillして新規セッションでリトライ
          if (this.process) {
            this.cancelling = true;
            this.process.kill();
            this.process = null;
            this.processAlive = false;
            this.buffer = '';
          }

          // 現在のリクエストをキューの先頭に戻してリトライ
          if (this.currentItem) {
            this.queue.unshift(this.currentItem);
            this.currentItem = null;
          }
          this.fullText = '';

          // cancelling フラグのクリアは close イベントで行われるが、
          // プロセスがまだ死んでいない場合に備えて直接 processNext を呼ぶ
          setTimeout(() => {
            this.cancelling = false;
            this.processNext();
          }, 100);
          return;
        }

        const error = new Error(this.formatClaudeError(json));
        this.currentItem?.callbacks?.onError?.(error);
        this.currentItem?.reject(error);
      } else {
        // ストリーミング中の累積テキストと最終 result をマージ
        // （ツール呼び出し前のテキストが result から消えるのを防ぐ）
        if (json.result) {
          this.fullText = mergeTexts(this.fullText, stripToolCallArtifacts(json.result));
        }

        const result: RunResult = {
          // 本文が空（strip 後に空 / モデルが本文を出さず end_turn）の場合は
          // 誤解を招く `✅` ではなく正直な fallback を返す
          result: finalizeDisplayText(this.fullText),
          sessionId: this.sessionId,
        };

        this.currentItem?.callbacks?.onComplete?.(result);
        this.currentItem?.resolve(result);
      }

      this.currentItem = null;
      this.fullText = '';

      // 次のリクエストを処理
      this.processNext();
    }
  }

  private formatClaudeError(json: { result?: string; error?: string; subtype?: string }): string {
    const detail = json.result || json.error;
    if (detail?.trim()) return detail.trim();
    return json.subtype
      ? `Claude Code returned error: ${json.subtype}`
      : 'Claude Code returned error';
  }

  /**
   * キューから次のリクエストを処理
   */
  private processNext(): void {
    if (this.currentItem || this.queue.length === 0) {
      return;
    }

    this.currentItem = this.queue.shift()!;
    this.fullText = '';

    // ensureProcess はサーキットブレーカーオープン時に throw する。
    // processNext は close イベントハンドラ等からも呼ばれるため、throw を
    // 伝播させると currentItem が reject されないまま宙吊りになる (issue #286)
    let proc: ChildProcess;
    try {
      proc = this.ensureProcess();
    } catch (err) {
      this.failCurrentItem(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // セッション継続のためのオプションを追加
    // runtime context (cwd/repo/container) を毎ターン prompt 先頭に prepend：
    // 常駐プロセスの --append-system-prompt は起動時固定なので、ここで注入する
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: prependRuntimeContext(sanitizeSurrogates(this.currentItem.prompt), this.workdir),
      },
    };

    console.log(`[persistent-runner] Sending request (queue: ${this.queue.length} remaining)`);

    // appSessionIdはリクエストのoptionsから取得（/new時に変わるため）
    const reqAppSessionId = this.currentItem.options?.appSessionId || this.appSessionId;

    // トランスクリプトログ: 送信プロンプトを記録
    if (reqAppSessionId && this.workdir) {
      logPrompt(this.workdir, reqAppSessionId, this.currentItem.prompt);
    }

    try {
      proc.stdin?.write(JSON.stringify(message) + '\n');
    } catch (err) {
      // stdin が既に閉じている (プロセス死亡直後など) 場合も Promise を settle させる
      this.failCurrentItem(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // タイムアウト設定: タイムアウト時はプロセスをkillして状態をクリーンに
    // timeoutAt / maxTimeoutAt をリソース化し、延長 API から張り替えできるようにする
    const now = Date.now();
    this.currentRequestStartedAt = now;
    this.currentTimeoutMs = this.timeoutMs;
    this.currentTimeoutAt = now + this.timeoutMs;
    this.currentMaxTimeoutAt = now + this.maxTimeoutMs;
    this.scheduleTimeout(this.timeoutMs);
    // 起動時イベント: web-chat や consumer 側 (xangi-pets 等) が「残り時間表示」を
    // 立てられるよう、channelId と timeoutAt をセットで知らせる
    this.emit('timeout-started', {
      channelId: this.channelId,
      timeoutAt: this.currentTimeoutAt,
      maxTimeoutAt: this.currentMaxTimeoutAt,
      timeoutMs: this.currentTimeoutMs,
    });

    // タイムアウトをクリアするためにresolve/rejectをラップ
    const originalResolve = this.currentItem.resolve;
    const originalReject = this.currentItem.reject;

    this.currentItem.resolve = (result) => {
      this.clearCurrentTimeout('completed');
      originalResolve(result);
    };

    this.currentItem.reject = (error) => {
      this.clearCurrentTimeout('rejected');
      originalReject(error);
    };
  }

  /**
   * 残り ms 後にタイムアウトを発火する setTimeout を張る。
   * 既存ハンドラがあれば必ず先に clearTimeout する。
   */
  private scheduleTimeout(remainingMs: number): void {
    if (this.currentTimeoutHandle) {
      clearTimeout(this.currentTimeoutHandle);
    }
    this.currentTimeoutHandle = setTimeout(() => {
      this.currentTimeoutHandle = null;
      if (this.currentItem) {
        console.warn(
          `[persistent-runner] Request timed out after ${this.currentTimeoutMs}ms. Killing process.`
        );
        const error = new Error(`Request timed out after ${this.currentTimeoutMs}ms`);
        this.currentItem.callbacks?.onError?.(error);
        this.currentItem.reject(error);
        this.currentItem = null;

        // タイムアウト時はプロセスをkillして次のリクエスト用に再起動
        // これにより、古いリクエストの出力が新しいリクエストに混ざるのを防ぐ
        if (this.process) {
          this.process.kill();
          this.process = null;
          this.processAlive = false;
          this.buffer = '';
        }

        this.emit('timeout-cleared', { channelId: this.channelId, reason: 'timeout' });
        this.resetTimeoutState();
        this.processNext();
      }
    }, remainingMs);
  }

  /**
   * タイムアウト状態をリセット (timeoutAt 等を 0 に)。
   * scheduleTimeout を呼び直す前にも使うので emit はしない。
   */
  private resetTimeoutState(): void {
    if (this.currentTimeoutHandle) {
      clearTimeout(this.currentTimeoutHandle);
      this.currentTimeoutHandle = null;
    }
    this.currentRequestStartedAt = 0;
    this.currentTimeoutAt = 0;
    this.currentMaxTimeoutAt = 0;
    this.currentTimeoutMs = 0;
  }

  /**
   * リクエスト完了/失敗時にタイムアウトをクリアし、`timeout-cleared` イベントを 1 回だけ emit する。
   * resolve/reject 両方から呼ばれるので、既に clear 済みなら no-op。
   */
  private clearCurrentTimeout(reason: 'completed' | 'rejected' | 'cancelled'): void {
    if (this.currentTimeoutHandle || this.currentTimeoutAt) {
      this.emit('timeout-cleared', { channelId: this.channelId, reason });
    }
    this.resetTimeoutState();
  }

  /**
   * 現在のタイムアウト状態を返す (UI 表示用)。
   * currentItem が null のときは active=false。
   *
   * AgentRunner interface との整合性のため channelId 引数を受けるが、
   * PersistentRunner は 1 ランナー = 1 チャンネル束縛なので参照しない。
   */
  getTimeoutState(_channelId?: string): TimeoutState {
    if (!this.currentItem || this.currentTimeoutAt === 0) {
      return { active: false };
    }
    return {
      active: true,
      timeoutAt: this.currentTimeoutAt,
      maxTimeoutAt: this.currentMaxTimeoutAt,
      remainingMs: Math.max(0, this.currentTimeoutAt - Date.now()),
      timeoutMs: this.currentTimeoutMs,
    };
  }

  /**
   * 現在のリクエストのタイムアウトを延長する。
   * 上限 (currentMaxTimeoutAt) を超える指定は 'max_timeout_exceeded' で拒否し、
   * 上限超過は起こらないので timeoutAt は上限まで切り詰めない (UI は 409 を見て disabled にする)。
   *
   * AgentRunner interface との整合性のため channelId 引数を受けるが、
   * PersistentRunner は 1 ランナー = 1 チャンネル束縛なので参照しない。
   */
  extendTimeout(_channelId: string | undefined, additionalMs?: number): ExtendTimeoutResult {
    if (!TIMEOUT_EXTEND_ENABLED) {
      return { ok: false, reason: 'unsupported' };
    }
    if (!this.currentItem || this.currentTimeoutAt === 0) {
      return { ok: false, reason: 'no_active_request' };
    }
    const currentRemaining = Math.max(0, this.currentTimeoutAt - Date.now());
    // additionalMs 省略時は残り時間を加算 → 結果として残り時間が 2 倍 (residual * 2)
    const ms = additionalMs ?? currentRemaining;
    if (!Number.isFinite(ms) || ms <= 0) {
      return { ok: false, reason: 'no_active_request' };
    }
    const requested = this.currentTimeoutAt + ms;
    if (requested > this.currentMaxTimeoutAt) {
      return {
        ok: false,
        reason: 'max_timeout_exceeded',
        maxTimeoutAt: this.currentMaxTimeoutAt,
      };
    }

    this.currentTimeoutAt = requested;
    this.currentTimeoutMs += ms;
    const remainingMs = Math.max(0, this.currentTimeoutAt - Date.now());
    this.scheduleTimeout(remainingMs);

    console.log(
      `[persistent-runner] Timeout extended by ${ms}ms ` +
        `(timeoutAt=${new Date(this.currentTimeoutAt).toISOString()}, remaining=${remainingMs}ms)`
    );

    this.emit('timeout-extended', {
      channelId: this.channelId,
      timeoutAt: this.currentTimeoutAt,
      maxTimeoutAt: this.currentMaxTimeoutAt,
      timeoutMs: this.currentTimeoutMs,
      remainingMs,
    });

    return {
      ok: true,
      timeoutAt: this.currentTimeoutAt,
      remainingMs,
      timeoutMs: this.currentTimeoutMs,
      maxTimeoutAt: this.currentMaxTimeoutAt,
    };
  }

  /**
   * リクエストを実行（キューに追加）
   */
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, options, resolve, reject });
      this.processNext();
    });
  }

  /**
   * ストリーミング実行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, options, callbacks, resolve, reject });
      this.processNext();
    });
  }

  /**
   * 現在処理中のリクエストをキャンセル
   * プロセス自体はkillして再起動（古い出力が混ざるのを防ぐ）
   */
  cancel(): boolean {
    if (!this.currentItem) {
      return false;
    }

    console.log('[persistent-runner] Cancelling current request');
    const error = new Error('Request cancelled by user');
    this.currentItem.callbacks?.onError?.(error);
    this.currentItem.reject(error);
    this.currentItem = null;
    this.fullText = '';

    // プロセスをkillして状態をクリーンにする（タイムアウト時と同じ戦略）
    // cancellingフラグでcloseイベントがクラッシュ扱いしないようにする
    if (this.process) {
      this.cancelling = true;
      this.process.kill();
      this.process = null;
      this.processAlive = false;
      this.buffer = '';
    } else {
      // プロセスがない場合はキューの次を直接処理
      this.processNext();
    }

    return true;
  }

  /**
   * プロセスを終了
   */
  shutdown(): void {
    // プロセスが無くても queue / currentItem は必ず reject する。
    // 「process が null のときに何もしない」と、待っている Promise が
    // 永久に settle しない (issue #286)
    this.shuttingDown = true;

    if (this.process) {
      console.log('[persistent-runner] Shutting down persistent process...');
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
      this.processAlive = false;
      this.buffer = '';
    }

    // キューに残っているリクエストをキャンセル
    for (const item of this.queue) {
      item.reject(new Error('Runner is shutting down'));
    }
    this.queue = [];

    this.failCurrentItem(new Error('Runner is shutting down'));
  }

  /**
   * 現在のセッションID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * セッションIDを設定（プロセス再起動時の --resume 用）
   */
  setSessionId(sessionId: string): void {
    this.resumeSessionId = sessionId;
    if (!this.sessionId) {
      this.sessionId = sessionId;
    }
  }

  /**
   * キューの長さ
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * プロセスが生きているか
   */
  isAlive(): boolean {
    return this.processAlive;
  }

  /**
   * リクエストを処理中（または待機中）か。
   * runner-manager のアイドル回収が「実行中の長時間ターン」を誤って
   * シャットダウンしないための判定に使う (issue #286)
   */
  isBusy(): boolean {
    return this.currentItem !== null || this.queue.length > 0;
  }

  /**
   * サーキットブレーカーの状態を取得
   */
  getCircuitBreakerStatus(): { open: boolean; crashCount: number; lastCrashTime: number } {
    const open =
      this.crashCount >= PersistentRunner.MAX_CRASHES &&
      Date.now() - this.lastCrashTime < PersistentRunner.CRASH_WINDOW_MS;
    return { open, crashCount: this.crashCount, lastCrashTime: this.lastCrashTime };
  }

  /**
   * サーキットブレーカーをリセット
   */
  resetCircuitBreaker(): void {
    this.crashCount = 0;
    this.lastCrashTime = 0;
    console.log('[persistent-runner] Circuit breaker manually reset');
  }
}
