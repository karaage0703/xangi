import { readCodexTurnEvidence } from './codex-model-evidence.js';
import { updateSessionContextUsage } from './sessions.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CliRunnerBase } from './cli-runner-core.js';
import { buildSystemPrompt, type BaseRunnerOptions } from './base-runner.js';
import { buildCliEnv } from './cli-process.js';
import { configuredBackendCommand } from './setup/backend-executable.js';
import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';

// Wire payloads are narrowed before use; no tool inputs/outputs enter timing logs.
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
interface Pending {
  resolve: (v: Obj) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
interface Turn {
  threadId: string;
  turnId?: string;
  callbacks: StreamCallbacks;
  result: RunResult;
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
  first: boolean;
  pending: Obj[];
  stopTimer?: NodeJS.Timeout;
}

/** One process per LINE conversation: CLI tool environment cannot leak across users. */
export class CodexAppServerRunner extends CliRunnerBase {
  protected readonly command = 'codex';
  protected readonly displayName = 'Codex App Server';
  protected readonly logPrefix = 'codex-app-server';
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private loaded = new Map<string, { skip: boolean; sandbox: Obj }>();
  private turn?: Turn;
  private running = false;
  private systemPrompt: string;
  private channelId: string;
  private runnerPlatform: BaseRunnerOptions['platform'];
  constructor(options: BaseRunnerOptions & { channelId: string }) {
    super(options);
    this.channelId = options.channelId;
    this.runnerPlatform = options.platform;
    this.systemPrompt = buildSystemPrompt(options.platform);
  }
  protected createStreamParser(): never {
    throw new Error('App server uses JSON-RPC');
  }
  private mark(stage: string, callbacks?: StreamCallbacks) {
    callbacks?.onTraceEvent?.({ type: 'transport_timing', stage });
  }
  async warm(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } catch (error) {
      this.starting = undefined;
      throw error;
    }
  }
  private async start() {
    const env = buildCliEnv(this.channelId, this.runnerPlatform, this.workdir);
    const child = spawn(configuredBackendCommand('codex', env), ['app-server'], {
      cwd: this.workdir,
      env,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    });
    this.child = child;
    const spawnAt = Date.now();
    console.info(
      JSON.stringify({
        component: 'codex-line-transport',
        stage: 'process_spawn',
        at: new Date().toISOString(),
      })
    );
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child) return;
      try {
        this.receive(obj(JSON.parse(line)));
      } catch {
        this.fail(new Error('Invalid app-server response'));
      }
    });
    lines.on('close', () => {
      if (this.child === child) this.fail(new Error('App-server stdout closed'));
    });
    // Drain diagnostics without printing potentially sensitive provider error text.
    child.stderr.resume();
    child.stdin.on('error', () => {
      if (this.child === child) this.fail(new Error('App-server stdin closed'));
    });
    child.on('error', () => {
      if (this.child === child) this.fail(new Error('App-server launch failed'));
    });
    child.on('close', () => {
      lines.close();
      if (this.child === child) this.fail(new Error('App-server exited'));
    });
    try {
      await this.rpc('initialize', { clientInfo: { name: 'xangi_line', version: '1.0.0' } });
      this.write({ method: 'initialized' });
      console.info(
        JSON.stringify({
          component: 'codex-line-transport',
          stage: 'initialized',
          at: new Date().toISOString(),
          durationMs: Date.now() - spawnAt,
        })
      );
    } catch (error) {
      this.fail(new Error('App-server initialization failed'));
      throw error;
    }
  }
  private write(value: Obj) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('App-server disconnected');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private rpc(method: string, params: Obj): Promise<Obj> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail(new Error('App-server RPC timed out')), 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch {
        this.fail(new Error('App-server disconnected'));
      }
    });
  }
  private receive(message: Obj) {
    if (typeof message.id === 'number' && !message.method) {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.id);
      if (message.error) p.reject(new Error('App-server request rejected'));
      else p.resolve(obj(message.result));
      return;
    }
    if (message.method && message.id !== undefined) {
      // Noninteractive, fail closed. Never silently grant an unexpected approval.
      this.write({
        id: message.id,
        error: { code: -32601, message: 'Interactive requests unsupported' },
      });
      if (this.turn) this.cancel();
      return;
    }
    const t = this.turn;
    if (!t) return;
    const p = obj(message.params);
    if (p.threadId !== t.threadId) return;
    if (!t.turnId) {
      t.pending.push(message);
      return;
    }
    if (p.turnId !== undefined && p.turnId !== t.turnId) return;
    const method = str(message.method);
    if (method === 'turn/started') {
      if (obj(p.turn).id === t.turnId) t.callbacks.onTraceEvent?.({ type: 'turn_started' });
    } else if (method === 'item/agentMessage/delta') {
      if (!t.first) {
        t.first = true;
        this.mark('first_response', t.callbacks);
      }
      const delta = str(p.delta);
      t.result.result += delta;
      t.callbacks.onText?.(delta, t.result.result);
    } else if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = obj(p.tokenUsage);
      const last = obj(tokenUsage.last);
      const total = obj(tokenUsage.total ?? tokenUsage.last);
      t.result.usage = {
        inputTokens: Number(total.inputTokens ?? 0),
        cachedInputTokens: Number(total.cachedInputTokens ?? 0),
        outputTokens: Number(total.outputTokens ?? 0),
        contextTokens: Number(last.totalTokens ?? 0),
        ...(typeof tokenUsage.modelContextWindow === 'number'
          ? { contextWindow: tokenUsage.modelContextWindow }
          : {}),
      };
    } else if (method === 'model/rerouted') {
      const model = str(p.toModel);
      if (model) {
        t.result.model = model;
        t.callbacks.onModel?.(model);
      }
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = obj(p.item);
      const type = str(item.type);
      if (type === 'agentMessage' && method === 'item/completed') {
        // Only the final message is the returned answer; deltas remain available to UI.
        if (item.phase === 'final_answer' || item.phase == null) t.result.result = str(item.text);
      } else if (
        [
          'commandExecution',
          'mcpToolCall',
          'dynamicToolCall',
          'fileChange',
          'webSearch',
          'imageView',
          'imageGeneration',
          'collabAgentToolCall',
          'sleep',
        ].includes(type)
      ) {
        if (method === 'item/started') t.callbacks.onToolUse?.(type, {});
        t.callbacks.onTraceEvent?.({
          type: method === 'item/started' ? 'tool_started' : 'tool_completed',
          toolName: type,
          toolId: str(item.id),
        });
      }
    } else if (method === 'turn/completed') {
      const turn = obj(p.turn);
      if (turn.id !== t.turnId) return;
      this.mark('completed', t.callbacks);
      t.callbacks.onTraceEvent?.({ type: 'turn_completed', usage: t.result.usage });
      if (turn.status !== 'completed' || t.cancelled)
        this.finish(new Error('Codex turn interrupted or failed'));
      else this.finish();
    }
  }
  private finish(error?: Error) {
    const t = this.turn;
    if (!t) return;
    this.turn = undefined;
    clearTimeout(t.stopTimer);
    if (error) t.reject(error);
    else t.resolve(t.result);
  }
  private fail(error: Error) {
    const child = this.child;
    this.child = undefined;
    this.starting = undefined;
    this.loaded.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.finish(error);
    if (child?.pid) {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }
  }
  cancel(): boolean {
    if (!this.running) return false;
    const t = this.turn;
    if (!t?.turnId) {
      this.fail(new Error('Codex preparation cancelled'));
      return true;
    }
    if (t.cancelled) return true;
    t.cancelled = true;
    t.stopTimer = setTimeout(() => this.fail(new Error('Codex interrupt timed out')), 5_000);
    void this.rpc('turn/interrupt', { threadId: t.threadId, turnId: t.turnId }).catch(() =>
      this.fail(new Error('Codex interrupt failed'))
    );
    return true;
  }
  shutdown() {
    this.fail(new Error('App-server shut down'));
  }
  destroy(): boolean {
    this.shutdown();
    return true;
  }
  hasRunner(): boolean {
    return !!this.child;
  }
  async run(prompt: string, options?: RunOptions) {
    return this.runStream(prompt, {}, options);
  }
  async runStream(
    rawPrompt: string,
    callbacks: StreamCallbacks,
    options: RunOptions = {}
  ): Promise<RunResult> {
    if (this.running) throw new Error('Codex conversation already active');
    this.running = true;
    const startedAt = new Date().toISOString();
    this.timeoutController.start(this.channelId, () => this.cancel());
    try {
      this.mark('prepare_start', callbacks);
      await this.warm();
      this.mark('initialized', callbacks);
      const skip = options.skipPermissions ?? this.skipPermissions;
      const cwd = this.workdir ?? process.cwd();
      let threadId = options.sessionId;
      let model: string | undefined;
      if (!threadId || this.loaded.get(threadId)?.skip !== skip) {
        const result = await this.rpc(threadId ? 'thread/resume' : 'thread/start', {
          ...(threadId ? { threadId } : {}),
          cwd,
          model: this.model,
          approvalPolicy: 'never',
          sandbox: skip ? 'danger-full-access' : 'workspace-write',
        });
        threadId = str(obj(result.thread).id);
        if (!threadId) throw new Error('App-server missing thread id');
        model = str(result.model) || undefined;
        const sandbox = obj(result.sandbox);
        if (!sandbox.type) throw new Error('App-server missing effective sandbox policy');
        this.loaded.set(threadId, { skip, sandbox });
      }
      this.mark('thread_ready', callbacks);
      callbacks.onBackendReady?.();
      const prompt = this.buildTaggedPrompt(rawPrompt, this.systemPrompt, !options.sessionId);
      this.logPromptTranscript(prompt, options);
      const completed = new Promise<RunResult>((resolve, reject) => {
        this.turn = {
          threadId: threadId!,
          callbacks,
          resolve,
          reject,
          cancelled: false,
          first: false,
          pending: [],
          result: { result: '', sessionId: threadId!, ...(model ? { model } : {}) },
        };
      });
      // Attach rejection handler immediately: transport can close before turn/start resolves.
      void completed.catch(() => undefined);
      this.mark('turn_sent', callbacks);
      try {
        const response = await this.rpc('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt }],
          cwd,
          model: this.model,
          effort: options.effort,
          approvalPolicy: 'never',
          sandboxPolicy: this.loaded.get(threadId)?.sandbox,
        });
        const t = this.turn;
        if (t) {
          t.turnId = str(obj(response.turn).id);
          if (!t.turnId) throw new Error('App-server missing turn id');
          for (const event of t.pending.splice(0)) this.receive(event);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Codex start failed'));
      }
      const result = await completed;
      const evidence = await readCodexTurnEvidence({
        providerSessionId: result.sessionId,
        cwd,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      if (evidence.models.length) {
        result.models = evidence.models;
        result.model = evidence.models.at(-1);
        callbacks.onModel?.(result.model!);
      }
      if (evidence.effort) {
        result.effort = evidence.effort;
        callbacks.onEffort?.(evidence.effort);
      }
      if (
        options.appSessionId &&
        result.usage?.contextWindow &&
        result.usage.contextTokens !== undefined
      ) {
        updateSessionContextUsage(options.appSessionId, {
          usedTokens: result.usage.contextTokens,
          contextWindow: result.usage.contextWindow,
          source: 'codex-app-server',
        });
      }
      this.logResponseTranscript(result, options);
      callbacks.onComplete?.(result);
      return result;
    } catch (error) {
      const e = error instanceof Error ? error : new Error('Codex failed');
      callbacks.onError?.(e);
      throw e;
    } finally {
      this.running = false;
      this.timeoutController.clear(this.channelId, 'completed');
    }
  }
}
