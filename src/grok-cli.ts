import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { buildSystemPrompt } from './base-runner.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { prependRuntimeContext } from './runtime-context.js';
import { logPrompt, logResponse } from './transcript-logger.js';
import { CliRunnerBase, type CliStreamParser } from './cli-runner-core.js';
import type { ChatPlatform } from './prompts/index.js';

export interface GrokOptions extends BaseRunnerOptions {
  platform?: ChatPlatform;
}

interface GrokJsonResponse {
  result?: string;
  text?: string;
  content?: string;
  output_text?: string;
  response?: string;
  session_id?: string;
  sessionId?: string;
  is_error?: boolean;
  error?: string | { message?: string };
  message?: string | { content?: unknown };
}

interface GrokStreamEvent extends GrokJsonResponse {
  type?: string;
  event?: string;
  delta?: unknown;
  data?: unknown;
  tool_call?: unknown;
  toolCall?: unknown;
  tool_name?: string;
  toolName?: string;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  id?: string;
  call_id?: string;
  session?: { id?: string };
}

export class GrokRunner extends CliRunnerBase {
  protected readonly command = 'grok';
  protected readonly displayName = 'Grok CLI';
  protected readonly logPrefix = 'grok';

  private systemPrompt: string;

  constructor(options?: GrokOptions) {
    super(options);
    this.systemPrompt = buildSystemPrompt(options?.platform);
  }

  private buildBaseArgs(options?: RunOptions): string[] {
    const args = ['--no-auto-update'];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      args.push('--always-approve');
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.workdir) {
      args.push('--cwd', this.workdir);
    }

    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }

    return args;
  }

  private buildFullPrompt(rawPrompt: string): string {
    const promptWithRuntime = prependRuntimeContext(rawPrompt);
    return this.systemPrompt
      ? `<system-context>\n${this.systemPrompt}\n</system-context>\n\n${promptWithRuntime}`
      : promptWithRuntime;
  }

  protected buildEnv(channelId?: string): NodeJS.ProcessEnv {
    const env = super.buildEnv(channelId);
    if (process.env.XAI_API_KEY) {
      env.XAI_API_KEY = process.env.XAI_API_KEY;
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

    const stdout = await this.collectOutput(args, options?.channelId, {
      exitErrorDetail: (output) => this.extractErrorFromOutput(output),
    });
    const response = this.parseJsonResponse(stdout);
    const result = this.extractText(response) || stdout.trim();
    const sessionId = this.extractSessionId(response);

    if (response.is_error || response.error) {
      throw new Error(this.extractErrorMessage(response) ?? 'Grok CLI returned error');
    }

    if (options?.appSessionId && this.workdir) {
      logResponse(this.workdir, options.appSessionId, { result, sessionId });
    }

    return { result, sessionId };
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
      'streaming-json',
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

    return this.executeStreamCore(args, callbacks, {
      channelId: options?.channelId,
      onComplete,
    });
  }

  protected createStreamParser(callbacks: StreamCallbacks): CliStreamParser {
    let fullText = '';
    let sessionId = '';
    let errorDetail: string | undefined;
    const emittedToolIds = new Set<string>();

    return {
      handleEvent: (json, phase) => {
        const event = json as GrokStreamEvent;
        sessionId = this.extractSessionId(event) || sessionId;

        const err = this.extractErrorMessage(event);
        if (event.is_error || err) {
          errorDetail = err ?? 'Grok CLI returned error';
          if (phase === 'stream') return new Error(errorDetail);
          return undefined;
        }

        const tool = this.extractToolUse(event);
        if (tool && !emittedToolIds.has(tool.id)) {
          emittedToolIds.add(tool.id);
          callbacks.onToolUse?.(tool.name, tool.input);
        }

        const text = this.extractText(event);
        if (text) {
          const applied = this.applyText(text, this.isDeltaEvent(event), fullText);
          fullText = applied.fullText;
          if (applied.emitText !== undefined) {
            callbacks.onText?.(applied.emitText, fullText);
          }
        }

        return undefined;
      },
      finalize: () => ({ result: fullText, sessionId }),
      exitErrorDetail: () => errorDetail,
    };
  }

  private parseJsonResponse(output: string): GrokJsonResponse {
    try {
      return JSON.parse(output.trim()) as GrokJsonResponse;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Failed to parse Grok CLI response: ${output}`);
      }
      throw err;
    }
  }

  private extractText(event: GrokJsonResponse | GrokStreamEvent): string {
    const type = ((event as GrokStreamEvent).type ?? (event as GrokStreamEvent).event ?? '')
      .toLowerCase()
      .trim();
    if (type.includes('thought') || type.includes('reasoning')) {
      return '';
    }

    for (const value of [
      event.result,
      event.output_text,
      event.text,
      event.content,
      event.response,
      this.extractTextFromUnknown(event.message),
      this.extractTextFromUnknown((event as GrokStreamEvent).delta),
      this.extractTextFromUnknown((event as GrokStreamEvent).data),
    ]) {
      if (typeof value === 'string' && value) return value;
    }
    return '';
  }

  private extractTextFromUnknown(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    if (Array.isArray(record.content)) {
      return record.content
        .map((block) => this.extractTextFromUnknown(block))
        .filter(Boolean)
        .join('');
    }
    return '';
  }

  private extractSessionId(event: GrokJsonResponse | GrokStreamEvent): string {
    return event.session_id ?? event.sessionId ?? (event as GrokStreamEvent).session?.id ?? '';
  }

  private extractErrorMessage(event: GrokJsonResponse | GrokStreamEvent): string | undefined {
    const error = event.error;
    if (typeof error === 'string') return error;
    if (error?.message) return error.message;
    const type = (event as GrokStreamEvent).type ?? (event as GrokStreamEvent).event;
    if (typeof event.message === 'string' && type?.toLowerCase().includes('error')) {
      return event.message;
    }
    return undefined;
  }

  private extractErrorFromOutput(output: string): string | undefined {
    let detail: string | undefined;
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as GrokStreamEvent;
        detail = this.extractErrorMessage(event) ?? detail;
      } catch {
        // Non-JSON stdout is ignored; stderr remains the fallback in CliRunnerBase.
      }
    }
    return detail;
  }

  private isDeltaEvent(event: GrokStreamEvent): boolean {
    const type = (event.type ?? event.event ?? '').toLowerCase();
    return (
      Boolean(event.delta) || type === 'text' || type.includes('delta') || type.includes('chunk')
    );
  }

  private applyText(
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

    if (text === fullText || fullText.endsWith(text)) {
      return { fullText };
    }
    if (text.startsWith(fullText)) {
      const delta = text.slice(fullText.length);
      return delta ? { fullText: text, emitText: delta } : { fullText };
    }
    return { fullText: text };
  }

  private extractToolUse(
    event: GrokStreamEvent
  ): { id: string; name: string; input: Record<string, unknown> } | null {
    const type = (event.type ?? event.event ?? '').toLowerCase();
    if (type.includes('result') || type.includes('complete') || type.includes('finish')) {
      return null;
    }
    if (!type.includes('tool') && !event.tool_call && !event.toolCall) return null;

    const raw = event.tool_call ?? event.toolCall ?? event;
    const record = this.toRecord(raw);
    const name =
      event.tool_name ??
      event.toolName ??
      event.name ??
      (typeof record.name === 'string' ? record.name : undefined) ??
      (typeof record.tool_name === 'string' ? record.tool_name : undefined) ??
      'tool';
    const input = this.toRecord(
      event.arguments ?? event.input ?? record.arguments ?? record.input ?? record.args
    );
    const id = event.call_id ?? event.id ?? `${name}:${JSON.stringify(input)}`;
    return { id, name, input };
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return { input: value };
      }
    }
    return {};
  }
}
