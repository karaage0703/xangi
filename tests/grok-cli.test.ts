import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrokRunner } from '../src/grok-cli.js';

vi.mock('child_process', () => {
  const EventEmitter = require('events');

  class MockProcess extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed = false;

    kill() {
      this.killed = true;
      this.emit('close', 0);
    }
  }

  let mockProcess: MockProcess;

  return {
    spawn: vi.fn(() => {
      mockProcess = new MockProcess();
      return mockProcess;
    }),
    getMockProcess: () => mockProcess,
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

describe('GrokRunner', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.XAI_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  async function getSpawnArgs(runner: GrokRunner, mode: 'run' | 'stream') {
    const { spawn, getMockProcess } = await import('child_process');
    const promise = mode === 'run' ? runner.run('hello') : runner.runStream('hello', {});

    await new Promise((resolve) => setTimeout(resolve, 50));
    const spawnMock = spawn as ReturnType<typeof vi.fn>;
    const callArgs = spawnMock.mock.calls[0];
    const command = callArgs[0] as string;
    const args = callArgs[1] as string[];
    const spawnOptions = callArgs[2] as { env: NodeJS.ProcessEnv };

    const mockProcess = (getMockProcess as () => any)();
    mockProcess.stdout.emit(
      'data',
      Buffer.from(
        mode === 'run'
          ? JSON.stringify({ result: 'ok', session_id: 'sess-1' })
          : JSON.stringify({ type: 'result', result: 'ok', session_id: 'sess-1' }) + '\n'
      )
    );
    mockProcess.emit('close', 0);
    await promise;

    return { command, args, env: spawnOptions.env };
  }

  it('builds headless JSON args with no auto update and always approve by default', async () => {
    const runner = new GrokRunner({ skipPermissions: true });
    const { command, args } = await getSpawnArgs(runner, 'run');

    expect(command).toBe('grok');
    expect(args).toContain('--no-auto-update');
    expect(args).toContain('--always-approve');
    expect(args).toContain('-p');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('includes model, cwd, and resume args', async () => {
    const runner = new GrokRunner({ model: 'grok-build-0.1', workdir: '/tmp/project' });
    const { spawn, getMockProcess } = await import('child_process');

    const promise = runner.run('hello', { sessionId: 'sess-prev' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const mockProcess = (getMockProcess as () => any)();
    mockProcess.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
    mockProcess.emit('close', 0);
    await promise;

    expect(args[args.indexOf('--model') + 1]).toBe('grok-build-0.1');
    expect(args[args.indexOf('--cwd') + 1]).toBe('/tmp/project');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-prev');
  });

  it('passes XAI_API_KEY only to the Grok child process when set', async () => {
    process.env.XAI_API_KEY = 'xai-test-key';
    const runner = new GrokRunner({});
    const { env } = await getSpawnArgs(runner, 'run');

    expect(env.XAI_API_KEY).toBe('xai-test-key');
  });

  it('builds streaming-json args', async () => {
    const runner = new GrokRunner({});
    const { args } = await getSpawnArgs(runner, 'stream');

    expect(args[args.indexOf('--output-format') + 1]).toBe('streaming-json');
  });

  it('run parses result and session id', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new GrokRunner({});

    const promise = runner.run('hello');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    mockProcess.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ output_text: 'final answer', session_id: 'sess-abc' }))
    );
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: 'final answer',
      sessionId: 'sess-abc',
    });
  });

  it('runStream emits delta text and tool events', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new GrokRunner({});
    const texts: string[] = [];
    const tools: Array<{ name: string; input: Record<string, unknown> }> = [];

    const promise = runner.runStream('hello', {
      onText: (text) => texts.push(text),
      onToolUse: (name, input) => tools.push({ name, input }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    for (const event of [
      { type: 'assistant_delta', delta: { text: 'hel' }, session_id: 'sess-stream' },
      { type: 'assistant_delta', delta: { text: 'lo' }, session_id: 'sess-stream' },
      {
        type: 'tool_call',
        call_id: 'tool-1',
        name: 'Bash',
        arguments: { command: 'pwd' },
      },
      { type: 'result', result: 'hello', session_id: 'sess-stream' },
    ]) {
      mockProcess.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    }
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'hello', sessionId: 'sess-stream' });
    expect(texts).toEqual(['hel', 'lo']);
    expect(tools).toEqual([{ name: 'Bash', input: { command: 'pwd' } }]);
  });

  it('runStream ignores thought events from Grok 0.2 streaming-json', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new GrokRunner({});
    const texts: string[] = [];

    const promise = runner.runStream('hello', {
      onText: (text) => texts.push(text),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    for (const event of [
      { type: 'thought', data: 'The user wants a short answer.' },
      { type: 'text', data: 'ok' },
      {
        type: 'end',
        stopReason: 'EndTurn',
        sessionId: '019ed0df-a3fe-7a42-864d-4f0357cd7dcb',
      },
    ]) {
      mockProcess.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    }
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: 'ok',
      sessionId: '019ed0df-a3fe-7a42-864d-4f0357cd7dcb',
    });
    expect(texts).toEqual(['ok']);
  });

  it('runStream treats Grok 0.2 text events as deltas', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new GrokRunner({});
    const texts: string[] = [];

    const promise = runner.runStream('hello', {
      onText: (text) => texts.push(text),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    for (const event of [
      { type: 'text', data: 'こ' },
      { type: 'text', data: 'ん' },
      { type: 'text', data: 'に' },
      { type: 'text', data: 'ち' },
      { type: 'text', data: 'は' },
      { type: 'text', data: '。' },
      {
        type: 'end',
        stopReason: 'EndTurn',
        sessionId: '019ed28b-824c-73a0-b06e-69d8bc3635f7',
      },
    ]) {
      mockProcess.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    }
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: 'こんにちは。',
      sessionId: '019ed28b-824c-73a0-b06e-69d8bc3635f7',
    });
    expect(texts).toEqual(['こ', 'ん', 'に', 'ち', 'は', '。']);
  });
});
