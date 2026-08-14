import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { buildSystemPrompt } from './base-runner.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { prependRuntimeContext } from './runtime-context.js';
import { logPrompt, logResponse } from './transcript-logger.js';
import { CliRunnerBase, type CliStreamParser } from './cli-runner-core.js';
import type { ChatPlatform } from './prompts/index.js';

export type CopilotPermissionMode = 'read-only' | 'workspace-write';

export interface GitHubCopilotOptions extends BaseRunnerOptions {
  platform?: ChatPlatform;
  copilotPermissionMode?: CopilotPermissionMode;
  copilotMaxAiCredits?: number;
}

interface CopilotToolRequest {
  toolCallId?: string;
  name?: string;
  arguments?: unknown;
}

interface CopilotStreamEvent {
  type?: string;
  data?: {
    messageId?: string;
    deltaContent?: string;
    content?: string;
    message?: string;
    toolRequests?: CopilotToolRequest[];
  };
  sessionId?: string;
  exitCode?: number;
  error?: string;
  message?: string;
}

const READ_ONLY_TOOLS = 'view,glob,grep';
const WORKSPACE_WRITE_TOOLS = 'view,glob,grep,edit,create';

export class GitHubCopilotRunner extends CliRunnerBase {
  protected readonly command = 'copilot';
  protected readonly displayName = 'GitHub Copilot CLI';
  protected readonly logPrefix = 'github-copilot';

  private readonly systemPrompt: string;
  private readonly permissionMode: CopilotPermissionMode;
  private readonly maxAiCredits?: number;

  constructor(options?: GitHubCopilotOptions) {
    super(options);
    this.systemPrompt = buildSystemPrompt(options?.platform);
    this.permissionMode = options?.copilotPermissionMode ?? 'read-only';
    this.maxAiCredits = options?.copilotMaxAiCredits;
  }

  private buildFullPrompt(rawPrompt: string): string {
    const promptWithRuntime = prependRuntimeContext(rawPrompt, this.workdir);
    return this.systemPrompt
      ? `<system-context>\n${this.systemPrompt}\n</system-context>\n\n${promptWithRuntime}`
      : promptWithRuntime;
  }

  private buildArgs(fullPrompt: string, options?: RunOptions): string[] {
    const args = [
      '-p',
      fullPrompt,
      '--output-format',
      'json',
      '--stream',
      'on',
      '--no-ask-user',
      '--no-auto-update',
      '--no-remote-export',
    ];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      // Non-interactive xangi sessions cannot answer approval prompts. Match the
      // other CLI backends' SKIP_PERMISSIONS=true behavior and expose the full
      // Copilot agent, including shell, URLs, paths, and built-in MCP tools.
      args.push('--yolo');
    } else {
      const tools =
        this.permissionMode === 'workspace-write' ? WORKSPACE_WRITE_TOOLS : READ_ONLY_TOOLS;
      const permissions = this.permissionMode === 'workspace-write' ? 'read,write' : 'read';
      args.push(
        '--disable-builtin-mcps',
        '--disallow-temp-dir',
        `--available-tools=${tools}`,
        `--allow-tool=${permissions}`
      );
    }

    if (this.workdir) args.push('-C', this.workdir);
    if (options?.sessionId) args.push('--session-id', options.sessionId);
    if (this.model) args.push('--model', this.model);
    if (options?.effort) args.push('--effort', options.effort);
    if (this.maxAiCredits !== undefined) {
      args.push('--max-ai-credits', String(this.maxAiCredits));
    }
    if (process.env.COPILOT_GITHUB_TOKEN) {
      args.push('--secret-env-vars=COPILOT_GITHUB_TOKEN');
    }
    return args;
  }

  private isStaleResumeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /session (?:was )?not found|no session found|unable to (?:find|resume).*session/i.test(
      message
    );
  }

  protected buildEnv(channelId?: string): NodeJS.ProcessEnv {
    const env = super.buildEnv(channelId);
    // Do not inherit generic GH_TOKEN/GITHUB_TOKEN values: xangi commonly uses
    // installation tokens there, while Copilot requires a user-authorized token.
    if (process.env.COPILOT_GITHUB_TOKEN) {
      env.COPILOT_GITHUB_TOKEN = process.env.COPILOT_GITHUB_TOKEN;
    }
    return env;
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
      if (!options?.sessionId || !this.isStaleResumeError(error)) {
        const err = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(err);
        throw error;
      }
      console.warn(
        `[github-copilot] Resume failed for stale session ${options.sessionId.slice(0, 8)}..., retrying with a new session`
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
    const streamedMessages = new Map<string, { text: string; start: number }>();
    const emittedToolIds = new Set<string>();

    return {
      handleEvent: (json) => {
        const event = json as CopilotStreamEvent;
        if (!backendReady && event.type === 'assistant.turn_start') {
          backendReady = true;
          callbacks.onBackendReady?.();
        }

        if (event.type === 'assistant.message_delta' && event.data?.deltaContent) {
          const delta = event.data.deltaContent;
          if (event.data.messageId) {
            const previous = streamedMessages.get(event.data.messageId) ?? {
              text: '',
              start: fullText.length,
            };
            streamedMessages.set(event.data.messageId, {
              text: previous.text + delta,
              start: previous.start,
            });
          }
          fullText += delta;
          callbacks.onText?.(delta, fullText);
        }

        if (event.type === 'assistant.message') {
          const data = event.data;
          for (const tool of data?.toolRequests ?? []) {
            const id = tool.toolCallId || `${tool.name}:${JSON.stringify(tool.arguments)}`;
            if (!tool.name || emittedToolIds.has(id)) continue;
            emittedToolIds.add(id);
            const input =
              tool.arguments && typeof tool.arguments === 'object' && !Array.isArray(tool.arguments)
                ? (tool.arguments as Record<string, unknown>)
                : { value: tool.arguments };
            callbacks.onToolUse?.(tool.name, input);
          }

          const content = data?.content;
          if (content) {
            const streamed = data?.messageId ? streamedMessages.get(data.messageId) : undefined;
            const remainder =
              streamed !== undefined && content.startsWith(streamed.text)
                ? content.slice(streamed.text.length)
                : streamed === undefined
                  ? content
                  : '';
            if (streamed && !content.startsWith(streamed.text)) {
              fullText = fullText.slice(0, streamed.start) + content;
              console.warn(
                `[github-copilot] Final message did not match streamed deltas for ${data?.messageId}; canonical content retained`
              );
            }
            if (remainder) {
              fullText += remainder;
              callbacks.onText?.(remainder, fullText);
            }
          }
        }

        if (event.type === 'result') {
          sessionId = event.sessionId || sessionId;
          if (event.exitCode && event.exitCode !== 0) {
            errorDetail = `Copilot result exit code ${event.exitCode}`;
          }
        }

        if (event.type === 'error' || event.type === 'result.error') {
          errorDetail = event.data?.message || event.message || event.error || event.type;
        }
      },
      finalize: () => {
        if (errorDetail) throw new Error(errorDetail);
        if (!sessionId) throw new Error('GitHub Copilot CLI stream ended without a result event');
        return { result: fullText, sessionId };
      },
      exitErrorDetail: () => errorDetail,
    };
  }
}
