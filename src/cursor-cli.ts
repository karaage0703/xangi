import { ProviderModels } from './provider-model.js';
import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { buildSystemPrompt } from './base-runner.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { inferEffortFromModelName } from './backend-effort.js';
import { prependRuntimeContext } from './runtime-context.js';
import { CliRunnerBase, mergeStreamText, type CliStreamParser } from './cli-runner-core.js';

interface CursorJsonResponse {
  model?: string;
  result?: string;
  response?: string;
  session_id?: string;
  is_error?: boolean;
  error?: string | { message?: string };
}

interface CursorStreamEvent {
  model?: string;
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
  private readonly systemPrompt: string;

  constructor(options?: BaseRunnerOptions) {
    super(options);
    this.force = process.env.CURSOR_FORCE !== 'false';
    this.trustWorkspace = process.env.CURSOR_TRUST_WORKSPACE !== 'false';
    this.systemPrompt = buildSystemPrompt(options?.platform);
  }

  private buildBaseArgs(options?: RunOptions): string[] {
    const args: string[] = [];

    if (this.force) {
      args.push('--force');
    }

    if (this.trustWorkspace) {
      args.push('--trust');
    }

    if (options?.effort && (!this.model || this.model === 'auto')) {
      throw new Error('Cursor effort requires an explicit model');
    }
    const model = this.model ?? 'auto';
    args.push('--model', options?.effort ? this.withEffort(model, options.effort) : model);

    if (this.workdir) {
      args.push('--workspace', this.workdir);
    }

    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }

    return args;
  }

  private withEffort(model: string, effort: NonNullable<RunOptions['effort']>): string {
    if (!model.includes('[') && inferEffortFromModelName(model) === effort) return model;
    const bracketStart = model.indexOf('[');
    const hasParameters = bracketStart > 0 && model.endsWith(']');
    const baseModel = hasParameters ? model.slice(0, bracketStart) : model;
    const rawParameters = hasParameters ? model.slice(bracketStart + 1, -1) : '';
    const parameters = rawParameters
      .split(',')
      .map((parameter) => parameter.trim())
      .filter((parameter) => parameter && !parameter.startsWith('effort='));

    parameters.push(`effort=${effort}`);
    return `${baseModel}[${parameters.join(',')}]`;
  }

  private buildFullPrompt(rawPrompt: string): string {
    const promptWithRuntime = prependRuntimeContext(rawPrompt, this.workdir);
    return this.systemPrompt
      ? `${this.systemPrompt}\n\n---\n\n${promptWithRuntime}`
      : promptWithRuntime;
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

    this.logPromptTranscript(fullPrompt, options);

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

    this.logResponseTranscript({ result, sessionId }, options);

    const models = new ProviderModels();
    models.add(response.model);
    const modelSelection = this.readModelSelection(response.model);
    return { result, sessionId, ...models.result(), ...(modelSelection ? { modelSelection } : {}) };
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

    this.logPromptTranscript(fullPrompt, options);
    const onComplete = (result: RunResult) => this.logResponseTranscript(result, options);

    return this.executeStreamWithResumeRetry(args, callbacks, options, {
      isStaleError: (error) => this.isStaleResumeError(error),
      args: () => [
        ...this.buildBaseArgs({ ...options, sessionId: undefined }),
        '-p',
        fullPrompt,
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ],
      warning: (id) =>
        `[cursor] Resume failed for stale session ${id.slice(0, 8)}..., retrying with a new session`,
      onComplete,
    });
  }

  protected createStreamParser(callbacks: StreamCallbacks): CliStreamParser {
    const models = new ProviderModels(callbacks.onModel);
    let fullText = '';
    let sessionId = '';
    let modelSelection: string | undefined;
    const emittedToolIds = new Set<string>();

    return {
      handleEvent: (json, phase) => {
        const event = json as CursorStreamEvent;
        if (event.type === 'system' && event.subtype === 'init') {
          const selection = this.readModelSelection(event.model);
          if (selection && selection !== modelSelection) {
            modelSelection = selection;
            callbacks.onModelSelection?.(selection);
          }
        }
        if (['system', 'assistant', 'result'].includes(event.type ?? '')) models.add(event.model);

        if (event.session_id) {
          sessionId = event.session_id;
        }

        if (event.type === 'assistant') {
          const text = this.extractAssistantText(event);
          if (text) {
            const applied = mergeStreamText(text, Boolean(event.timestamp_ms), fullText);
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
      finalize: () => ({
        result: fullText,
        sessionId,
        ...models.result(),
        ...(modelSelection ? { modelSelection } : {}),
      }),
    };
  }

  // Auto is a provider-reported routing mode, not an underlying model identity.
  private readModelSelection(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().toLowerCase() === 'auto' ? 'Auto' : undefined;
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
