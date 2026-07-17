import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { buildSystemPrompt } from './base-runner.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { prependRuntimeContext } from './runtime-context.js';
import { logPrompt, logResponse } from './transcript-logger.js';
import { CliRunnerBase, type CliStreamParser } from './cli-runner-core.js';
import type { ChatPlatform } from './prompts/index.js';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

export interface AntigravityOptions extends BaseRunnerOptions {
  platform?: ChatPlatform;
}

interface AntigravityJsonResponse {
  status?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: unknown;
  result?: string;
  text?: string;
  content?: string;
  output_text?: string;
  response?: string;
  session_id?: string;
  sessionId?: string;
  conversation_id?: string;
  conversationId?: string;
  is_error?: boolean;
  error?: string | { message?: string };
  message?: string | { content?: unknown };
}

interface AntigravityStreamEvent {
  event?: string;
  conversation_id?: string;
  init?: {
    conversation_id?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: string;
    step_type?: string;
    text_delta?: string;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: unknown;
      error?: string | { message?: string; type?: string };
    };
  };
  result?: AntigravityJsonResponse;
}

type ConversationSnapshot = Map<string, number>;
type OutputCapability = 'unknown' | 'json' | 'legacy';
type StreamOutputCapability = 'unknown' | 'stream-json' | 'legacy';

interface AntigravityOutputError extends Error {
  antigravityStdout?: string;
  antigravityStderr?: string;
}

export class AntigravityRunner extends CliRunnerBase {
  protected readonly command = 'agy';
  protected readonly displayName = 'Antigravity CLI';
  protected readonly logPrefix = 'antigravity';

  private systemPrompt: string;
  private readonly printTimeout: string;
  /** Capability is intentionally per runner: different agy binaries may be used by different runners. */
  private outputCapability: OutputCapability = 'unknown';
  private streamOutputCapability: StreamOutputCapability = 'unknown';

  constructor(options?: AntigravityOptions) {
    super(options);
    this.systemPrompt = buildSystemPrompt(options?.platform);
    this.printTimeout =
      process.env.ANTIGRAVITY_PRINT_TIMEOUT || `${Math.ceil(this.timeoutMs / 1000)}s`;
  }

  private buildArgs(
    prompt: string,
    options?: RunOptions,
    outputFormat?: 'json' | 'stream-json'
  ): string[] {
    const args: string[] = [];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    if (options?.sessionId) {
      args.push('--conversation', options.sessionId);
    }

    // CliRunnerBase already sets cwd. agy resolves this relative directory as the same workspace.
    if (this.workdir) {
      args.push('--add-dir', '.');
    }

    args.push('--print-timeout', this.printTimeout);
    if (outputFormat) {
      args.push('--output-format', outputFormat);
    }
    args.push('-p', prompt);
    return args;
  }

  private async collectAntigravityOutput(
    args: string[],
    channelId: string | undefined
  ): Promise<{ stdout: string; stderr: string }> {
    let stderr = '';
    let stdoutOnError = '';
    try {
      const stdout = await this.collectOutput(args, channelId, {
        encoding: 'utf8',
        exitErrorDetail: (output) => {
          stdoutOnError = output;
          return this.extractExitErrorDetail(output);
        },
        onStderr: (output) => {
          stderr = output;
        },
      });
      return { stdout, stderr };
    } catch (error) {
      const outputError = error as AntigravityOutputError;
      outputError.antigravityStdout = stdoutOnError;
      outputError.antigravityStderr = stderr;
      throw outputError;
    }
  }

  private buildFullPrompt(rawPrompt: string): string {
    const promptWithRuntime = prependRuntimeContext(rawPrompt);
    return this.systemPrompt
      ? `<system-context>\n${this.systemPrompt}\n</system-context>\n\n${promptWithRuntime}`
      : promptWithRuntime;
  }

  protected buildEnv(channelId?: string): NodeJS.ProcessEnv {
    return {
      ...super.buildEnv(channelId),
      // Discord/Web などへのログ流出を避ける。ユーザーが明示設定していればそれを尊重する。
      AGY_CLI_HIDE_ACCOUNT_INFO: process.env.AGY_CLI_HIDE_ACCOUNT_INFO ?? 'true',
    };
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const fullPrompt = this.buildFullPrompt(prompt);

    this.logExecution('Executing', options);

    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    const wantsJson = this.outputCapability !== 'legacy';
    // Unknown runners need a pre-run snapshot in case they return legacy plain text.
    // Confirmed JSON runners never consult the conversation database.
    const conversationsBefore =
      this.outputCapability === 'json' ? new Map<string, number>() : this.snapshotConversations();
    let usedJson = wantsJson;
    let execution: { stdout: string; stderr: string };

    try {
      execution = await this.collectAntigravityOutput(
        this.buildArgs(fullPrompt, options, wantsJson ? 'json' : undefined),
        options?.channelId
      );
    } catch (error) {
      const outputError = error as AntigravityOutputError;
      const errorJson = this.parseResponse(outputError.antigravityStdout ?? '');
      if (this.isErrorStatus(errorJson)) {
        this.outputCapability = 'json';
        throw error;
      }

      if (!wantsJson || !this.isUnsupportedOutputFormat(error)) {
        throw error;
      }

      // An old agy has rejected --output-format before running the prompt. Retry exactly once.
      this.outputCapability = 'legacy';
      usedJson = false;
      execution = await this.collectAntigravityOutput(
        this.buildArgs(fullPrompt, options),
        options?.channelId
      );
    }

    const { result, sessionId } = this.interpretOutput(
      execution.stdout,
      execution.stderr,
      usedJson,
      conversationsBefore,
      options?.sessionId
    );

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
    if (this.streamOutputCapability === 'legacy') {
      return this.runPseudoStream(prompt, callbacks, options);
    }

    const fullPrompt = this.buildFullPrompt(prompt);
    this.logExecution('Streaming', options);

    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    // Unknown stream capability may be Agy 1.1.2 returning plain output while ignoring
    // --output-format. Snapshot before execution so its conversation ID can be recovered.
    const conversationsBefore =
      this.streamOutputCapability === 'stream-json'
        ? new Map<string, number>()
        : this.snapshotConversations();

    const onComplete = (result: RunResult) => {
      if (!result.sessionId && this.streamOutputCapability === 'legacy') {
        result.sessionId =
          this.findChangedConversationId(conversationsBefore) || options?.sessionId || '';
      }
      if (options?.appSessionId && this.workdir) {
        logResponse(this.workdir, options.appSessionId, {
          result: result.result,
          sessionId: result.sessionId,
        });
      }
    };

    try {
      return await this.executeStreamCore(
        this.buildArgs(fullPrompt, options, 'stream-json'),
        callbacks,
        {
          channelId: options?.channelId,
          notifyOnError: false,
          onComplete,
        }
      );
    } catch (error) {
      if (this.isUnsupportedOutputFormat(error)) {
        // This failure happens during flag parsing, before agy executes the prompt.
        this.streamOutputCapability = 'legacy';
        this.outputCapability = 'legacy';
        const fallbackOptions = options?.appSessionId
          ? { ...options, appSessionId: undefined }
          : options;
        const result = await this.runPseudoStream(prompt, callbacks, fallbackOptions);
        onComplete(result);
        return result;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      callbacks.onError?.(err);
      throw error;
    }
  }

  protected createStreamParser(callbacks: StreamCallbacks): CliStreamParser {
    let fullText = '';
    let sessionId = '';
    let rawOutput = '';
    let errorDetail: string | undefined;
    let lastToolError: string | undefined;
    let sawResult = false;
    let sawNativeEvent = false;
    let backendReady = false;
    const emittedToolSteps = new Set<string>();

    return {
      handleRawLine: (line, phase) => {
        rawOutput += phase === 'stream' ? `${line}\n` : line;
      },
      handleEvent: (json, phase) => {
        const event = json as AntigravityStreamEvent;
        const isNativeEvent =
          (event.event === 'init' && Boolean(event.init)) ||
          (event.event === 'step_update' && Boolean(event.step_update)) ||
          (event.event === 'result' && Boolean(event.result?.status));
        if (!isNativeEvent) {
          return false;
        }

        sawNativeEvent = true;
        this.streamOutputCapability = 'stream-json';
        this.outputCapability = 'json';
        sessionId = event.conversation_id ?? sessionId;

        if (event.event === 'init') {
          sessionId = event.init?.conversation_id ?? sessionId;
          if (!backendReady) {
            backendReady = true;
            callbacks.onBackendReady?.();
          }
          return undefined;
        }

        if (event.event === 'step_update' && event.step_update) {
          const step = event.step_update;
          sessionId = step.conversation_id ?? sessionId;

          if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
            fullText += step.text_delta;
            if (step.text_delta) {
              callbacks.onText?.(step.text_delta, fullText);
            }
          }

          if (step.step_type === 'tool') {
            const toolName = step.tool_name ?? step.tool_info?.name ?? 'tool';
            const input = this.toRecord(step.tool_info?.parameters);
            const toolId =
              step.step_index !== undefined
                ? `${sessionId}:${step.step_index}`
                : `${toolName}:${JSON.stringify(input)}`;

            if (step.state === 'ACTIVE' && !emittedToolSteps.has(toolId)) {
              emittedToolSteps.add(toolId);
              callbacks.onToolUse?.(toolName, input);
            }

            if (step.state === 'ERROR') {
              lastToolError = this.extractToolError(step.tool_info?.error, toolName);
            }
          }
          return undefined;
        }

        if (event.event === 'result' && event.result) {
          sawResult = true;
          const result = event.result;
          sessionId = result.conversation_id ?? sessionId;

          if (result.status === 'ERROR') {
            errorDetail = this.extractErrorMessage(result) ?? 'Antigravity CLI returned ERROR';
            return phase === 'stream' ? new Error(errorDetail) : undefined;
          }
          if (result.status !== 'SUCCESS') {
            errorDetail = `Antigravity CLI returned unknown stream status${
              result.status ? `: ${result.status}` : ''
            }`;
            return phase === 'stream' ? new Error(errorDetail) : undefined;
          }

          const response = typeof result.response === 'string' ? result.response : '';
          if (!response) {
            errorDetail =
              lastToolError ?? 'Antigravity CLI returned SUCCESS JSON without a response';
            return phase === 'stream' ? new Error(errorDetail) : undefined;
          }

          if (response.startsWith(fullText)) {
            const remaining = response.slice(fullText.length);
            fullText = response;
            if (remaining) callbacks.onText?.(remaining, fullText);
          } else if (response !== fullText) {
            // The final response is canonical. Do not emit it again after already emitted deltas.
            fullText = response;
          }
        }

        return undefined;
      },
      finalize: () => {
        if (!sawNativeEvent) {
          this.streamOutputCapability = 'legacy';
          const result = rawOutput.trim();
          if (!result) {
            throw new Error('Antigravity CLI returned no output');
          }
          callbacks.onText?.(result, result);
          return { result, sessionId };
        }
        if (!sawResult) {
          throw new Error('Antigravity CLI stream ended without a result event');
        }
        if (errorDetail) {
          throw new Error(errorDetail);
        }
        return { result: fullText, sessionId };
      },
      exitErrorDetail: () => errorDetail,
    };
  }

  private async runPseudoStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    try {
      const result = await this.run(prompt, options);
      callbacks.onText?.(result.result, result.result);
      callbacks.onComplete?.(result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks.onError?.(err);
      throw error;
    }
  }

  private interpretOutput(
    stdout: string,
    stderr: string,
    requestedJson: boolean,
    conversationsBefore: ConversationSnapshot,
    priorSessionId?: string
  ): RunResult {
    const response = this.parseResponse(stdout);
    const wasConfirmedJson = this.outputCapability === 'json';

    if (requestedJson) {
      if (!response) {
        if (wasConfirmedJson || this.looksLikeNativeJsonEnvelope(stdout)) {
          throw new Error('Antigravity CLI returned malformed JSON output');
        }
        this.outputCapability = 'legacy';
        return this.buildLegacyResult(stdout, stderr, null, conversationsBefore, priorSessionId);
      }

      // Older agy versions may ignore --output-format and return an ordinary JSON answer.
      // Native Agy envelopes always have status, so user JSON must not confirm capability.
      if (response.status === undefined && !wasConfirmedJson) {
        this.outputCapability = 'legacy';
        return this.buildLegacyResult(stdout, stderr, null, conversationsBefore, priorSessionId);
      }

      this.outputCapability = 'json';
      if (response.status === 'SUCCESS') {
        const result = typeof response.response === 'string' ? response.response : '';
        if (!result) {
          throw new Error('Antigravity CLI returned SUCCESS JSON without a response');
        }
        return { result, sessionId: response.conversation_id ?? priorSessionId ?? '' };
      }
      if (response.status === 'ERROR') {
        throw new Error(this.extractErrorMessage(response) ?? 'Antigravity CLI returned ERROR');
      }
      throw new Error(
        `Antigravity CLI returned unknown JSON status${response.status ? `: ${response.status}` : ''}`
      );
    }

    return this.buildLegacyResult(stdout, stderr, response, conversationsBefore, priorSessionId);
  }

  private buildLegacyResult(
    stdout: string,
    stderr: string,
    response: AntigravityJsonResponse | null,
    conversationsBefore: ConversationSnapshot,
    priorSessionId?: string
  ): RunResult {
    if (response && (response.is_error || response.error)) {
      throw new Error(this.extractErrorMessage(response) ?? 'Antigravity CLI returned error');
    }

    const result = this.extractText(response) || stdout.trim();
    if (!result) {
      const detail = stderr.trim();
      throw new Error(
        detail
          ? `Antigravity CLI returned no output: ${detail}`
          : 'Antigravity CLI returned no output. Check ~/.gemini/antigravity-cli/log/ for quota, auth, or model errors.'
      );
    }

    return {
      result,
      sessionId:
        this.extractSessionId(response) ||
        this.findChangedConversationId(conversationsBefore) ||
        priorSessionId ||
        '',
    };
  }

  private parseResponse(output: string): AntigravityJsonResponse | null {
    const trimmed = output.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as AntigravityJsonResponse)
        : null;
    } catch {
      return null;
    }
  }

  private extractExitErrorDetail(output: string): string | undefined {
    const response = this.parseResponse(output);
    if (response?.status !== 'ERROR') return undefined;
    return this.extractErrorMessage(response) ?? 'Antigravity CLI returned ERROR';
  }

  private isErrorStatus(response: AntigravityJsonResponse | null): boolean {
    return response?.status === 'ERROR';
  }

  private isUnsupportedOutputFormat(error: unknown): boolean {
    const outputError = error as AntigravityOutputError;
    const detail = [
      error instanceof Error ? error.message : String(error),
      outputError.antigravityStdout,
      outputError.antigravityStderr,
    ]
      .filter(Boolean)
      .join('\n');
    const mentionsOutputFormat = /-{1,2}output-format/i.test(detail);
    const reportsUnsupported =
      /(?:unknown|unrecognized|undefined|unexpected)\s+(?:option|flag|argument)/i.test(detail) ||
      /(?:option|flag|argument)s?\s+provided\s+but\s+not\s+defined/i.test(detail) ||
      /(?:option|flag|argument)s?\s+(?:is|are)\s+not\s+defined/i.test(detail);
    return mentionsOutputFormat && reportsUnsupported;
  }

  private looksLikeNativeJsonEnvelope(output: string): boolean {
    return /^\s*\{[\s\S]{0,200}"status"\s*:/.test(output);
  }

  private extractText(event: AntigravityJsonResponse | null): string {
    if (!event) return '';
    for (const value of [
      event.result,
      event.output_text,
      event.text,
      event.content,
      event.response,
      this.extractTextFromUnknown(event.message),
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

  private extractSessionId(event: AntigravityJsonResponse | null): string {
    return (
      event?.session_id ?? event?.sessionId ?? event?.conversation_id ?? event?.conversationId ?? ''
    );
  }

  private snapshotConversations(): ConversationSnapshot {
    const conversationsDir = this.getConversationsDir();
    const snapshot: ConversationSnapshot = new Map();

    try {
      for (const filename of readdirSync(conversationsDir)) {
        const conversationId = this.extractConversationIdFromFilename(filename);
        if (!conversationId) continue;
        const filePath = join(conversationsDir, filename);
        snapshot.set(conversationId, statSync(filePath).mtimeMs);
      }
    } catch {
      // Antigravity creates this directory lazily after the first CLI run.
    }

    return snapshot;
  }

  private findChangedConversationId(before: ConversationSnapshot): string {
    const conversationsDir = this.getConversationsDir();
    let changedConversation = '';
    let latestMtime = -1;

    try {
      for (const filename of readdirSync(conversationsDir)) {
        const conversationId = this.extractConversationIdFromFilename(filename);
        if (!conversationId) continue;

        const filePath = join(conversationsDir, filename);
        const mtimeMs = statSync(filePath).mtimeMs;
        const previousMtime = before.get(conversationId);
        if (previousMtime !== undefined && mtimeMs <= previousMtime) continue;

        if (mtimeMs > latestMtime) {
          latestMtime = mtimeMs;
          changedConversation = conversationId;
        }
      }
    } catch {
      return '';
    }

    return changedConversation;
  }

  private getConversationsDir(): string {
    return join(process.env.HOME || homedir(), '.gemini', 'antigravity-cli', 'conversations');
  }

  private extractConversationIdFromFilename(filename: string): string {
    const id = basename(filename, '.db');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : '';
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private extractToolError(
    error: string | { message?: string; type?: string } | undefined,
    toolName: string
  ): string {
    if (typeof error === 'string') return error || `Antigravity tool failed: ${toolName}`;
    if (error?.message) return error.message;
    return `Antigravity tool failed: ${toolName}`;
  }

  private extractErrorMessage(event: AntigravityJsonResponse): string | undefined {
    const error = event.error;
    if (typeof error === 'string') return error;
    if (error?.message) return error.message;
    if (typeof event.message === 'string' && event.is_error) return event.message;
    if (typeof event.message === 'string' && event.status === 'ERROR') return event.message;
    if (typeof event.response === 'string' && event.status === 'ERROR') return event.response;
    return undefined;
  }
}
