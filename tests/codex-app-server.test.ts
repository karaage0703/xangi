import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ spawns: [] as unknown[] }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../src/cli-process.js', () => ({ buildCliEnv: () => ({}) }));
vi.mock('../src/setup/backend-executable.js', () => ({ configuredBackendCommand: () => 'codex' }));
import { spawn } from 'node:child_process';
import { CodexAppServerRunner } from '../src/codex-app-server.js';

class Server extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests: Record<string, any>[] = []; // test protocol fixture
  pid = undefined;
  kill = vi.fn();
  autoComplete = true;
  interruptCompletes = true;
  failInitialize = false;
  holdInitialize = false;
  thread = 'thread-a';
  turns = 0;
  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      const request = JSON.parse(chunk.toString());
      this.requests.push(request);
      const { method, id } = request;
      if (method === 'initialize' && this.holdInitialize) return;
      if (method === 'initialize')
        this.send({ id, ...(this.failInitialize ? { error: { code: -1 } } : { result: {} }) });
      if (method === 'thread/start' || method === 'thread/resume')
        this.send({
          id,
          result: {
            thread: { id: this.thread },
            model: 'gpt-5.6-luna',
            reasoningEffort: 'medium',
            sandbox: { type: 'workspaceWrite', networkAccess: false },
          },
        });
      if (method === 'turn/start') {
        const turnId = `turn-${++this.turns}`;
        // Notifications can precede the RPC response.
        this.send({
          method: 'turn/started',
          params: { threadId: this.thread, turn: { id: turnId } },
        });
        this.send({ id, result: { turn: { id: turnId } } });
        if (this.autoComplete) this.complete(turnId);
      }
      if (method === 'turn/interrupt') {
        this.send({ id, result: {} });
        if (this.interruptCompletes)
          this.send({
            method: 'turn/completed',
            params: {
              threadId: this.thread,
              turn: { id: request.params.turnId, status: 'interrupted' },
            },
          });
      }
    });
  }
  send(x: unknown) {
    const line = JSON.stringify(x) + '\n';
    this.stdout.write(line.slice(0, 7));
    this.stdout.write(line.slice(7));
  }
  complete(turnId = `turn-${this.turns}`) {
    this.send({
      method: 'item/agentMessage/delta',
      params: { threadId: 'wrong-thread', turnId, delta: 'leak' },
    });
    this.send({
      method: 'item/agentMessage/delta',
      params: { threadId: this.thread, turnId: 'wrong-turn', delta: 'leak' },
    });
    this.send({
      method: 'item/started',
      params: { threadId: this.thread, turnId, item: { id: 'tool', type: 'commandExecution' } },
    });
    this.send({
      method: 'item/completed',
      params: { threadId: this.thread, turnId, item: { id: 'tool', type: 'commandExecution' } },
    });
    this.send({
      method: 'item/started',
      params: { threadId: this.thread, turnId, item: { id: 'image', type: 'imageView' } },
    });
    this.send({
      method: 'item/completed',
      params: { threadId: this.thread, turnId, item: { id: 'image', type: 'imageView' } },
    });
    this.send({
      method: 'item/agentMessage/delta',
      params: { threadId: this.thread, turnId, delta: 'hello' },
    });
    this.send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: this.thread,
        turnId,
        tokenUsage: {
          last: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, totalTokens: 12 },
          modelContextWindow: 1000,
        },
      },
    });
    this.send({
      method: 'item/completed',
      params: {
        threadId: this.thread,
        turnId,
        item: { type: 'agentMessage', phase: 'final_answer', text: 'hello' },
      },
    });
    this.send({
      method: 'turn/completed',
      params: { threadId: this.thread, turn: { id: turnId, status: 'completed' } },
    });
  }
}
const runners: CodexAppServerRunner[] = [];
function runner(timeoutMs = 1000) {
  const r = new CodexAppServerRunner({
    channelId: 'line:test',
    model: 'gpt-5.6-luna',
    workdir: '/tmp',
    platform: 'line',
    timeoutMs,
  });
  runners.push(r);
  return r;
}
let server: Server;
beforeEach(() => {
  vi.mocked(spawn).mockImplementation(() => {
    server = new Server();
    state.spawns.push(server);
    return server as never;
  });
  state.spawns = [];
});
afterEach(() => {
  for (const r of runners.splice(0)) r.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const opts = { channelId: 'line:test', effort: 'medium' as const };
describe('persistent Codex transport', () => {
  it('reuses process/thread, streams fragmented JSON, isolates foreign events and preserves usage', async () => {
    const r = runner();
    await r.warm();
    const onText = vi.fn(),
      onTraceEvent = vi.fn();
    const a = await r.runStream('hello', { onText, onTraceEvent }, opts);
    const b = await r.run('again', { ...opts, sessionId: a.sessionId });
    expect(a.result).toBe('hello');
    expect(b.result).toBe('hello');
    expect(a.usage?.cachedInputTokens).toBe(5);
    expect(state.spawns).toHaveLength(1);
    expect(server.requests.filter((x) => x.method === 'thread/start')).toHaveLength(1);
    expect(server.requests.filter((x) => x.method === 'thread/resume')).toHaveLength(0);
    expect(onText).toHaveBeenCalledWith('hello', 'hello');
    expect(onTraceEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_started' }));
    const turns = server.requests.filter((x) => x.method === 'turn/start');
    expect(turns[0].params.effort).toBe('medium');
    expect(turns[0].params.sandboxPolicy.type).toBe('workspaceWrite');
  });
  it('resumes existing thread once and forwards image attachment prompt', async () => {
    const r = runner();
    await r.run('attached image /tmp/photo.png', { ...opts, sessionId: 'thread-a' });
    await r.run('again', { ...opts, sessionId: 'thread-a' });
    expect(server.requests.filter((x) => x.method === 'thread/resume')).toHaveLength(1);
    expect(server.requests.find((x) => x.method === 'turn/start')?.params.input[0].text).toContain(
      '/tmp/photo.png'
    );
  });
  it('cancels then allows another turn', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const first = r.run('hello', opts);
    const rejected = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(server.turns).toBe(1));
    expect(r.cancel()).toBe(true);
    await rejected;
    server.autoComplete = true;
    expect((await r.run('next', { ...opts, sessionId: 'thread-a' })).result).toBe('hello');
  });
  it('rejects active work on disconnect and starts a new process next time without replay', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const first = r.run('hello', opts);
    const rejected = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(server.turns).toBe(1));
    server.emit('close', 1);
    await rejected;
    expect((await r.run('next', { ...opts, sessionId: 'thread-a' })).result).toBe('hello');
    expect(state.spawns).toHaveLength(2);
    expect(server.requests.filter((x) => x.method === 'turn/start')).toHaveLength(1);
  });
  it('bounds initialization to 15 seconds', async () => {
    vi.useFakeTimers();
    vi.mocked(spawn).mockImplementation(() => {
      server = new Server();
      server.holdInitialize = true;
      return server as never;
    });
    const r = runner();
    const pending = r.warm();
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15001);
    await rejected;
  });
  it('interrupts on timeout and force releases after five seconds', async () => {
    vi.useFakeTimers();
    const r = runner(100);
    await r.warm();
    server.autoComplete = false;
    server.interruptCompletes = false;
    const pending = r.run('hello', opts);
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5200);
    await rejected;
    expect(server.requests.some((x) => x.method === 'turn/interrupt')).toBe(true);
    expect(r.hasRunner()).toBe(false);
  });
  it('rejects concurrent requests rather than mixing conversations', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const pending = r.run('hello', opts);
    const rejected = expect(pending).rejects.toThrow();
    await expect(r.run('other', opts)).rejects.toThrow('already active');
    r.shutdown();
    await rejected;
  });
  it('rejects a broken stdout immediately and never replays an uncertain turn', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const pending = r.run('hello', opts);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(server.turns).toBe(1));
    server.stdout.end();
    await rejected;
    expect(r.hasRunner()).toBe(false);
  });
  it('fails closed on a server approval request and releases the turn', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const pending = r.run('hello', opts);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(server.turns).toBe(1));
    server.send({
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-a', turnId: 'turn-1' },
    });
    await rejected;
    expect(server.requests.some((x) => x.id === 99 && x.error)).toBe(true);
  });
});
