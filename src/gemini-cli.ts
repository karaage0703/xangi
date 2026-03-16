import { spawn, ChildProcess } from 'child_process';
import { processManager } from './process-manager.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { logPrompt, logResponse } from './transcript-logger.js';

/**
 * Gemini CLI の JSON 出力形式
 */
interface GeminiJsonResponse {
  session_id: string;
  response: string;
  stats?: {
    models?: Record<string, unknown>;
  };
}

/**
 * Gemini CLI の stream-json イベント形式
 */
interface GeminiStreamEvent {
  type: 'init' | 'message' | 'result';
  timestamp?: string;
  session_id?: string;
  role?: 'user' | 'assistant';
  content?: string;
  delta?: boolean;
  status?: 'success' | 'error';
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
}

/**
 * Gemini CLI を実行するランナー
 */
export class GeminiRunner implements AgentRunner {
  private model?: string;
  private timeoutMs: number;
  private workdir?: string;
  private skipPermissions: boolean;
  private currentProcess: ChildProcess | null = null;

  constructor(options?: BaseRunnerOptions) {
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
    // Gemini CLIはGEMINI.mdを自動読み込みするため、xangi側でのシステムプロンプト注入は不要
  }

  /**
   * コマンド引数を構築（run/runStream 共通部分）
   */
  private buildBaseArgs(options?: RunOptions): string[] {
    const args: string[] = [];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      args.push('--yolo');
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    // セッション継続
    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }

    return args;
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const fullPrompt = prompt;
    const args = [
      ...this.buildBaseArgs(options),
      '--prompt',
      fullPrompt,
      '--output-format',
      'json',
    ];

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[gemini] Executing in ${this.workdir || 'default dir'}${sessionInfo}`);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.channelId && this.workdir) {
      logPrompt(this.workdir, options.channelId, fullPrompt, options?.sessionId);
    }

    try {
      const { stdout, sessionId } = await this.execute(args, options?.channelId);
      const response = this.parseJsonResponse(stdout);

      // トランスクリプトログ: 応答を記録
      if (options?.channelId && this.workdir) {
        logResponse(this.workdir, options.channelId, {
          result: response.response,
          sessionId: sessionId || response.session_id,
        });
      }

      return {
        result: response.response,
        sessionId: sessionId || response.session_id,
      };
    } catch (err) {
      // セッションresume失敗時は新規セッションでリトライ
      if (options?.sessionId && err instanceof Error && err.message.includes('exited with code')) {
        console.warn(`[gemini] Session resume failed, retrying without session: ${err.message}`);
        const retryArgs = [
          ...this.buildBaseArgs({ ...options, sessionId: undefined }),
          '--prompt',
          fullPrompt,
          '--output-format',
          'json',
        ];
        const { stdout, sessionId } = await this.execute(retryArgs, options?.channelId);
        const response = this.parseJsonResponse(stdout);

        // トランスクリプトログ: リトライ応答を記録
        if (options?.channelId && this.workdir) {
          logResponse(this.workdir, options.channelId, {
            result: response.response,
            sessionId: sessionId || response.session_id,
          });
        }

        return {
          result: response.response,
          sessionId: sessionId || response.session_id,
        };
      }
      throw err;
    }
  }

  private execute(
    args: string[],
    channelId?: string
  ): Promise<{ stdout: string; sessionId: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('gemini', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
      });
      this.currentProcess = proc;

      if (channelId) {
        processManager.register(channelId, proc);
      }

      let stdout = '';
      let stderr = '';
      let sessionId = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        reject(new Error(`Gemini CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        if (code !== 0) {
          reject(new Error(`Gemini CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // JSON出力からsession_idを抽出
        try {
          const json = JSON.parse(stdout.trim()) as GeminiJsonResponse;
          sessionId = json.session_id;
        } catch {
          // パースできなくてもstdoutはそのまま返す
        }

        resolve({ stdout, sessionId });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        reject(new Error(`Failed to spawn Gemini CLI: ${err.message}`));
      });
    });
  }

  private parseJsonResponse(output: string): GeminiJsonResponse {
    try {
      return JSON.parse(output.trim()) as GeminiJsonResponse;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Failed to parse Gemini CLI response: ${output}`);
      }
      throw err;
    }
  }

  /**
   * ストリーミング実行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const fullPrompt = prompt;
    const args = [
      ...this.buildBaseArgs(options),
      '--prompt',
      fullPrompt,
      '--output-format',
      'stream-json',
    ];

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[gemini] Streaming in ${this.workdir || 'default dir'}${sessionInfo}`);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.channelId && this.workdir) {
      logPrompt(this.workdir, options.channelId, fullPrompt, options?.sessionId);
    }

    try {
      return await this.executeStream(args, callbacks, options?.channelId);
    } catch (err) {
      // セッションresume失敗時は新規セッションでリトライ
      if (options?.sessionId && err instanceof Error && err.message.includes('exited with code')) {
        console.warn(`[gemini] Session resume failed, retrying without session: ${err.message}`);
        const retryArgs = [
          ...this.buildBaseArgs({ ...options, sessionId: undefined }),
          '--prompt',
          fullPrompt,
          '--output-format',
          'stream-json',
        ];
        return this.executeStream(retryArgs, callbacks, options?.channelId);
      }
      throw err;
    }
  }

  private executeStream(
    args: string[],
    callbacks: StreamCallbacks,
    channelId?: string
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn('gemini', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
      });
      this.currentProcess = proc;

      if (channelId) {
        processManager.register(channelId, proc);
      }

      let fullText = '';
      let sessionId = '';
      let buffer = '';

      proc.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line) as GeminiStreamEvent;

            // セッションID取得（initイベントで返る）
            if (json.type === 'init' && json.session_id) {
              sessionId = json.session_id;
            }

            // アシスタントのメッセージ（delta）
            if (json.type === 'message' && json.role === 'assistant' && json.content) {
              fullText += json.content;
              callbacks.onText?.(json.content, fullText);
            }

            // 結果
            if (json.type === 'result') {
              if (json.session_id) {
                sessionId = json.session_id;
              }
              if (json.status === 'error') {
                const error = new Error('Gemini CLI returned error');
                callbacks.onError?.(error);
                reject(error);
                return;
              }
              // トークン使用量ログ
              if (json.stats) {
                console.log(
                  `[gemini] Usage: input=${json.stats.input_tokens ?? 0}, output=${json.stats.output_tokens ?? 0}, cached=${json.stats.cached ?? 0}, duration=${json.stats.duration_ms ?? 0}ms`
                );
              }
            }
          } catch {
            // JSONパースエラーは無視
          }
        }
      });

      proc.stderr.on('data', (data) => {
        console.error('[gemini] stderr:', data.toString());
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        const error = new Error(`Gemini CLI timed out after ${this.timeoutMs}ms`);
        callbacks.onError?.(error);
        reject(error);
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        // 残りのバッファを処理
        if (buffer.trim()) {
          try {
            const json = JSON.parse(buffer) as GeminiStreamEvent;
            if (json.type === 'init' && json.session_id) {
              sessionId = json.session_id;
            }
            if (json.type === 'message' && json.role === 'assistant' && json.content) {
              fullText += json.content;
            }
            if (json.type === 'result' && json.session_id) {
              sessionId = json.session_id;
            }
          } catch {
            // JSONパースエラーは無視
          }
        }

        if (code !== 0) {
          const error = new Error(`Gemini CLI exited with code ${code}`);
          callbacks.onError?.(error);
          reject(error);
          return;
        }

        const result: RunResult = { result: fullText, sessionId };

        // トランスクリプトログ: 応答を記録
        if (channelId && this.workdir) {
          logResponse(this.workdir, channelId, { result: fullText, sessionId });
        }

        callbacks.onComplete?.(result);
        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        const error = new Error(`Failed to spawn Gemini CLI: ${err.message}`);
        callbacks.onError?.(error);
        reject(error);
      });
    });
  }

  /**
   * 現在処理中のリクエストをキャンセル
   */
  cancel(): boolean {
    if (!this.currentProcess) {
      return false;
    }

    console.log('[gemini] Cancelling current request');
    this.currentProcess.kill();
    this.currentProcess = null;
    return true;
  }
}
