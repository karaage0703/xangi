import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ spawns: [] as unknown[] }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../src/cli-process.js', () => ({ buildCliEnv: () => ({}) }));
vi.mock('../src/setup/backend-executable.js', () => ({ configuredBackendCommand: () => 'codex' }));
import { spawn } from 'node:child_process';
import { stripReplySuggestionMarkup } from '../src/reply-suggestions.js';
import { StreamSession } from '../src/stream-session.js';
import { addToolHistory } from '../src/tool-history.js';
import { CodexRunner } from '../src/codex-cli.js';
import { CodexAppServerRunner } from '../src/codex-app-server.js';
import { requestUserInput, listUserInputs } from '../src/user-input.js';

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
      if (method === 'turn/steer')
        this.send({ id, result: { turnId: request.params.expectedTurnId } });
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
  it('keeps command details and distinct tool calls visible through the shared renderer', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const session = new StreamSession({
      formatToolLine: (name, input) => {
        const lines: string[] = [];
        addToolHistory(lines, name, input);
        return lines[0];
      },
      render: async () => {},
    });
    const onToolUse = vi.fn();
    const pending = r.runStream('check', session.callbacks({ onToolUse }), opts);
    await vi.waitFor(() => expect(server.turns).toBe(1));
    const items = [
      { id: 'one', type: 'commandExecution', command: 'git status --short' },
      { id: 'two', type: 'commandExecution', command: 'npm run build' },
      {
        id: 'mcp',
        type: 'mcpToolCall',
        server: 'docs',
        tool: 'search',
        arguments: { query: 'test' },
      },
      {
        id: 'dynamic',
        type: 'dynamicToolCall',
        tool: 'Read',
        arguments: { file_path: '/tmp/example.ts' },
      },
    ];
    for (const item of items) {
      // Events from other conversations must not leak commands into this view.
      server.send({
        method: 'item/started',
        params: { threadId: 'other', turnId: 'turn-1', item },
      });
      for (const method of ['item/started', 'item/completed'])
        server.send({ method, params: { threadId: server.thread, turnId: 'turn-1', item } });
    }
    server.complete();
    await pending;
    const lines = session.view().toolLines;
    session.finish();
    expect(lines).toContain('🔧 Bash実行: `git status --short`');
    expect(lines).toContain('🔧 Bash実行: `npm run build`');
    expect(onToolUse).toHaveBeenCalledWith('mcp__docs__search', { query: 'test' });
    expect(onToolUse).toHaveBeenCalledWith('Read', { file_path: '/tmp/example.ts' });
    expect(onToolUse.mock.calls.filter(([name]) => name === 'Bash')).toHaveLength(2);
  });
  it('forwards completed file changes and ignores rejected edits', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const onFileChanges = vi.fn();
    const pending = r.runStream('edit', { onFileChanges }, opts);
    await vi.waitFor(() => expect(server.turns).toBe(1));
    for (const status of ['inProgress', 'failed', 'completed'])
      server.send({
        method: 'item/completed',
        params: {
          threadId: server.thread,
          turnId: 'turn-1',
          item: {
            id: status,
            type: 'fileChange',
            status,
            changes: [
              {
                path: 'a',
                kind: { type: 'update', move_path: null },
                diff: '@@ -1 +1 @@\n-old\n+new',
              },
            ],
          },
        },
      });
    server.complete();
    await pending;
    expect(onFileChanges).toHaveBeenCalledTimes(1);
    expect(onFileChanges).toHaveBeenCalledWith([
      { path: 'a', operation: 'modified', diff: '@@ -1 +1 @@\n-old\n+new' },
    ]);
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
    const rejected = expect(first).rejects.toThrow('Request cancelled by user');
    await vi.waitFor(() => expect(server.turns).toBe(1));
    expect(r.cancel()).toBe(true);
    await rejected;
    server.autoComplete = true;
    expect((await r.run('next', { ...opts, sessionId: 'thread-a' })).result).toBe('hello');
  });
  it('reports a user cancellation when the app server is destroyed immediately afterwards', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    server.interruptCompletes = false;
    const pending = r.run('hello', opts);
    const rejected = expect(pending).rejects.toThrow('Request cancelled by user');
    await vi.waitFor(() => expect(server.turns).toBe(1));
    expect(r.cancel()).toBe(true);
    r.shutdown();
    await rejected;
  });
  it('keeps an unrelated server shutdown distinct from user cancellation', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const pending = r.run('hello', opts);
    const rejected = expect(pending).rejects.toThrow('App-server shut down');
    await vi.waitFor(() => expect(server.turns).toBe(1));
    r.shutdown();
    await rejected;
  });
  it('reports cancellation while preparing and releases the runner', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      server = new Server();
      server.holdInitialize = true;
      return server as never;
    });
    const r = runner();
    const pending = r.run('hello', opts);
    const rejected = expect(pending).rejects.toThrow('Request cancelled by user');
    expect(r.cancel()).toBe(true);
    await rejected;
    expect(r.cancel()).toBe(false);
  });
  it('keeps provider failures distinct from user cancellation', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const pending = r.run('hello', opts);
    const rejected = expect(pending).rejects.toThrow('Codex turn interrupted or failed');
    await vi.waitFor(() => expect(server.turns).toBe(1));
    server.send({
      method: 'turn/completed',
      params: {
        threadId: server.thread,
        turn: { id: 'turn-1', status: 'failed' },
      },
    });
    await rejected;
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

describe('provider retry status', () => {
  it('delivers bounded stderr warnings only to the matching active turn and clears on recovery', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const onStatus = vi.fn();
    const pending = r.runStream('hello', { onStatus }, opts);
    await vi.waitFor(() => expect(server.turns).toBe(1));
    const warning = (turnId: string) =>
      `WARN codex_core::responses_retry: stream disconnected - retrying sampling request (1/5 in 318s)... turn_id=${turnId} retries=1 max_retries=5 sampling_error=429 Too Many Requests SECRET\n`;
    server.stderr.write(warning('foreign-turn'));
    expect(onStatus).not.toHaveBeenCalled();
    const line = warning('turn-1');
    server.stderr.write(line.slice(0, 30));
    server.stderr.write(line.slice(30));
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'rate_limit', retryAt: expect.any(Number) })
    );
    server.complete();
    await pending;
    expect(onStatus).toHaveBeenLastCalledWith(null);
    const count = onStatus.mock.calls.length;
    server.stderr.write(warning('turn-1'));
    expect(onStatus).toHaveBeenCalledTimes(count);
    expect(JSON.stringify(onStatus.mock.calls)).not.toContain('SECRET');
  });
  it('handles protocol retry and exposes terminal 429 without raw provider text', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const onStatus = vi.fn();
    const pending = r.runStream('hello', { onStatus }, opts);
    const rejected = expect(pending).rejects.toThrow('429');
    await vi.waitFor(() => expect(server.turns).toBe(1));
    const error = {
      message: 'SECRET',
      codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
    };
    server.send({
      method: 'error',
      params: { threadId: server.thread, turnId: 'turn-1', willRetry: true, error },
    });
    expect(onStatus).toHaveBeenCalledWith({ reason: 'rate_limit' });
    server.send({
      method: 'turn/completed',
      params: { threadId: server.thread, turn: { id: 'turn-1', status: 'failed', error } },
    });
    await rejected;
  });
});

describe('Codex user questions', () => {
  it('returns answers to the same pending request and resumes the turn', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const onUserInput = vi.fn(async () => ({ answers: { choice: ['B'] } }));
    const result = r.runStream('ask', { onUserInput }, opts);
    await vi.waitFor(() => expect(server.turns).toBe(1));
    server.send({
      id: 'question-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: server.thread,
        turnId: 'turn-1',
        questions: [{ id: 'choice', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
      },
    });
    await vi.waitFor(() =>
      expect(server.requests.find((x) => x.id === 'question-1')?.result).toEqual({
        answers: { choice: { answers: ['B'] } },
      })
    );
    server.complete();
    expect((await result).result).toBe('hello');
  });
  it('rejects foreign turn questions without presenting them', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const onUserInput = vi.fn();
    const result = r.runStream('ask', { onUserInput }, opts);
    await vi.waitFor(() => expect(server.turns).toBe(1));
    server.send({
      id: 'foreign',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'other', turnId: 'turn-1', questions: [] },
    });
    expect(onUserInput).not.toHaveBeenCalled();
    expect(server.requests.find((x) => x.id === 'foreign')?.error).toBeTruthy();
    server.complete();
    await result;
  });
  it('aborts the question when the backend resolves it before the user', async () => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    let signal: AbortSignal | undefined;
    const result = r.runStream(
      'ask',
      {
        onUserInput: async (_q, s) => {
          signal = s;
          return new Promise((resolve) =>
            s.addEventListener('abort', () => resolve({ cancelled: true }))
          );
        },
      },
      opts
    );
    await vi.waitFor(() => expect(server.turns).toBe(1));
    server.send({
      id: 'gone',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: server.thread,
        turnId: 'turn-1',
        questions: [{ id: 'q', question: '?' }],
      },
    });
    server.send({
      method: 'serverRequest/resolved',
      params: { threadId: server.thread, requestId: 'gone' },
    });
    expect(signal?.aborted).toBe(true);
    server.complete();
    await result;
    expect(server.requests.find((x) => x.id === 'gone')).toBeUndefined();
  });
});

it.each([undefined, '今は回答できません。\n調査結果だけ報告してください。'])(
  'returns a synchronous timeout notice with message=%s',
  async (message) => {
    const r = runner();
    await r.warm();
    server.autoComplete = false;
    const result = r.runStream(
      'ask',
      { onUserInput: async () => ({ unavailable: true, message }) },
      opts
    );
    void result.catch(() => {});
    await vi.waitFor(() => expect(server.turns).toBe(1));
    server.send({
      id: 'timeout-q',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: server.thread,
        turnId: 'turn-1',
        questions: [
          { id: 'confirm', question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      },
    });
    await vi.waitFor(() => expect(server.requests.find((x) => x.id === 'timeout-q')).toBeDefined());
    const answer = server.requests.find((x) => x.id === 'timeout-q')!.result.answers.confirm
      .answers;
    expect(answer).toHaveLength(1);
    expect(answer[0]).toContain('[System notice');
    expect(answer[0]).toContain(message ?? 'unable to respond');
    expect(answer[0]).toContain('explicit authorization');
    expect(answer).not.toContain('Yes');
    expect(answer).not.toContain('No');
    expect(server.requests.some((x) => x.method === 'turn/interrupt')).toBe(false);
    server.complete();
    expect((await result).result).toBe('hello');
  }
);

describe('Codex async question delivery', () => {
  function question(turnId = 'turn-1') {
    return {
      method: 'item/completed',
      params: {
        threadId: server.thread,
        turnId,
        item: {
          type: 'agentMessage',
          id: 'async-q',
          delivery: 'async',
          phase: 'final_answer',
          text: 'Pick',
          questions: [{ title: 'Pick', options: ['Red', 'Blue'] }],
        },
      },
    };
  }
  it.each([false, true])(
    'delivers async questions and answers after completion=%s',
    async (completeFirst) => {
      const r = runner();
      await r.warm();
      server.autoComplete = false;
      let answer!: (value: { answers: Record<string, string[]> }) => void;
      let signal!: AbortSignal;
      const onUserInput = vi.fn(async (_request, s) => {
        signal = s;
        return new Promise<{ answers: Record<string, string[]> }>((resolve) => {
          answer = resolve;
        });
      });
      const onText = vi.fn();
      const result = r.runStream('ask', { onUserInput, onText }, opts);
      await vi.waitFor(() => expect(server.turns).toBe(1));
      server.send(question('foreign-turn'));
      expect(onUserInput).not.toHaveBeenCalled();
      server.send(question());
      server.send(question());
      expect(onUserInput).toHaveBeenCalledTimes(1);
      expect(onUserInput.mock.calls[0][0].questions[0]).toMatchObject({
        question: 'Pick',
        allowFreeText: true,
      });
      let resolved = false;
      void result.then(() => {
        resolved = true;
      });
      const before =
        'フォームを出しました。\n\n<xangi_reply_suggestions>["選択1","選択2","選択3"]</xangi_reply_suggestions>';
      server.send({
        method: 'item/completed',
        params: {
          threadId: server.thread,
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'before-answer', phase: 'final_answer', text: before },
        },
      });
      if (completeFirst)
        server.send({
          method: 'turn/completed',
          params: {
            threadId: server.thread,
            turn: { id: 'turn-1', status: 'completed' },
          },
        });
      await new Promise((resolve) => setImmediate(resolve));
      expect(signal.aborted).toBe(false);
      expect(resolved).toBe(false);
      answer({ answers: { '0': ['Blue'] } });
      await vi.waitFor(() =>
        expect(
          server.requests.some(
            (x) =>
              x.method === (completeFirst ? 'turn/start' : 'turn/steer') &&
              x.params.input?.[0]?.text.includes('questionItemId')
          )
        ).toBe(true)
      );
      expect(server.turns).toBe(completeFirst ? 2 : 1);
      for (const delta of ['回答を受け', '取りました。']) {
        server.send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: server.thread,
            turnId: `turn-${server.turns}`,
            itemId: 'after-answer',
            delta,
          },
        });
      }
      const full = onText.mock.calls.at(-1)![1];
      expect(full).toBe(before + '\n\n回答を受け取りました。');
      // Both Slack and Discord stream through this sanitizer. Keep the marker
      // on its own line so it cannot become a visible inline quotation.
      const visible = stripReplySuggestionMarkup(full);
      expect(visible).not.toContain('xangi_reply_suggestions');
      expect(visible).toContain('フォームを出しました。');
      expect(visible).toContain('回答を受け取りました。');
      server.complete();
      expect((await result).result).toBe('hello');
    }
  );
  it.each(['reply', 'stop'])(
    'handles a completed provider turn with timeout action=%s',
    async (action) => {
      const r = runner(10000);
      await r.warm();
      server.autoComplete = false;
      const result = r.runStream(
        'ask',
        {
          onUserInput: (request, signal) =>
            requestUserInput('web:expiry', 'web', request, signal, async () => {}),
        },
        opts
      );
      void result.catch(() => {});
      await vi.waitFor(() => expect(server.turns).toBe(1));
      vi.useFakeTimers();
      vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_MS', '1000');
      vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_ACTION', action);
      try {
        server.send(question());
        expect(listUserInputs('web:expiry', 'web')).toHaveLength(1);
        server.complete();
        await vi.advanceTimersByTimeAsync(999);
        expect(server.turns).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(server.turns).toBe(action === 'stop' ? 1 : 2);
        expect(listUserInputs('web:expiry', 'web')).toEqual([]);
        if (action === 'stop') await expect(result).rejects.toThrow('Request cancelled by user');
        else {
          server.complete();
          expect((await result).result).toContain('hello');
        }
      } finally {
        r.cancel();
        vi.unstubAllEnvs();
        vi.useRealTimers();
      }
    }
  );

  it.each(
    [false, true].flatMap((completed) =>
      [undefined, '今は回答できません。\n調査結果を報告して。'].map((message) => ({
        completed,
        message,
      }))
    )
  )(
    'continues with providerCompleted=$completed and message=$message',
    async ({ completed, message }) => {
      const r = runner();
      await r.warm();
      server.autoComplete = false;
      let unavailable!: (v: { unavailable: true; message?: string }) => void;
      const result = r.runStream(
        'ask',
        {
          onUserInput: async () =>
            new Promise<{ unavailable: true; message?: string }>((resolve) => {
              unavailable = resolve;
            }),
        },
        opts
      );
      void result.catch(() => {});
      await vi.waitFor(() => expect(server.turns).toBe(1));
      server.send(question());
      if (completed) server.complete();
      unavailable({ unavailable: true, message });
      await vi.waitFor(() =>
        expect(
          server.requests.filter((x) => x.method === (completed ? 'turn/start' : 'turn/steer'))
        ).toHaveLength(completed ? 2 : 1)
      );
      const continuation = server.requests
        .filter((x) => x.method === (completed ? 'turn/start' : 'turn/steer'))
        .at(-1)!;
      const notice = JSON.parse(continuation.params.input[0].text);
      expect(notice).toMatchObject({ questionItemId: 'async-q', status: 'user_unavailable' });
      expect(notice).not.toHaveProperty('answers');
      expect(notice.instruction).toContain(message ?? 'unable to respond');
      expect(notice.instruction).toContain('explicit authorization');
      expect(server.requests.some((x) => x.method === 'turn/interrupt')).toBe(false);
      server.complete();
      expect((await result).result).toContain('hello');
    }
  );

  it.each([false, true])(
    'cancels an async question with providerCompleted=%s',
    async (completed) => {
      const r = runner();
      await r.warm();
      server.autoComplete = false;
      let answer!: (v: { cancelled: true }) => void;
      const result = r.runStream(
        'ask',
        {
          onUserInput: async () =>
            new Promise<{ cancelled: true }>((resolve) => {
              answer = resolve;
            }),
        },
        opts
      );
      const rejected = expect(result).rejects.toThrow('Request cancelled by user');
      await vi.waitFor(() => expect(server.turns).toBe(1));
      server.send(question());
      if (completed) server.complete();
      answer({ cancelled: true });
      await rejected;
      expect(server.turns).toBe(1);
    }
  );
});

describe('Codex wrapper timeout events', () => {
  it('forwards start, extend and clear once per turn for a reused app server', async () => {
    const r = new CodexRunner({ workdir: '/tmp', timeoutMs: 60000 });
    const started = vi.fn(),
      extended = vi.fn(),
      cleared = vi.fn();
    r.on('timeout-started', started);
    r.on('timeout-extended', extended);
    r.on('timeout-cleared', cleared);
    try {
      for (let i = 1; i <= 2; i++) {
        const result = r.runStream('hello', {}, { ...opts, codexLineTransport: 'app-server' });
        await result;
        expect(started).toHaveBeenCalledTimes(i);
        expect(cleared).toHaveBeenCalledTimes(i);
      }
      server.autoComplete = false;
      const result = r.runStream('wait', {}, { ...opts, codexLineTransport: 'app-server' });
      await vi.waitFor(() => expect(server.turns).toBe(3));
      r.extendTimeout(opts.channelId, 1000);
      expect(extended).toHaveBeenCalledTimes(1);
      expect(started.mock.calls[0][0].channelId).toBe(opts.channelId);
      server.complete();
      await result;
    } finally {
      r.shutdown();
    }
  });
});
