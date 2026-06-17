import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import type {
  AgentRunner,
  RunOptions,
  RunResult,
  StreamCallbacks,
  TimeoutState,
  ExtendTimeoutResult,
} from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import { TimeoutController } from './timeout-controller.js';
import { buildCliEnv, clearManagedCliProcess, registerManagedCliProcess } from './cli-process.js';
import { appendJsonlChunk, flushJsonlBuffer } from './jsonl-buffer.js';
import type { BaseRunnerOptions } from './base-runner.js';

/**
 * JSONL ストリームをランナー固有のイベント解釈に変換するパーサ。
 * executeStreamCore() がリクエストごとに createStreamParser() で生成する。
 */
export interface CliStreamParser {
  /**
   * JSONL 1 行（JSON.parse 済み）を処理する。
   * phase='stream' は受信中、phase='flush' はプロセス終了後の残バッファ処理。
   * Error を返すと executeStreamCore() が onError 通知（notifyOnError に従う）の上で
   * 即 reject する。flush 中に返した Error は無視される。
   * パーサ側からは callbacks.onError を直接呼ばないこと（二重通知になる）。
   */
  handleEvent(json: unknown, phase: 'stream' | 'flush'): Error | undefined | void;
  /** 正常終了時の結果テキストとセッション ID を返す */
  finalize(): { result: string; sessionId: string };
  /** exit code != 0 のとき、エラーメッセージに添える詳細（CLI の error イベント本文など） */
  exitErrorDetail?(): string | undefined;
}

export interface ExecuteStreamOptions {
  channelId?: string;
  /**
   * エラー時に callbacks.onError を呼ぶか（default: true）。
   * セッション resume 失敗 → 新規セッションでリトライする一次試行では false にして、
   * リトライで成功するケースの誤エラー通知を抑制する。
   */
  notifyOnError?: boolean;
  /** 正常終了時、callbacks.onComplete の直前に呼ばれる（トランスクリプト記録など） */
  onComplete?: (result: RunResult) => void;
}

export interface CollectOutputOptions {
  /** exit code != 0 のとき stdout 全文からエラー詳細を抽出する（CLI の error イベント本文など） */
  exitErrorDetail?: (stdout: string) => string | undefined;
}

/**
 * ワンショット CLI ランナー（claude / codex / cursor-agent / grok）の共通基盤。
 *
 * spawn・プロセス登録・タイムアウト管理（TimeoutController + チャンネル無し時の
 * フォールバックタイマー）・JSONL バッファリング・exit エラー構築・
 * cancel / hasRunner / getTimeoutState / extendTimeout を一手に引き受ける。
 * 各ランナーは「コマンド引数の構築」と「イベント解釈（CliStreamParser）」だけを実装する。
 */
export abstract class CliRunnerBase extends EventEmitter implements AgentRunner {
  protected readonly model?: string;
  protected readonly timeoutMs: number;
  protected readonly workdir?: string;
  protected readonly skipPermissions: boolean;
  protected currentProcess: ChildProcess | null = null;
  /** チャンネル別タイムアウト管理（UI の延長 / 残り表示 / 自動 kill 連動） */
  protected readonly timeoutController: TimeoutController;
  /** 同時実行されている子プロセスを channelId で索く（並列セッション対応） */
  protected readonly activeProcesses = new Map<string, ChildProcess>();

  /** spawn する実行ファイル名（例: 'codex'） */
  protected abstract readonly command: string;
  /** エラーメッセージに使う表示名（例: 'Codex CLI'） */
  protected abstract readonly displayName: string;
  /** console ログの prefix（例: 'codex'） */
  protected abstract readonly logPrefix: string;

  constructor(options?: BaseRunnerOptions) {
    super();
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
    this.timeoutController = new TimeoutController({ baseTimeoutMs: this.timeoutMs });
    for (const evt of ['timeout-started', 'timeout-extended', 'timeout-cleared'] as const) {
      this.timeoutController.on(evt, (payload) => this.emit(evt, payload));
    }
  }

  abstract run(prompt: string, options?: RunOptions): Promise<RunResult>;
  abstract runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult>;

  /** runStream 用のイベントパーサを生成する */
  protected abstract createStreamParser(callbacks: StreamCallbacks): CliStreamParser;

  /** 子プロセス用の環境変数（runner 固有の追加があれば override） */
  protected buildEnv(channelId?: string): NodeJS.ProcessEnv {
    return buildCliEnv(channelId);
  }

  protected logExecution(kind: 'Executing' | 'Streaming', options?: RunOptions): void {
    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[${this.logPrefix}] ${kind} in ${this.workdir || 'default dir'}${sessionInfo}`);
  }

  /**
   * exit code != 0 時のエラーを組み立てる。
   * CLI の error イベント本文 > stderr > exit code のみ、の優先順位で
   * できるだけ具体的な理由をユーザーに見せる。
   */
  protected buildExitError(code: number | null, detail?: string, stderr?: string): Error {
    const base = `${this.displayName} exited with code ${code}`;
    if (detail?.trim()) {
      return new Error(`${base}: ${detail.trim()}`);
    }
    if (stderr?.trim()) {
      return new Error(`${base}: ${stderr.trim()}`);
    }
    return new Error(base);
  }

  /**
   * channelId が無いリクエストは TimeoutController の管理対象外になるため、
   * 固定タイマーでフォールバックする（タイムアウト時はプロセスを kill して通知）。
   */
  private startFallbackTimeout(
    proc: ChildProcess,
    channelId: string | undefined,
    onTimeout: (err: Error) => void
  ): NodeJS.Timeout | undefined {
    if (channelId) return undefined;
    return setTimeout(() => {
      proc.kill();
      onTimeout(new Error(`${this.displayName} timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
  }

  private finishProcess(
    proc: ChildProcess,
    channelId: string | undefined,
    fallbackTimer: NodeJS.Timeout | undefined,
    status: 'completed' | 'error'
  ): void {
    if (this.currentProcess === proc) {
      this.currentProcess = null;
    }
    if (fallbackTimer) clearTimeout(fallbackTimer);
    clearManagedCliProcess(channelId, this.activeProcesses, this.timeoutController, status);
  }

  /**
   * 非ストリーミング実行: stdout を全部集めて返す。
   * exit code != 0 なら buildExitError で reject する。
   */
  protected collectOutput(
    args: string[],
    channelId?: string,
    opts: CollectOutputOptions = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
        env: this.buildEnv(channelId),
      });
      this.currentProcess = proc;
      registerManagedCliProcess(channelId, proc, this.activeProcesses, this.timeoutController);
      const fallbackTimer = this.startFallbackTimeout(proc, channelId, reject);

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        this.finishProcess(proc, channelId, fallbackTimer, code === 0 ? 'completed' : 'error');

        if (code !== 0) {
          reject(this.buildExitError(code, opts.exitErrorDetail?.(stdout), stderr));
          return;
        }

        resolve(stdout);
      });

      proc.on('error', (err) => {
        this.finishProcess(proc, channelId, fallbackTimer, 'error');
        reject(new Error(`Failed to spawn ${this.displayName}: ${err.message}`));
      });
    });
  }

  /**
   * ストリーミング実行: JSONL を逐次パースして CliStreamParser に流す。
   * エラー通知（callbacks.onError）はここで一元管理する。
   */
  protected executeStreamCore(
    args: string[],
    callbacks: StreamCallbacks,
    opts: ExecuteStreamOptions = {}
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const parser = this.createStreamParser(callbacks);
      const proc = spawn(this.command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
        env: this.buildEnv(opts.channelId),
      });
      this.currentProcess = proc;
      registerManagedCliProcess(opts.channelId, proc, this.activeProcesses, this.timeoutController);

      let buffer = '';
      let stderr = '';
      let fatalError: Error | null = null;

      const notifyError = (error: Error) => {
        if (opts.notifyOnError !== false) {
          callbacks.onError?.(error);
        }
      };

      const fallbackTimer = this.startFallbackTimeout(proc, opts.channelId, (err) => {
        notifyError(err);
        reject(err);
      });

      const processLine = (line: string, phase: 'stream' | 'flush') => {
        if (fatalError) return;
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          return; // JSONパースエラーは無視
        }
        const result = parser.handleEvent(json, phase);
        if (result instanceof Error && phase === 'stream') {
          fatalError = result;
          notifyError(result);
          reject(result);
        }
      };

      proc.stdout?.on('data', (data) => {
        const parsed = appendJsonlChunk(buffer, data.toString());
        buffer = parsed.buffer;
        for (const line of parsed.lines) {
          processLine(line, 'stream');
        }
      });

      proc.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        console.error(`[${this.logPrefix}] stderr:`, chunk);
      });

      proc.on('close', (code) => {
        this.finishProcess(proc, opts.channelId, fallbackTimer, code === 0 ? 'completed' : 'error');

        // 残りのバッファを処理
        for (const line of flushJsonlBuffer(buffer)) {
          processLine(line, 'flush');
        }

        if (fatalError) return; // 既に reject 済み

        if (code !== 0) {
          const error = this.buildExitError(code, parser.exitErrorDetail?.(), stderr);
          notifyError(error);
          reject(error);
          return;
        }

        const { result, sessionId } = parser.finalize();
        const runResult: RunResult = { result, sessionId };
        opts.onComplete?.(runResult);
        callbacks.onComplete?.(runResult);
        resolve(runResult);
      });

      proc.on('error', (err) => {
        this.finishProcess(proc, opts.channelId, fallbackTimer, 'error');
        const error = new Error(`Failed to spawn ${this.displayName}: ${err.message}`);
        notifyError(error);
        reject(error);
      });
    });
  }

  /**
   * 現在処理中のリクエストをキャンセル
   */
  cancel(channelId?: string): boolean {
    if (channelId) {
      const proc = this.activeProcesses.get(channelId);
      if (proc) {
        console.log(`[${this.logPrefix}] Cancelling request for channel ${channelId}`);
        proc.kill();
        this.activeProcesses.delete(channelId);
        this.timeoutController.clear(channelId, 'error');
        return true;
      }
      return false;
    }
    if (!this.currentProcess) {
      return false;
    }
    console.log(`[${this.logPrefix}] Cancelling current request`);
    this.currentProcess.kill();
    this.currentProcess = null;
    return true;
  }

  hasRunner(channelId: string): boolean {
    return this.activeProcesses.has(channelId);
  }

  getTimeoutState(channelId?: string): TimeoutState {
    if (!channelId) return { active: false };
    return this.timeoutController.getState(channelId);
  }

  extendTimeout(channelId: string | undefined, additionalMs?: number): ExtendTimeoutResult {
    if (!channelId) return { ok: false, reason: 'no_active_request' };
    return this.timeoutController.extend(channelId, additionalMs);
  }
}
