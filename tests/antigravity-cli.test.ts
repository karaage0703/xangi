import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AntigravityRunner } from '../src/antigravity-cli.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('child_process', () => {
  const EventEmitter = require('events');
  const { PassThrough } = require('stream');

  class MockProcess extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
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

describe('AntigravityRunner', () => {
  const originalEnv = process.env;
  const tempHomes: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    for (const home of tempHomes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  async function getSpawnArgs(runner: AntigravityRunner, mode: 'run' | 'stream', options = {}) {
    const { spawn, getMockProcess } = await import('child_process');
    const promise =
      mode === 'run' ? runner.run('hello', options) : runner.runStream('hello', {}, options);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const spawnMock = spawn as ReturnType<typeof vi.fn>;
    const callArgs = spawnMock.mock.calls[0];
    const command = callArgs[0] as string;
    const args = callArgs[1] as string[];
    const spawnOptions = callArgs[2] as { cwd?: string; env: NodeJS.ProcessEnv };

    const mockProcess = (getMockProcess as () => any)();
    mockProcess.stdout.emit('data', Buffer.from('ok'));
    mockProcess.emit('close', 0);
    await promise;

    return { command, args, cwd: spawnOptions.cwd, env: spawnOptions.env };
  }

  it('builds headless args with permission skip by default', async () => {
    const runner = new AntigravityRunner({ skipPermissions: true });
    const { command, args } = await getSpawnArgs(runner, 'run');

    expect(command).toBe('agy');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('-p');
  });

  it('includes model, cwd, and conversation args', async () => {
    const runner = new AntigravityRunner({ model: 'gemini-3.5-pro', workdir: '/tmp/project' });
    const { args, cwd } = await getSpawnArgs(runner, 'run', { sessionId: 'sess-prev' });

    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.5-pro');
    expect(args[args.indexOf('--conversation') + 1]).toBe('sess-prev');
    expect(cwd).toBe('/tmp/project');
  });

  it('passes account hiding env by default', async () => {
    const runner = new AntigravityRunner({});
    const { env } = await getSpawnArgs(runner, 'run');

    expect(env.AGY_CLI_HIDE_ACCOUNT_INFO).toBe('true');
  });

  it('run parses plain text output', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new AntigravityRunner({});

    const promise = runner.run('hello');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    mockProcess.stdout.emit('data', Buffer.from('final answer\n'));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: 'final answer',
      sessionId: '',
    });
  });

  it('preserves UTF-8 characters split across stdout chunks', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    const output = '水を落として根張りを活性化するのがベストです\n';

    for (const byte of Buffer.from(output)) {
      mockProcess.stdout.write(Buffer.from([byte]));
    }
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: output.trim(),
      sessionId: '',
    });
  });

  it('treats empty output as an Antigravity CLI error', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new AntigravityRunner({});

    const promise = runner.run('hello');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    mockProcess.emit('close', 0);

    await expect(promise).rejects.toThrow('Antigravity CLI returned no output');
  });

  it('infers sessionId from a newly created Antigravity conversation database', async () => {
    const { getMockProcess } = await import('child_process');
    const home = mkdtempSync(join(tmpdir(), 'agy-home-'));
    tempHomes.push(home);
    process.env.HOME = home;
    const conversationsDir = join(home, '.gemini', 'antigravity-cli', 'conversations');
    const conversationId = '12345678-1234-1234-1234-123456789abc';

    const runner = new AntigravityRunner({});

    const promise = runner.run('hello');
    await new Promise((resolve) => setTimeout(resolve, 50));
    mkdirSync(conversationsDir, { recursive: true });
    writeFileSync(join(conversationsDir, `${conversationId}.db`), '');

    const mockProcess = (getMockProcess as () => any)();
    mockProcess.stdout.emit('data', Buffer.from('final answer\n'));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: 'final answer',
      sessionId: conversationId,
    });
  });

  it('run parses JSON output if the CLI gains machine-readable output', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new AntigravityRunner({});

    const promise = runner.run('hello');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    mockProcess.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ result: 'json answer', conversation_id: 'conv-1' }))
    );
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: 'json answer',
      sessionId: 'conv-1',
    });
  });

  it('runStream emits the final text once', async () => {
    const { getMockProcess } = await import('child_process');
    const runner = new AntigravityRunner({});
    const texts: string[] = [];

    const promise = runner.runStream('hello', {
      onText: (text) => texts.push(text),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    mockProcess.stdout.emit('data', Buffer.from('stream final'));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'stream final', sessionId: '' });
    expect(texts).toEqual(['stream final']);
  });
});
