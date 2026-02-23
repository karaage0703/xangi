import { spawn } from 'child_process';
import { processManager } from './process-manager.js';
import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { mergeTexts } from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import { buildSystemPrompt } from './base-runner.js';

export interface ClaudeCodeOptions {
  model?: string;
  effort?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
  chrome?: boolean;
}

interface ClaudeCodeResponse {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
}

/**
 * Claude Code CLI を実行するランナー
 */
export class ClaudeCodeRunner {
  private model?: string;
  private effort?: string;
  private timeoutMs: number;
  private workdir?: string;
  private skipPermissions: boolean;
  private chrome: boolean;
  private systemPrompt: string;

  constructor(options?: ClaudeCodeOptions) {
    this.model = options?.model;
    this.effort = options?.effort;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS; // デフォルト5分
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
    this.chrome = options?.chrome ?? false;
    this.systemPrompt = buildSystemPrompt();
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const args: string[] = ['-p', '--output-format', 'json'];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      args.push('--dangerously-skip-permissions');
    }

    // セッション継続
    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.effort) {
      args.push('--effort', this.effort);
    }

    if (this.chrome) {
      args.push('--chrome');
    }

    // チャットプラットフォーム連携のシステムプロンプト + AGENTS.md
    args.push('--append-system-prompt', this.systemPrompt);

    args.push(prompt);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[claude-code] Executing in ${this.workdir || 'default dir'}${sessionInfo}`);

    const result = await this.execute(args, options?.channelId);
    const response = this.parseResponse(result);

    return {
      result: response.result,
      sessionId: response.session_id,
    };
  }

  private execute(args: string[], channelId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
      });

      // プロセスマネージャーに登録
      if (channelId) {
        processManager.register(channelId, proc);
      }

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error(`Claude Code CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          reject(new Error(`Claude Code CLI exited with code ${code}: ${stderr}`));
          return;
        }

        resolve(stdout);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn Claude Code CLI: ${err.message}`));
      });
    });
  }

  private parseResponse(output: string): ClaudeCodeResponse {
    try {
      const response = JSON.parse(output.trim()) as ClaudeCodeResponse;

      if (response.is_error) {
        throw new Error(`Claude Code CLI returned error: ${response.result}`);
      }

      return response;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Failed to parse Claude Code CLI response: ${output}`);
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
    const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      args.push('--dangerously-skip-permissions');
    }

    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.effort) {
      args.push('--effort', this.effort);
    }

    if (this.chrome) {
      args.push('--chrome');
    }

    // チャットプラットフォーム連携のシステムプロンプト + AGENTS.md
    args.push('--append-system-prompt', this.systemPrompt);

    args.push(prompt);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[claude-code] Streaming in ${this.workdir || 'default dir'}${sessionInfo}`);

    return this.executeStream(args, callbacks, options?.channelId);
  }

  private executeStream(
    args: string[],
    callbacks: StreamCallbacks,
    channelId?: string
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
      });

      // プロセスマネージャーに登録
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
            const json = JSON.parse(line);
            if (json.type === 'assistant' && json.message?.content) {
              for (const block of json.message.content) {
                if (block.type === 'text') {
                  fullText += block.text;
                  callbacks.onText?.(block.text, fullText);
                }
              }
            } else if (json.type === 'result') {
              sessionId = json.session_id;
              if (json.is_error) {
                const error = new Error(json.result);
                callbacks.onError?.(error);
                reject(error);
                return;
              }
              // ストリーミング中の累積テキストと最終 result をマージ
              // （ツール呼び出し前のテキストが result から消えるのを防ぐ）
              if (json.result) {
                fullText = mergeTexts(fullText, json.result);
              }
            }
          } catch {
            // JSONパースエラーは無視
          }
        }
      });

      proc.stderr.on('data', (data) => {
        console.error('[claude-code] stderr:', data.toString());
      });

      const timeout = setTimeout(() => {
        proc.kill();
        const error = new Error(`Claude Code CLI timed out after ${this.timeoutMs}ms`);
        callbacks.onError?.(error);
        reject(error);
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);

        // 残りのバッファを処理
        if (buffer.trim()) {
          try {
            const json = JSON.parse(buffer);
            if (json.type === 'assistant' && json.message?.content) {
              for (const block of json.message.content) {
                if (block.type === 'text') {
                  fullText += block.text;
                }
              }
            } else if (json.type === 'result') {
              sessionId = json.session_id;
              // ストリーミング中の累積テキストと最終 result をマージ
              if (json.result) {
                fullText = mergeTexts(fullText, json.result);
              }
            }
          } catch {
            // JSONパースエラーは無視
          }
        }

        if (code !== 0) {
          const error = new Error(`Claude Code CLI exited with code ${code}`);
          callbacks.onError?.(error);
          reject(error);
          return;
        }

        const result: RunResult = { result: fullText, sessionId };
        callbacks.onComplete?.(result);
        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        const error = new Error(`Failed to spawn Claude Code CLI: ${err.message}`);
        callbacks.onError?.(error);
        reject(error);
      });
    });
  }
}
