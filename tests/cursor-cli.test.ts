import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CursorRunner } from '../src/cursor-cli.js';

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

describe('CursorRunner', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CURSOR_FORCE;
    delete process.env.CURSOR_TRUST_WORKSPACE;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  async function getSpawnArgs(
    runner: CursorRunner,
    mode: 'run' | 'stream',
    options?: { sessionId?: string; skipPermissions?: boolean }
  ) {
    const { spawn, getMockProcess } = await import('child_process');
    const promise =
      mode === 'run'
        ? runner.run('hello', options)
        : runner.runStream('hello', {}, options);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const spawnMock = spawn as ReturnType<typeof vi.fn>;
    const callArgs = spawnMock.mock.calls[0];
    const command = callArgs[0] as string;
    const args = callArgs[1] as string[];

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

    return { command, args };
  }

  it('builds non-interactive JSON args with trust and force by default', async () => {
    const runner = new CursorRunner({ skipPermissions: true });
    const { command, args } = await getSpawnArgs(runner, 'run');

    expect(command).toBe('cursor-agent');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args).toContain('--force');
    expect(args).toContain('--trust');
    expect(args[args.indexOf('--model') + 1]).toBe('auto');
  });

  it('uses auto model by default to avoid Cursor CLI global model drift', async () => {
    const runner = new CursorRunner({});
    const { args } = await getSpawnArgs(runner, 'stream');

    expect(args[args.indexOf('--model') + 1]).toBe('auto');
  });

  it('omits force only when CURSOR_FORCE is disabled', async () => {
    process.env.CURSOR_FORCE = 'false';
    const runner = new CursorRunner({});
    const { args } = await getSpawnArgs(runner, 'run');

    expect(args).not.toContain('--force');
    expect(args).toContain('--trust');
  });

  it('omits trust only when CURSOR_TRUST_WORKSPACE is disabled', async () => {
    process.env.CURSOR_TRUST_WORKSPACE = 'false';
    const runner = new CursorRunner({});
    const { args } = await getSpawnArgs(runner, 'run');

    expect(args).toContain('--force');
    expect(args).not.toContain('--trust');
  });

  it('includes model, workspace, and resume args', async () => {
    const runner = new CursorRunner({ model: 'gpt-5.5', workdir: '/tmp/project' });
    const { args } = await getSpawnArgs(runner, 'run', { sessionId: 'chat-123' });

    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.5');
    expect(args[args.indexOf('--workspace') + 1]).toBe('/tmp/project');
    expect(args[args.indexOf('--resume') + 1]).toBe('chat-123');
  });

  it('builds stream-json args with partial output', async () => {
    const runner = new CursorRunner({});
    const { args } = await getSpawnArgs(runner, 'stream');

    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--stream-partial-output');
  });

  it('run parses result and session id', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new CursorRunner({});

    const promise = runner.run('hello');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    mockProcess.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ result: 'final answer', session_id: 'sess-abc' }))
    );
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: 'final answer',
      sessionId: 'sess-abc',
    });
  });

  it('runStream emits text and one tool event from started events', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new CursorRunner({});
    const texts: string[] = [];
    const tools: Array<{ name: string; input: Record<string, unknown> }> = [];

    const promise = runner.runStream('hello', {
      onText: (text) => texts.push(text),
      onToolUse: (name, input) => tools.push({ name, input }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    for (const event of [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reading' }] },
        session_id: 'sess-stream',
      },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool-1',
        tool_call: { readToolCall: { args: { path: 'README.md' } } },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tool-1',
        tool_call: { readToolCall: { args: { path: 'README.md' } } },
      },
      { type: 'result', result: 'reading', session_id: 'sess-stream', is_error: false },
    ]) {
      mockProcess.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    }
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'reading', sessionId: 'sess-stream' });
    expect(texts).toEqual(['reading']);
    expect(tools).toEqual([{ name: 'Read', input: { path: 'README.md' } }]);
  });

  it('runStream treats final assistant event as canonical text, not another delta', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new CursorRunner({});
    const fullTexts: string[] = [];

    const promise = runner.runStream('hello', {
      onText: (_text, fullText) => fullTexts.push(fullText),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    for (const event of [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'こ' }] },
        session_id: 'sess-stream',
        timestamp_ms: 1,
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ん' }] },
        session_id: 'sess-stream',
        timestamp_ms: 2,
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'こんにちは' }] },
        session_id: 'sess-stream',
      },
      { type: 'result', result: 'こんにちは', session_id: 'sess-stream', is_error: false },
    ]) {
      mockProcess.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    }
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: 'こんにちは',
      sessionId: 'sess-stream',
    });
    expect(fullTexts).toEqual(['こ', 'こん', 'こんにちは']);
  });
});
