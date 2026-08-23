import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { buildSystemPrompt } from './base-runner.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { prependRuntimeContext } from './runtime-context.js';
import { logPrompt, logResponse } from './transcript-logger.js';
import { CliRunnerBase, type CliStreamParser } from './cli-runner-core.js';
import type { ChatPlatform } from './prompts/index.js';

export interface OpenCodeOptions extends BaseRunnerOptions {
  platform?: ChatPlatform;
}

interface OpenCodeToolState {
  status?: string;
  input?: unknown;
  output?: string;
  metadata?: {
    exit?: number;
  };
}

interface OpenCodeEvent {
  type?: string;
  sessionID?: string;
  error?: {
    name?: string;
    data?: {
      message?: string;
    };
  };
  part?: {
    id?: string;
    type?: string;
    text?: string;
    reason?: string;
    tool?: string;
    callID?: string;
    sessionID?: string;
    state?: OpenCodeToolState;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: {
        read?: number;
        write?: number;
      };
    };
  };
}

/** OpenCode CLI の非対話 JSONL 実行を xangi の AgentRunner 契約へ変換する。 */
export class OpenCodeRunner extends CliRunnerBase {
  protected readonly command = 'opencode';
  protected readonly displayName = 'OpenCode CLI';
  protected readonly logPrefix = 'opencode';

  private readonly systemPrompt: string;

  constructor(options?: OpenCodeOptions) {
    super(options);
    this.systemPrompt = buildSystemPrompt(options?.platform);
  }

  private buildFullPrompt(rawPrompt: string): string {
    const prompt = prependRuntimeContext(rawPrompt, this.workdir);
    return this.systemPrompt
      ? `<system-context>\n${this.systemPrompt}\n</system-context>\n\n${prompt}`
      : prompt;
  }

  private buildArgs(fullPrompt: string, options?: RunOptions): string[] {
    const args = ['run', '--format', 'json', '--agent', 'build'];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) args.push('--auto');

    if (this.workdir) args.push('--dir', this.workdir);
    if (this.model) args.push('--model', this.model);
    if (options?.effort) args.push('--variant', options.effort);
    if (options?.sessionId) args.push('--session', options.sessionId);

    args.push(fullPrompt);
    return args;
  }

  private isStaleSessionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /session (?:was )?not found|unknown session|unable to (?:find|load|resume).*session/i.test(
      message
    );
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    return this.runStream(prompt, {}, options);
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const fullPrompt = this.buildFullPrompt(prompt);
    const args = this.buildArgs(fullPrompt, options);

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
      if (!options?.sessionId || !this.isStaleSessionError(error)) {
        const err = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(err);
        throw error;
      }
      console.warn(
        `[opencode] Resume failed for stale session ${options.sessionId.slice(0, 8)}..., retrying with a new session`
      );
      const retryArgs = this.buildArgs(fullPrompt, { ...options, sessionId: undefined });
      return this.executeStreamCore(retryArgs, callbacks, {
        channelId: options?.channelId,
        onComplete,
      });
    }
  }

  protected createStreamParser(callbacks: StreamCallbacks): CliStreamParser {
    let fullText = '';
    let sessionId = '';
    let errorDetail: string | undefined;
    let backendReady = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    const emittedToolIds = new Set<string>();

    return {
      handleEvent: (json) => {
        const event = json as OpenCodeEvent;
        sessionId = event.sessionID || event.part?.sessionID || sessionId;

        if (!backendReady && event.type === 'step_start') {
          backendReady = true;
          callbacks.onBackendReady?.();
          callbacks.onTraceEvent?.({ type: 'turn_started' });
        }

        if (event.type === 'text' && typeof event.part?.text === 'string') {
          const text = event.part.text;
          if (text.trim()) {
            fullText += text;
            callbacks.onText?.(text, fullText);
            callbacks.onTraceEvent?.({ type: 'message_completed' });
          }
        }

        if (event.type === 'tool_use' && event.part?.tool) {
          const toolId = event.part.callID || event.part.id;
          const eventKey =
            toolId || `${event.part.tool}:${JSON.stringify(event.part.state?.input)}`;
          if (!emittedToolIds.has(eventKey)) {
            emittedToolIds.add(eventKey);
            const input = this.normalizeToolInput(event.part.state?.input);
            callbacks.onToolUse?.(event.part.tool, input);
            callbacks.onTraceEvent?.({
              type: 'tool_started',
              toolId,
              toolName: event.part.tool,
            });
            callbacks.onTraceEvent?.({
              type: 'tool_completed',
              toolId,
              toolName: event.part.tool,
              status: event.part.state?.status,
              exitCode: event.part.state?.metadata?.exit,
              outputBytes:
                typeof event.part.state?.output === 'string'
                  ? Buffer.byteLength(event.part.state.output, 'utf8')
                  : undefined,
            });
          }
        }

        if (event.type === 'step_finish' && event.part?.tokens) {
          inputTokens += event.part.tokens.input ?? 0;
          outputTokens += event.part.tokens.output ?? 0;
          cachedInputTokens += event.part.tokens.cache?.read ?? 0;
        }

        if (event.type === 'error') {
          errorDetail = event.error?.data?.message || event.error?.name || 'OpenCode error';
        }
      },
      finalize: () => {
        if (errorDetail) throw new Error(errorDetail);
        if (!sessionId) throw new Error('OpenCode CLI stream ended without a session ID');
        callbacks.onTraceEvent?.({
          type: 'turn_completed',
          usage: { inputTokens, cachedInputTokens, outputTokens },
        });
        return { result: fullText, sessionId };
      },
      exitErrorDetail: () => errorDetail,
    };
  }

  private normalizeToolInput(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }
    return input === undefined ? {} : { value: input };
  }
}
