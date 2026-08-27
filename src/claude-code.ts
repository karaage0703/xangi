import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { mergeTexts, sanitizeSurrogates, prependRuntimeContext } from './agent-runner.js';
import { stripToolCallArtifacts, finalizeDisplayText } from './tool-call-sanitize.js';
import { buildSystemPrompt } from './base-runner.js';
import type { BaseRunnerOptions } from './base-runner.js';
import type { ChatPlatform } from './prompts/index.js';
import { logPrompt, logResponse } from './transcript-logger.js';
import { CliRunnerBase, type CliStreamParser } from './cli-runner-core.js';
import { updateSessionContextUsage } from './sessions.js';

export interface ClaudeCodeOptions extends BaseRunnerOptions {
  platform?: ChatPlatform;
  effort?: string;
}

interface ClaudeCodeResponse {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  usage?: ClaudeStreamEvent['usage'];
  modelUsage?: ClaudeStreamEvent['modelUsage'];
}

export function extractClaudeContextUsage(
  event: ClaudeStreamEvent
): { contextTokens: number; contextWindow: number } | undefined {
  const last = event.usage?.iterations?.at(-1);
  const contextWindow = Object.values(event.modelUsage ?? {}).find(
    (model) => typeof model.contextWindow === 'number'
  )?.contextWindow;
  if (!last || !contextWindow) return undefined;
  return {
    contextTokens:
      (last.input_tokens ?? 0) +
      (last.cache_read_input_tokens ?? 0) +
      (last.cache_creation_input_tokens ?? 0),
    contextWindow,
  };
}

interface ClaudeStreamEvent {
  type?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  session_id?: string;
  is_error?: boolean;
  result?: string;
  usage?: {
    iterations?: Array<{
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    }>;
  };
  modelUsage?: Record<string, { contextWindow?: number }>;
}

/**
 * Claude Code CLI を実行するランナー
 */
export class ClaudeCodeRunner extends CliRunnerBase {
  protected readonly command = 'claude';
  protected readonly displayName = 'Claude Code CLI';
  protected readonly logPrefix = 'claude-code';

  private systemPrompt: string;
  private effort?: string;
  private bare: boolean;
  private maxBudgetUsd?: string;

  constructor(options?: ClaudeCodeOptions) {
    super(options);
    this.systemPrompt = buildSystemPrompt(options?.platform);
    this.effort = options?.effort;
    this.bare = process.env.CLAUDE_CODE_BARE === 'true';
    this.maxBudgetUsd = process.env.CLAUDE_CODE_MAX_BUDGET_USD?.trim() || undefined;
  }

  /**
   * コマンド引数を構築（run/runStream 共通）
   */
  private buildArgs(
    prompt: string,
    outputFormat: 'json' | 'stream-json',
    options?: RunOptions
  ): string[] {
    const args: string[] = ['-p', '--output-format', outputFormat];
    if (outputFormat === 'stream-json') {
      args.push('--verbose');
    }

    if (this.bare) {
      args.push('--bare');
    }

    if (this.maxBudgetUsd) {
      args.push('--max-budget-usd', this.maxBudgetUsd);
    }

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

    const effort = options?.effort ?? this.effort;
    if (effort) {
      args.push('--effort', effort);
    }

    // チャットプラットフォーム連携のシステムプロンプト + AGENTS.md
    args.push('--append-system-prompt', this.systemPrompt);

    args.push(prompt);

    return args;
  }

  protected buildEnv(channelId?: string): NodeJS.ProcessEnv {
    const env = super.buildEnv(channelId);
    if (process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    return env;
  }

  async run(rawPrompt: string, options?: RunOptions): Promise<RunResult> {
    const prompt = prependRuntimeContext(sanitizeSurrogates(rawPrompt), this.workdir);
    const args = this.buildArgs(prompt, 'json', options);

    this.logExecution('Executing', options);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, prompt);
    }

    let stdout: string;
    try {
      stdout = await this.collectOutput(args, options?.channelId);
    } catch (error) {
      if (!options?.sessionId || !this.isStaleResumeError(error)) {
        throw error;
      }
      console.warn(
        `[claude-code] Resume failed for stale session ${options.sessionId.slice(0, 8)}..., retrying with a new session`
      );
      const retryArgs = this.buildArgs(prompt, 'json', { ...options, sessionId: undefined });
      stdout = await this.collectOutput(retryArgs, options?.channelId);
    }
    const response = this.parseResponse(stdout);

    // トランスクリプトログ: 応答を記録
    if (options?.appSessionId && this.workdir) {
      logResponse(this.workdir, options.appSessionId, {
        result: response.result,
        sessionId: response.session_id,
      });
    }

    const result: RunResult = {
      // 非ストリーミング経路でも tool-call 構文の除去 + 空→正直な fallback を適用
      result: finalizeDisplayText(response.result),
      sessionId: response.session_id,
      usage: extractClaudeContextUsage(response),
    };
    this.persistContextUsage(options?.appSessionId, result);
    return result;
  }

  /**
   * 無効な sessionId での `--resume` 失敗か。
   * Claude Code CLI は存在しないセッションを resume すると
   * "No conversation found with session ID: ..." を出して非ゼロ終了する。
   * （プロセス再起動や CLI 側のセッション GC で session が消えた場合に発生）
   */
  private isStaleResumeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /No conversation found/i.test(message);
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
    rawPrompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const prompt = prependRuntimeContext(sanitizeSurrogates(rawPrompt), this.workdir);
    const args = this.buildArgs(prompt, 'stream-json', options);

    this.logExecution('Streaming', options);

    try {
      const result = await this.executeStreamCore(args, callbacks, {
        channelId: options?.channelId,
        notifyOnError: false,
      });
      this.persistContextUsage(options?.appSessionId, result);
      return result;
    } catch (error) {
      if (!options?.sessionId || !this.isStaleResumeError(error)) {
        const err = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(err);
        throw error;
      }
      console.warn(
        `[claude-code] Resume failed for stale session ${options.sessionId.slice(0, 8)}..., retrying with a new session`
      );
      const retryArgs = this.buildArgs(prompt, 'stream-json', { ...options, sessionId: undefined });
      const result = await this.executeStreamCore(retryArgs, callbacks, {
        channelId: options?.channelId,
      });
      this.persistContextUsage(options?.appSessionId, result);
      return result;
    }
  }

  protected createStreamParser(callbacks: StreamCallbacks): CliStreamParser {
    let fullText = '';
    let sessionId = '';
    let usage: RunResult['usage'];

    return {
      handleEvent: (json, phase) => {
        const event = json as ClaudeStreamEvent;

        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              const clean = stripToolCallArtifacts(block.text);
              if (clean) {
                fullText += clean;
                if (phase === 'stream') {
                  callbacks.onText?.(clean, fullText);
                }
              }
            }
          }
          return undefined;
        }

        if (event.type === 'result') {
          sessionId = event.session_id ?? sessionId;
          if (phase === 'stream' && event.is_error) {
            return new Error(event.result);
          }
          // ストリーミング中の累積テキストと最終 result をマージ
          // （ツール呼び出し前のテキストが result から消えるのを防ぐ）
          if (event.result) {
            fullText = mergeTexts(fullText, stripToolCallArtifacts(event.result));
          }
          const context = extractClaudeContextUsage(event);
          if (context) usage = context;
        }

        return undefined;
      },
      finalize: () => ({ result: finalizeDisplayText(fullText), sessionId, usage }),
    };
  }

  private persistContextUsage(appSessionId: string | undefined, result: RunResult): void {
    if (!appSessionId || result.usage?.contextTokens === undefined || !result.usage.contextWindow)
      return;
    updateSessionContextUsage(appSessionId, {
      usedTokens: result.usage.contextTokens,
      contextWindow: result.usage.contextWindow,
      source: 'claude-result',
    });
  }
}
