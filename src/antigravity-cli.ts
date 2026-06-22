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

type ConversationSnapshot = Map<string, number>;

export class AntigravityRunner extends CliRunnerBase {
  protected readonly command = 'agy';
  protected readonly displayName = 'Antigravity CLI';
  protected readonly logPrefix = 'antigravity';

  private systemPrompt: string;

  constructor(options?: AntigravityOptions) {
    super(options);
    this.systemPrompt = buildSystemPrompt(options?.platform);
  }

  private buildArgs(prompt: string, options?: RunOptions): string[] {
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

    args.push('-p', prompt);
    return args;
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
    const args = this.buildArgs(fullPrompt, options);
    const conversationsBefore = this.snapshotConversations();

    this.logExecution('Executing', options);

    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    const stdout = await this.collectOutput(args, options?.channelId, { encoding: 'utf8' });
    const response = this.parseResponse(stdout);
    const result = this.extractText(response) || stdout.trim();
    const sessionId =
      this.extractSessionId(response) || this.findChangedConversationId(conversationsBefore);

    if (response && (response.is_error || response.error)) {
      throw new Error(this.extractErrorMessage(response) ?? 'Antigravity CLI returned error');
    }

    if (!result) {
      throw new Error(
        'Antigravity CLI returned no output. Check ~/.gemini/antigravity-cli/log/ for quota, auth, or model errors.'
      );
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
    const result = await this.run(prompt, options);
    if (result.result) {
      callbacks.onText?.(result.result, result.result);
    }
    callbacks.onComplete?.(result);
    return result;
  }

  protected createStreamParser(_callbacks: StreamCallbacks): CliStreamParser {
    return {
      handleEvent: () => undefined,
      finalize: () => ({ result: '', sessionId: '' }),
    };
  }

  private parseResponse(output: string): AntigravityJsonResponse | null {
    const trimmed = output.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as AntigravityJsonResponse;
    } catch {
      return null;
    }
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

  private extractErrorMessage(event: AntigravityJsonResponse): string | undefined {
    const error = event.error;
    if (typeof error === 'string') return error;
    if (error?.message) return error.message;
    if (typeof event.message === 'string' && event.is_error) return event.message;
    return undefined;
  }
}
