import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { buildSystemPrompt } from './base-runner.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { prependRuntimeContext } from './runtime-context.js';
import { logPrompt, logResponse } from './transcript-logger.js';
import type { ChatPlatform } from './prompts/index.js';
import { CliRunnerBase, type CliStreamParser } from './cli-runner-core.js';

export interface CodexOptions extends BaseRunnerOptions {
  platform?: ChatPlatform;
}

/**
 * Codex CLI 0.98.0 の JSONL イベント型定義
 */
interface CodexEvent {
  type: string;
  thread_id?: string;
  session_id?: string;
  name?: string;
  command?: string;
  arguments?: string | Record<string, unknown>;
  input?: string | Record<string, unknown>;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    name?: string;
    command?: string;
    arguments?: string | Record<string, unknown>;
    input?: string | Record<string, unknown>;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
  payload?: {
    type?: string;
    name?: string;
    command?: string;
    arguments?: string | Record<string, unknown>;
    input?: string | Record<string, unknown>;
    item?: CodexEvent['item'];
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  // エラーイベント用（type: 'error' は message、type: 'turn.failed' は error.message）
  message?: string;
  error?: {
    message?: string;
  };
  // フォールバック用
  content?: string;
  result?: string;
}

/**
 * Codex CLI を実行するランナー（0.98.0 対応）
 */
export class CodexRunner extends CliRunnerBase {
  protected readonly command = 'codex';
  protected readonly displayName = 'Codex CLI';
  protected readonly logPrefix = 'codex';

  private systemPrompt: string;

  constructor(options?: CodexOptions) {
    super(options);
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

    if (options?.effort) {
      args.push('--config', `model_reasoning_effort="${options.effort}"`);
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
   * stdout の JSONL を 1 行ずつパースしてコールバックに渡す
   */
  private forEachJsonlEvent(output: string, fn: (event: CodexEvent) => void): void {
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        fn(JSON.parse(trimmed) as CodexEvent);
      } catch {
        // JSONパースエラーは無視
      }
    }
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
    if (
      json.type === 'item.completed' &&
      json.item?.type === 'agent_message' &&
      typeof json.item.text === 'string'
    ) {
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

  /**
   * JSONL 行から Codex 側のエラーメッセージを抽出する。
   * Codex は失敗時に stdout へ `error` / `turn.failed` イベントを流すが、
   * exit code だけ見ていると「利用上限到達」等の本当の理由が握り潰される。
   */
  private extractErrorMessage(json: CodexEvent): string | undefined {
    if (json.type === 'error' && json.message) {
      return json.message;
    }
    if (json.type === 'turn.failed' && json.error?.message) {
      return json.error.message;
    }
    return undefined;
  }

  private parseToolInput(input: unknown): Record<string, unknown> {
    if (!input) return {};
    if (typeof input === 'object' && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return {};
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through to a compact raw input summary.
      }
      return { input: trimmed };
    }
    return { input: String(input) };
  }

  private extractToolUse(
    json: CodexEvent
  ): { name: string; input: Record<string, unknown> } | null {
    const item = json.item ?? json.payload?.item;
    const payload = json.payload;
    const candidate = item ?? payload ?? json;
    const type = candidate.type;

    if (type === 'command_execution') {
      if (!candidate.command) return null;
      return {
        name: 'Bash',
        input: { command: candidate.command },
      };
    }

    if (type !== 'function_call' && type !== 'custom_tool_call' && type !== 'tool_call') {
      return null;
    }

    const name = candidate.name;
    if (!name) return null;
    return {
      name,
      input: this.parseToolInput(candidate.arguments ?? candidate.input),
    };
  }

  private isStaleResumeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('thread/resume failed') || message.includes('no rollout found');
  }

  async run(rawPrompt: string, options?: RunOptions): Promise<RunResult> {
    const prompt = prependRuntimeContext(rawPrompt, this.workdir);
    const args = this.buildArgs(prompt, options);

    this.logExecution('Executing', options);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, prompt);
    }

    const collectOpts = {
      exitErrorDetail: (stdout: string) => {
        let detail: string | undefined;
        this.forEachJsonlEvent(stdout, (event) => {
          const errMsg = this.extractErrorMessage(event);
          if (errMsg) detail = errMsg;
        });
        return detail;
      },
    };

    let stdout: string;
    try {
      stdout = await this.collectOutput(args, options?.channelId, collectOpts);
    } catch (error) {
      if (!options?.sessionId || !this.isStaleResumeError(error)) {
        throw error;
      }
      console.warn(
        `[codex] Resume failed for stale thread ${options.sessionId.slice(0, 8)}..., retrying with a new session`
      );
      const retryArgs = this.buildArgs(prompt, { ...options, sessionId: undefined });
      stdout = await this.collectOutput(retryArgs, options?.channelId, collectOpts);
    }

    let sessionId = '';
    this.forEachJsonlEvent(stdout, (event) => {
      const sid = this.extractSessionId(event);
      if (sid) sessionId = sid;
    });
    const result = this.extractResult(stdout);

    // トランスクリプトログ: 応答を記録
    if (options?.appSessionId && this.workdir) {
      logResponse(this.workdir, options.appSessionId, { result, sessionId });
    }

    return { result, sessionId };
  }

  private extractResult(output: string): string {
    const messageParts: string[] = [];

    this.forEachJsonlEvent(output, (event) => {
      const extracted = this.extractText(event);
      if (extracted?.isComplete) {
        messageParts.push(extracted.text);
      }
    });

    // 最後の agent_message を使用（複数ターンの場合）
    return messageParts.length > 0 ? messageParts[messageParts.length - 1] : output;
  }

  /**
   * ストリーミング実行
   */
  async runStream(
    rawPrompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const prompt = prependRuntimeContext(rawPrompt, this.workdir);
    const args = this.buildArgs(prompt, options);

    this.logExecution('Streaming', options);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, prompt);
    }

    const onComplete = (result: RunResult) => {
      // トランスクリプトログ: 応答を記録
      if (options?.appSessionId && this.workdir) {
        logResponse(this.workdir, options.appSessionId, {
          result: result.result,
          sessionId: result.sessionId,
        });
      }
    };

    try {
      return await this.executeStreamCore(args, callbacks, {
        channelId: options?.channelId,
        notifyOnError: false,
        onComplete,
      });
    } catch (error) {
      if (!options?.sessionId || !this.isStaleResumeError(error)) {
        const err = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(err);
        throw error;
      }
      console.warn(
        `[codex] Resume failed for stale thread ${options.sessionId.slice(0, 8)}..., retrying with a new session`
      );
      const retryArgs = this.buildArgs(prompt, { ...options, sessionId: undefined });
      return this.executeStreamCore(retryArgs, callbacks, {
        channelId: options?.channelId,
        onComplete,
      });
    }
  }

  protected createStreamParser(callbacks: StreamCallbacks): CliStreamParser {
    let fullText = '';
    let sessionId = '';
    let errorMessage: string | undefined;
    const emittedToolIds = new Set<string>();
    let backendReady = false;

    return {
      handleEvent: (json, phase) => {
        const event = json as CodexEvent;

        if (!backendReady && event.type === 'thread.started') {
          backendReady = true;
          callbacks.onBackendReady?.();
        }

        if (event.type === 'turn.started') {
          callbacks.onTraceEvent?.({ type: 'turn_started' });
        }

        // セッションID抽出
        const sid = this.extractSessionId(event);
        if (sid) sessionId = sid;

        // エラーイベント抽出（利用上限到達などの本当の理由）
        const errMsg = this.extractErrorMessage(event);
        if (errMsg) errorMessage = errMsg;

        const toolUse = this.extractToolUse(event);
        if (toolUse) {
          const itemId = event.item?.id ?? event.payload?.item?.id;
          const eventKey = itemId ?? `${toolUse.name}:${JSON.stringify(toolUse.input)}`;
          if (!emittedToolIds.has(eventKey)) {
            emittedToolIds.add(eventKey);
            callbacks.onToolUse?.(toolUse.name, toolUse.input);
          }

          const item = event.item ?? event.payload?.item;
          if (event.type === 'item.started') {
            callbacks.onTraceEvent?.({
              type: 'tool_started',
              toolId: itemId,
              toolName: toolUse.name,
            });
          } else if (event.type === 'item.completed') {
            callbacks.onTraceEvent?.({
              type: 'tool_completed',
              toolId: itemId,
              toolName: toolUse.name,
              status: item?.status,
              exitCode: item?.exit_code,
              outputBytes:
                typeof item?.aggregated_output === 'string'
                  ? Buffer.byteLength(item.aggregated_output, 'utf8')
                  : undefined,
            });
          }
        }

        // テキスト抽出
        const extracted = this.extractText(event);
        if (extracted) {
          fullText = extracted.text;
          if (phase === 'stream') {
            callbacks.onText?.(extracted.text, fullText);
          }
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            callbacks.onTraceEvent?.({ type: 'message_completed' });
          }
        }

        // トークン使用量ログ
        if (phase === 'stream' && event.type === 'turn.completed' && event.usage) {
          console.log(
            `[codex] Usage: input=${event.usage.input_tokens} (cached=${event.usage.cached_input_tokens ?? 0}), output=${event.usage.output_tokens}`
          );
        }
        if (event.type === 'turn.completed') {
          callbacks.onTraceEvent?.({
            type: 'turn_completed',
            usage: event.usage
              ? {
                  inputTokens: event.usage.input_tokens,
                  cachedInputTokens: event.usage.cached_input_tokens,
                  outputTokens: event.usage.output_tokens,
                }
              : undefined,
          });
        }

        return undefined;
      },
      finalize: () => ({ result: fullText, sessionId }),
      exitErrorDetail: () => errorMessage,
    };
  }
}
