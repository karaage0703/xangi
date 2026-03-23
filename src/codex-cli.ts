import { spawn, ChildProcess } from 'child_process';
import { processManager } from './process-manager.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import { buildSystemPrompt } from './base-runner.js';
import type { ChatPlatform } from './config.js';
import { logPrompt, logResponse } from './transcript-logger.js';

export interface CodexOptions {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
  platform?: ChatPlatform;
}

/**
 * Codex CLI 0.98.0 の JSONL イベント型定義
 */
interface CodexEvent {
  type: string;
  thread_id?: string;
  session_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  // フォールバック用
  content?: string;
  result?: string;
}

/**
 * Codex CLI を実行するランナー（0.98.0 対応）
 */
export class CodexRunner implements AgentRunner {
  private model?: string;
  private timeoutMs: number;
  private workdir?: string;
  private skipPermissions: boolean;
  private systemPrompt: string;
  private currentProcess: ChildProcess | null = null;

  constructor(options?: CodexOptions) {
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
    this.systemPrompt = buildSystemPrompt(options?.platform);
  }

  /**
   * コマンド引数を構築（run/runStream 共通）
   */
  private buildArgs(prompt: string, options?: RunOptions): string[] {
    const args: string[] = ['exec', '--json'];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--full-auto');
    }

    // gitリポジトリ外でも動作するように
    args.push('--skip-git-repo-check');

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.workdir) {
      args.push('--cd', this.workdir);
    }

    // セッション継続（--cd, --model等のオプションはresumeサブコマンドの前に置く必要がある）
    if (options?.sessionId) {
      args.push('resume', options.sessionId);
    }

    // システムプロンプトをプロンプトに注入
    const fullPrompt = this.systemPrompt
      ? `<system-context>\n${this.systemPrompt}\n</system-context>\n\n${prompt}`
      : prompt;

    args.push(fullPrompt);

    return args;
  }

  /**
   * JSONL 行からセッション ID を抽出
   */
  private extractSessionId(json: CodexEvent): string | undefined {
    // Codex 0.98.0 は thread.started イベントで thread_id を返す
    if (json.type === 'thread.started' && json.thread_id) {
      return json.thread_id;
    }
    // フォールバック
    if (json.thread_id) return json.thread_id;
    if (json.session_id) return json.session_id;
    return undefined;
  }

  /**
   * JSONL 行からテキストを抽出
   */
  private extractText(json: CodexEvent): { text: string; isComplete: boolean } | null {
    // agent_message の完了 — 最終的な回答テキスト
    if (json.type === 'item.completed' && json.item?.type === 'agent_message' && json.item.text) {
      return { text: json.item.text, isComplete: true };
    }
    // フォールバック: message イベント
    if (json.type === 'message' && json.content) {
      return { text: json.content, isComplete: true };
    }
    // フォールバック: result フィールド
    if (json.result) {
      return { text: json.result, isComplete: true };
    }
    return null;
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(prompt, options);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[codex] Executing in ${this.workdir || 'default dir'}${sessionInfo}`);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.channelId && this.workdir) {
      logPrompt(this.workdir, options.channelId, prompt, options?.sessionId);
    }

    const { stdout, sessionId } = await this.execute(args, options?.channelId);
    const result = this.extractResult(stdout);

    // トランスクリプトログ: 応答を記録
    if (options?.channelId && this.workdir) {
      logResponse(this.workdir, options.channelId, { result, sessionId });
    }

    return { result, sessionId };
  }

  private execute(
    args: string[],
    channelId?: string
  ): Promise<{ stdout: string; sessionId: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('codex', args, {
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
        const chunk = data.toString();
        stdout += chunk;

        const lines = chunk.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line) as CodexEvent;
            const sid = this.extractSessionId(json);
            if (sid) sessionId = sid;
          } catch {
            // JSONパースエラーは無視
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        reject(new Error(`Codex CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        if (code !== 0) {
          reject(new Error(`Codex CLI exited with code ${code}: ${stderr}`));
          return;
        }

        resolve({ stdout, sessionId });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
      });
    });
  }

  private extractResult(output: string): string {
    const lines = output.trim().split('\n');
    const messageParts: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line) as CodexEvent;
        const extracted = this.extractText(json);
        if (extracted) {
          if (extracted.isComplete) {
            messageParts.push(extracted.text);
          }
        }
      } catch {
        // JSONパースエラーは無視
      }
    }

    // 最後の agent_message を使用（複数ターンの場合）
    return messageParts.length > 0 ? messageParts[messageParts.length - 1] : output;
  }

  /**
   * ストリーミング実行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const args = this.buildArgs(prompt, options);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[codex] Streaming in ${this.workdir || 'default dir'}${sessionInfo}`);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.channelId && this.workdir) {
      logPrompt(this.workdir, options.channelId, prompt, options?.sessionId);
    }

    return this.executeStream(args, callbacks, options?.channelId);
  }

  private executeStream(
    args: string[],
    callbacks: StreamCallbacks,
    channelId?: string
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn('codex', args, {
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
            const json = JSON.parse(line) as CodexEvent;

            // セッションID抽出
            const sid = this.extractSessionId(json);
            if (sid) sessionId = sid;

            // テキスト抽出
            const extracted = this.extractText(json);
            if (extracted) {
              fullText = extracted.text;
              callbacks.onText?.(extracted.text, fullText);
            }

            // トークン使用量ログ
            if (json.type === 'turn.completed' && json.usage) {
              console.log(
                `[codex] Usage: input=${json.usage.input_tokens} (cached=${json.usage.cached_input_tokens ?? 0}), output=${json.usage.output_tokens}`
              );
            }
          } catch {
            // JSONパースエラーは無視
          }
        }
      });

      proc.stderr.on('data', (data) => {
        console.error('[codex] stderr:', data.toString());
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        const error = new Error(`Codex CLI timed out after ${this.timeoutMs}ms`);
        callbacks.onError?.(error);
        reject(error);
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        // 残りのバッファを処理
        if (buffer.trim()) {
          try {
            const json = JSON.parse(buffer) as CodexEvent;
            const sid = this.extractSessionId(json);
            if (sid) sessionId = sid;
            const extracted = this.extractText(json);
            if (extracted) {
              fullText = extracted.text;
            }
          } catch {
            // JSONパースエラーは無視
          }
        }

        if (code !== 0) {
          const error = new Error(`Codex CLI exited with code ${code}`);
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
        const error = new Error(`Failed to spawn Codex CLI: ${err.message}`);
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

    console.log('[codex] Cancelling current request');
    this.currentProcess.kill();
    this.currentProcess = null;
    return true;
  }
}
