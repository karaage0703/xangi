import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import type { RunOptions, RunResult, StreamCallbacks, AgentRunner } from './agent-runner.js';
import { mergeTexts } from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';

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
  private workdir?: string;
  private skipPermissions: boolean;
  private systemPrompt: string;

  constructor(options?: {
    model?: string;
    timeoutMs?: number;
    workdir?: string;
    skipPermissions?: boolean;
  }) {
    super();
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
    this.systemPrompt = this.buildSystemPrompt();
  }

  /**
   * システムプロンプトを構築
   */
  private buildSystemPrompt(): string {
    const basePrompt = `あなたはチャットプラットフォーム（Discord/Slack）経由で会話しています。

## セッション継続
このセッションは常駐プロセスで実行されています。セッション内の会話履歴は保持されます。

## 必須コマンド
### 別チャンネルにメッセージ送信
!discord send <#チャンネルID> メッセージ内容

### ファイル送信
MEDIA:/path/to/file

### スケジューラー
!schedule list
!schedule 30分後 会議の準備
!schedule remove 1`;

    if (!this.workdir) return basePrompt;

    // Project Context を読み込み
    const files = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md', 'MEMORY.md'];
    let context = '';

    for (const file of files) {
      const filePath = join(this.workdir, file);
      if (!existsSync(filePath)) continue;

      try {
        const content = readFileSync(filePath, 'utf-8');
        context += `\n\n## ${file}\n\n${content}`;
      } catch {
        // ignore
      }
    }

    return basePrompt + context;
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
      // クールダウン経過後はリセット
      console.log('[persistent-runner] Circuit breaker reset after cooldown');
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

    if (this.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    args.push('--append-system-prompt', this.systemPrompt);

    console.log('[persistent-runner] Starting persistent process...');

    this.process = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.workdir,
    });
    this.processAlive = true;

    this.process.stdout?.on('data', (data) => this.handleOutput(data.toString()));
    this.process.stderr?.on('data', (data) => {
      console.error('[persistent-runner] stderr:', data.toString());
    });

    this.process.on('close', (code) => {
      console.log(`[persistent-runner] Process exited with code ${code}`);
      const wasShuttingDown = this.shuttingDown;
      this.process = null;
      this.processAlive = false;
      this.buffer = ''; // バッファをクリア

      // シャットダウン中またはキャンセル中なら正常終了
      if (wasShuttingDown) {
        return;
      }
      if (this.cancelling) {
        this.cancelling = false;
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
      if (this.currentItem) {
        this.currentItem.reject(new Error(`Process exited unexpectedly with code ${code}`));
        this.currentItem = null;
      }

      // サーキットブレーカーがオープンでなければ再処理
      if (this.queue.length > 0 && this.crashCount < PersistentRunner.MAX_CRASHES) {
        console.log('[persistent-runner] Restarting process for queued requests...');
        this.processNext();
      } else if (this.crashCount >= PersistentRunner.MAX_CRASHES) {
        // サーキットブレーカーオープン: キューを全部エラーにする
        console.error('[persistent-runner] Circuit breaker OPEN. Rejecting all queued requests.');
        for (const item of this.queue) {
          item.reject(new Error('Circuit breaker open: too many process crashes'));
        }
        this.queue = [];
      }
    });

    this.process.on('error', (err) => {
      console.error('[persistent-runner] Process error:', err);
      this.process = null;
      this.processAlive = false;

      if (this.currentItem) {
        this.currentItem.reject(err);
        this.currentItem = null;
      }
    });

    return this.process;
  }

  /**
   * stdout からの出力を処理
   */
  private handleOutput(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

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
    session_id?: string;
    message?: { content?: Array<{ type: string; text?: string }> };
    result?: string;
    is_error?: boolean;
  }): void {
    if (json.type === 'system' && json.session_id) {
      this.sessionId = json.session_id;
      console.log(`[persistent-runner] Session initialized: ${this.sessionId.slice(0, 8)}...`);
    }

    if (json.type === 'assistant' && json.message?.content) {
      for (const block of json.message.content) {
        if (block.type === 'text' && block.text) {
          this.fullText += block.text;
          this.currentItem?.callbacks?.onText?.(block.text, this.fullText);
        }
      }
    }

    if (json.type === 'result') {
      if (json.session_id) {
        this.sessionId = json.session_id;
      }

      if (json.is_error) {
        const error = new Error(json.result || 'Unknown error');
        this.currentItem?.callbacks?.onError?.(error);
        this.currentItem?.reject(error);
      } else {
        // ストリーミング中の累積テキストと最終 result をマージ
        // （ツール呼び出し前のテキストが result から消えるのを防ぐ）
        if (json.result) {
          this.fullText = mergeTexts(this.fullText, json.result);
        }

        const result: RunResult = {
          result: this.fullText,
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

  /**
   * キューから次のリクエストを処理
   */
  private processNext(): void {
    if (this.currentItem || this.queue.length === 0) {
      return;
    }

    this.currentItem = this.queue.shift()!;
    this.fullText = '';

    const proc = this.ensureProcess();

    // セッション継続のためのオプションを追加
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: this.currentItem.prompt,
      },
    };

    console.log(`[persistent-runner] Sending request (queue: ${this.queue.length} remaining)`);
    proc.stdin?.write(JSON.stringify(message) + '\n');

    // タイムアウト設定: タイムアウト時はプロセスをkillして状態をクリーンに
    const timeout = setTimeout(() => {
      if (this.currentItem) {
        console.warn(
          `[persistent-runner] Request timed out after ${this.timeoutMs}ms. Killing process.`
        );
        const error = new Error(`Request timed out after ${this.timeoutMs}ms`);
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

        this.processNext();
      }
    }, this.timeoutMs);

    // タイムアウトをクリアするためにresolve/rejectをラップ
    const originalResolve = this.currentItem.resolve;
    const originalReject = this.currentItem.reject;

    this.currentItem.resolve = (result) => {
      clearTimeout(timeout);
      originalResolve(result);
    };

    this.currentItem.reject = (error) => {
      clearTimeout(timeout);
      originalReject(error);
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
    if (this.process) {
      console.log('[persistent-runner] Shutting down persistent process...');
      this.shuttingDown = true;
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
      this.processAlive = false;
      this.buffer = '';

      // キューに残っているリクエストをキャンセル
      for (const item of this.queue) {
        item.reject(new Error('Runner is shutting down'));
      }
      this.queue = [];

      if (this.currentItem) {
        this.currentItem.reject(new Error('Runner is shutting down'));
        this.currentItem = null;
      }
    }
  }

  /**
   * 現在のセッションID
   */
  getSessionId(): string {
    return this.sessionId;
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
