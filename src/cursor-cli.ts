import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { buildSystemPrompt } from './base-runner.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { prependRuntimeContext } from './runtime-context.js';
import { logPrompt, logResponse } from './transcript-logger.js';
import { CliRunnerBase, type CliStreamParser } from './cli-runner-core.js';

interface CursorJsonResponse {
  result?: string;
  response?: string;
  session_id?: string;
  is_error?: boolean;
  error?: string | { message?: string };
}

interface CursorStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  timestamp_ms?: number;
  is_error?: boolean;
  result?: string;
  error?: string | { message?: string };
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };
  tool_call?: Record<string, unknown>;
  call_id?: string;
}

export class CursorRunner extends CliRunnerBase {
  protected readonly command = 'cursor-agent';
  protected readonly displayName = 'Cursor CLI';
  protected readonly logPrefix = 'cursor';

  private force: boolean;
  private trustWorkspace: boolean;

  constructor(options?: BaseRunnerOptions) {
    super(options);
    this.force = process.env.CURSOR_FORCE !== 'false';
    this.trustWorkspace = process.env.CURSOR_TRUST_WORKSPACE !== 'false';
  }

  private buildBaseArgs(options?: RunOptions): string[] {
    const args: string[] = [];

    if (this.force) {
      args.push('--force');
    }

    if (this.trustWorkspace) {
      args.push('--trust');
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.workdir) {
      args.push('--workspace', this.workdir);
    }

    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }

    return args;
  }

  private buildFullPrompt(rawPrompt: string): string {
    const systemPrompt = buildSystemPrompt();
    const promptWithRuntime = prependRuntimeContext(rawPrompt);
    return systemPrompt ? `${systemPrompt}\n\n---\n\n${promptWithRuntime}` : promptWithRuntime;
  }

  protected buildEnv(channelId?: string): NodeJS.ProcessEnv {
    const env = super.buildEnv(channelId);
    if (process.env.CURSOR_API_KEY) {
      env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
    }
    return env;
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const fullPrompt = this.buildFullPrompt(prompt);
    const args = [...this.buildBaseArgs(options), '-p', fullPrompt, '--output-format', 'json'];

    this.logExecution('Executing', options);

    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    let stdout: string;
    try {
      stdout = await this.collectOutput(args, options?.channelId);
    } catch (error) {
      // セッションresume失敗時は新規セッションでリトライ
      if (!options?.sessionId || !this.isStaleResumeError(error)) {
        throw error;
      }
      console.warn(
        `[cursor] Resume failed for stale session ${options.sessionId.slice(0, 8)}..., retrying with a new session`
      );
      const retryArgs = [
        ...this.buildBaseArgs({ ...options, sessionId: undefined }),
        '-p',
        fullPrompt,
        '--output-format',
        'json',
      ];
      stdout = await this.collectOutput(retryArgs, options?.channelId);
    }
    const response = this.parseJsonResponse(stdout);
    const result = response.result ?? response.response ?? stdout;
    const sessionId = response.session_id ?? '';

    if (response.is_error) {
      throw new Error(this.extractErrorMessage(response) ?? 'Cursor CLI returned error');
    }

    if (options?.appSessionId && this.workdir) {
      logResponse(this.workdir, options.appSessionId, { result, sessionId });
    }

    return { result, sessionId };
  }

  /**
   * 無効な sessionId での `--resume` 失敗か。
   * Cursor CLI 固有のエラーメッセージが安定しないため、CLI 共通基盤と同様に
   * 「sessionId 指定あり + exit code エラー」を広めに resume 失敗とみなして
   * 新規セッションで 1 回だけリトライする
   */
  private isStaleResumeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('exited with code');
  }

  private parseJsonResponse(output: string): CursorJsonResponse {
    try {
      return JSON.parse(output.trim()) as CursorJsonResponse;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Failed to parse Cursor CLI response: ${output}`);
      }
      throw err;
    }
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const fullPrompt = this.buildFullPrompt(prompt);
    const args = [
      ...this.buildBaseArgs(options),
      '-p',
      fullPrompt,
      '--output-format',
      'stream-json',
      '--stream-partial-output',
    ];

    this.logExecution('Streaming', options);

    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    const onComplete = (result: RunResult) => {
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
      // セッションresume失敗時は新規セッションでリトライ
      if (!options?.sessionId || !this.isStaleResumeError(error)) {
        const err = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(err);
        throw error;
      }
      console.warn(
        `[cursor] Resume failed for stale session ${options.sessionId.slice(0, 8)}..., retrying with a new session`
      );
      const retryArgs = [
        ...this.buildBaseArgs({ ...options, sessionId: undefined }),
        '-p',
        fullPrompt,
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ];
      return this.executeStreamCore(retryArgs, callbacks, {
        channelId: options?.channelId,
        onComplete,
      });
    }
  }

  protected createStreamParser(callbacks: StreamCallbacks): CliStreamParser {
    let fullText = '';
    let sessionId = '';
    const emittedToolIds = new Set<string>();

    return {
      handleEvent: (json, phase) => {
        const event = json as CursorStreamEvent;

        if (event.session_id) {
          sessionId = event.session_id;
        }

        if (event.type === 'assistant') {
          const text = this.extractAssistantText(event);
          if (text) {
            const applied = this.applyAssistantText(text, Boolean(event.timestamp_ms), fullText);
            fullText = applied.fullText;
            if (applied.emitText !== undefined) {
              callbacks.onText?.(applied.emitText, fullText);
            }
          }
        }

        if (event.type === 'tool_call' && event.subtype === 'started') {
          const tool = this.extractToolUse(event);
          if (tool && !emittedToolIds.has(tool.id)) {
            emittedToolIds.add(tool.id);
            callbacks.onToolUse?.(tool.name, tool.input);
          }
        }

        if (event.type === 'result') {
          if (event.session_id) {
            sessionId = event.session_id;
          }
          if (event.is_error) {
            if (phase === 'stream') {
              return new Error(this.extractErrorMessage(event) ?? 'Cursor CLI returned error');
            }
            return undefined;
          }
          if (event.result && !fullText.endsWith(event.result)) {
            fullText = fullText ? `${fullText}${event.result}` : event.result;
          }
        }

        return undefined;
      },
      finalize: () => ({ result: fullText, sessionId }),
    };
  }

  private applyAssistantText(
    text: string,
    isDelta: boolean,
    fullText: string
  ): { fullText: string; emitText?: string } {
    if (isDelta) {
      if (text.startsWith(fullText)) {
        const delta = text.slice(fullText.length);
        return delta ? { fullText: text, emitText: delta } : { fullText };
      }

      return { fullText: `${fullText}${text}`, emitText: text };
    }

    // Cursor emits a final assistant event containing the complete response after
    // token-level partial events. Treat it as canonical text, not another delta.
    if (text === fullText || fullText.endsWith(text)) {
      return { fullText };
    }

    if (text.startsWith(fullText)) {
      const delta = text.slice(fullText.length);
      return delta ? { fullText: text, emitText: delta } : { fullText };
    }

    return { fullText: text };
  }

  private extractAssistantText(event: CursorStreamEvent): string {
    const content = event.message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }

  private extractToolUse(
    event: CursorStreamEvent
  ): { id: string; name: string; input: Record<string, unknown> } | null {
    const raw = event.tool_call;
    if (!raw) return null;

    const entries = Object.entries(raw);
    for (const [kind, value] of entries) {
      if (!kind.endsWith('ToolCall') || !value || typeof value !== 'object') continue;
      const call = value as { args?: unknown };
      const rawName = kind.replace(/ToolCall$/, '');
      const name = rawName ? `${rawName.charAt(0).toUpperCase()}${rawName.slice(1)}` : 'Tool';
      const id = event.call_id ?? `${name}:${JSON.stringify(call.args ?? {})}`;
      return {
        id,
        name,
        input: this.toRecord(call.args),
      };
    }

    const id = event.call_id ?? JSON.stringify(raw);
    return { id, name: 'tool', input: this.toRecord(raw) };
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private extractErrorMessage(event: CursorJsonResponse | CursorStreamEvent): string | undefined {
    const error = event.error;
    if (typeof error === 'string') return error;
    if (error?.message) return error.message;
    return undefined;
  }
}
