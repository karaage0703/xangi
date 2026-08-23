import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeRunner } from '../src/opencode-cli.js';

vi.mock('child_process', () => {
  const EventEmitter = require('events');

  class MockProcess extends EventEmitter {
    stdin = { write: vi.fn(), end: vi.fn() };
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

describe('OpenCodeRunner', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  async function start(
    runner: OpenCodeRunner,
    options?: {
      sessionId?: string;
      skipPermissions?: boolean;
      effort?: 'low' | 'medium' | 'high' | 'max';
    }
  ) {
    const { spawn, getMockProcess } = await import('child_process');
    const promise = runner.runStream('hello', {}, options);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    return { args, promise, process: (getMockProcess as () => any)() };
  }

  it('builds a non-interactive JSON run with model, workspace, variant, and session', async () => {
    const runner = new OpenCodeRunner({
      model: 'dspark/qwen3.8-27b',
      workdir: '/workspace/project',
      skipPermissions: true,
    });
    const { args, promise, process } = await start(runner, {
      sessionId: 'ses_123',
      effort: 'high',
    });

    expect(args.slice(0, 5)).toEqual(['run', '--format', 'json', '--agent', 'build']);
    expect(args).toContain('--auto');
    expect(args).toContain('--dir');
    expect(args[args.indexOf('--dir') + 1]).toBe('/workspace/project');
    expect(args[args.indexOf('--model') + 1]).toBe('dspark/qwen3.8-27b');
    expect(args[args.indexOf('--variant') + 1]).toBe('high');
    expect(args[args.indexOf('--session') + 1]).toBe('ses_123');
    expect(args.at(-1)).toContain('<system-context>');
    expect(args.at(-1)).toContain('hello');

    process.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'step_start',
          sessionID: 'ses_123',
          part: { sessionID: 'ses_123' },
        }) + '\n'
      )
    );
    process.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ sessionId: 'ses_123' });
  });

  it('does not auto-approve permissions when skipPermissions is false', async () => {
    const runner = new OpenCodeRunner({ skipPermissions: false });
    const { args, promise, process } = await start(runner);
    expect(args).not.toContain('--auto');
    process.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'step_start', sessionID: 'ses_new' }) + '\n')
    );
    process.emit('close', 0);
    await promise;
  });

  it('streams text, tools, session ID, and aggregated usage', async () => {
    const runner = new OpenCodeRunner({ skipPermissions: true });
    const texts: Array<[string, string]> = [];
    const tools: Array<[string, Record<string, unknown>]> = [];
    const traces: unknown[] = [];
    const promise = runner.runStream('work', {
      onText: (text, full) => texts.push([text, full]),
      onToolUse: (name, input) => tools.push([name, input]),
      onTraceEvent: (event) => traces.push(event),
    });
    const { getMockProcess } = await import('child_process');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const process = (getMockProcess as () => any)();
    const events = [
      { type: 'step_start', sessionID: 'ses_stream', part: { sessionID: 'ses_stream' } },
      {
        type: 'text',
        sessionID: 'ses_stream',
        part: { text: '調査します。', sessionID: 'ses_stream' },
      },
      {
        type: 'tool_use',
        sessionID: 'ses_stream',
        part: {
          tool: 'read',
          callID: 'call_1',
          state: {
            status: 'completed',
            input: { filePath: 'README.md' },
            output: 'contents',
          },
        },
      },
      {
        type: 'step_finish',
        sessionID: 'ses_stream',
        part: { tokens: { input: 10, output: 3, cache: { read: 4 } } },
      },
      {
        type: 'text',
        sessionID: 'ses_stream',
        part: { text: '完了しました。', sessionID: 'ses_stream' },
      },
    ];
    process.stdout.emit(
      'data',
      Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    );
    process.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: '調査します。完了しました。',
      sessionId: 'ses_stream',
    });
    expect(texts).toEqual([
      ['調査します。', '調査します。'],
      ['完了しました。', '調査します。完了しました。'],
    ]);
    expect(tools).toEqual([['read', { filePath: 'README.md' }]]);
    expect(traces).toContainEqual({
      type: 'turn_completed',
      usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 },
    });
  });

  it('rejects an OpenCode error event even when the CLI exits zero', async () => {
    const runner = new OpenCodeRunner({});
    let reported: Error | undefined;
    const promise = runner.runStream('work', { onError: (error) => (reported = error) });
    const { getMockProcess } = await import('child_process');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const process = (getMockProcess as () => any)();
    process.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'error',
          sessionID: 'ses_error',
          error: { name: 'APIError', data: { message: 'Cannot connect to API' } },
        }) + '\n'
      )
    );
    process.emit('close', 0);

    await expect(promise).rejects.toThrow('Cannot connect to API');
    expect(reported?.message).toBe('Cannot connect to API');
  });
});
