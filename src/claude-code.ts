import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { processManager } from './process-manager.js';
import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { mergeTexts } from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';

// チャットプラットフォーム連携用のシステムプロンプト
const CHAT_SYSTEM_PROMPT = `あなたはチャットプラットフォーム（Discord/Slack）経由で会話しています。

## セッション継続
このセッションは --resume オプションで継続されています。過去の会話履歴は保持されているので、直前の会話内容を覚えています。「再起動したから覚えていない」とは言わないでください。

## チャンネルID
ユーザーのメッセージに <#1234567890> 形式があれば、それがチャンネルID。
例: <#1469606785672417383> → チャンネルID は 1469606785672417383

## 必須コマンド

### 別チャンネルにメッセージ送信
「〇〇チャンネルに△△って言って」と頼まれたら、必ずこのコマンドを出力すること：
!discord send <#チャンネルID> メッセージ内容

例: !discord send <#1469606785672417383> hello!

### ファイル送信
MEDIA:/path/to/file

### スケジューラー（リマインダー・定期実行）
**重要**: 「スケジュール追加して」「毎日〇〇時に△△して」「リマインダー設定して」と言われたら、必ず !schedule コマンドを使うこと。カレンダースキルではない！

一覧表示：
!schedule list

追加（必ずこの形式で出力）：
!schedule 30分後 会議の準備
!schedule 毎日 8:00 ラジオ体操
!schedule 毎週月曜 10:00 週次MTG
!schedule 起動時 ウェルカムメッセージを送る

削除（番号で指定）：
!schedule remove 1
!schedule remove 1 2 3

## セッション開始時
CLAUDE.md を読み、指示に従うこと（AGENTS.md 等の参照含む）。
xangi専用コマンドは XANGI_COMMANDS.md を参照。

## システムコマンド（応答に含めると実行される）

### 再起動
\`\`\`
SYSTEM_COMMAND:restart
\`\`\`
「再起動して」と言われたらこれを応答に含める。Docker環境でも動作する。

### 設定変更
\`\`\`
SYSTEM_COMMAND:set autoRestart=true
SYSTEM_COMMAND:set autoRestart=false
\`\`\`
autoRestartが有効な場合のみ再起動が実行される。`;

export interface ClaudeCodeOptions {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
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
  private timeoutMs: number;
  private workdir?: string;
  private skipPermissions: boolean;

  constructor(options?: ClaudeCodeOptions) {
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS; // デフォルト5分
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
  }

  /**
   * ワークスペースからProject Context用のファイルを読み込む
   */
  private loadProjectContext(): string {
    if (!this.workdir) return '';

    const files = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md', 'MEMORY.md'];
    let context = '';

    for (const file of files) {
      const filePath = join(this.workdir, file);
      if (!existsSync(filePath)) continue;

      try {
        const content = readFileSync(filePath, 'utf-8');
        console.log(`[claude-code] Loaded ${file} (${content.length} bytes)`);
        context += `\n\n## ${file}\n\n${content}`;
      } catch (err) {
        console.error(`[claude-code] Failed to load ${file}:`, err);
      }
    }

    return context;
  }

  /**
   * 完全なシステムプロンプトを生成
   */
  private getFullSystemPrompt(): string {
    return CHAT_SYSTEM_PROMPT + this.loadProjectContext();
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

    // チャットプラットフォーム連携のシステムプロンプト + AGENTS.md
    args.push('--append-system-prompt', this.getFullSystemPrompt());

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

    // チャットプラットフォーム連携のシステムプロンプト + AGENTS.md
    args.push('--append-system-prompt', this.getFullSystemPrompt());

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
