import { randomUUID } from 'node:crypto';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import type { AgentConfig } from './config.js';
import { resolveExtensionAgentBackend, type ResolvedExtensionAgentBackend } from './extensions.js';
import { logPrompt, logResponse } from './transcript-logger.js';

interface ExtensionAgentResponse {
  schemaVersion?: number;
  result?: string;
  sessionId?: string;
}

export interface ExtensionAgentRunnerOptions extends AgentConfig {
  backend: ResolvedExtensionAgentBackend;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function timeoutFromEnvironment(): number {
  const parsed = Number(process.env.EXTENSION_BACKEND_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 60_000 ? parsed : DEFAULT_TIMEOUT_MS;
}

/** Generic HTTP adapter for an agent backend declared by an enabled extension. */
export class ExtensionAgentRunner implements AgentRunner {
  private readonly backend: ResolvedExtensionAgentBackend;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly workdir?: string;
  private readonly active = new Map<string, AbortController>();

  constructor(options: ExtensionAgentRunnerOptions) {
    this.backend = options.backend;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? timeoutFromEnvironment();
    this.workdir = options.workdir;
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    return this.execute(prompt, options);
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    callbacks.onBackendReady?.();
    try {
      const result = await this.execute(prompt, options);
      callbacks.onText?.(result.result, result.result);
      callbacks.onComplete?.(result);
      return result;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      callbacks.onError?.(normalized);
      throw normalized;
    }
  }

  cancel(channelId?: string): boolean {
    const controller = this.active.get(channelId ?? 'default');
    if (!controller) return false;
    controller.abort(new Error('Request cancelled by user'));
    return true;
  }

  private async execute(prompt: string, options?: RunOptions): Promise<RunResult> {
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, prompt);
    }
    const key = options?.channelId ?? 'default';
    const controller = new AbortController();
    this.active.set(key, controller);
    const timer = setTimeout(
      () => controller.abort(new Error(`${this.backend.displayName} timed out`)),
      this.timeoutMs
    );
    try {
      const current = resolveExtensionAgentBackend(this.backend.id);
      if (!current) {
        throw new Error(`${this.backend.displayName} extension is not linked or enabled`);
      }
      if (!current.baseUrl || !current.authorization) {
        throw new Error(`${this.backend.displayName} extension runtime is unavailable`);
      }
      const endpoint = new URL(current.path, `${current.baseUrl}/`);
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: current.authorization,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          prompt,
          userText: options?.userText,
          platform: options?.platform,
          workspaceUrl: process.env.XANGI_PUBLIC_WEB_URL,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`${current.displayName} failed: HTTP ${response.status}`);
      }
      const payload = (await response.json()) as ExtensionAgentResponse;
      if (payload.schemaVersion !== 1 || typeof payload.result !== 'string') {
        throw new Error(`${current.displayName} returned an invalid agent response`);
      }
      const runResult: RunResult = {
        result: payload.result,
        sessionId: payload.sessionId ?? `${current.id}:${options?.channelId ?? randomUUID()}`,
      };
      if (options?.appSessionId && this.workdir) {
        logResponse(this.workdir, options.appSessionId, {
          result: runResult.result,
          sessionId: runResult.sessionId,
        });
      }
      return runResult;
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.active.get(key) === controller) this.active.delete(key);
    }
  }
}
