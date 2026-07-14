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

  const mockProcesses: MockProcess[] = [];

  return {
    spawn: vi.fn(() => {
      const process = new MockProcess();
      mockProcesses.push(process);
      return process;
    }),
    getMockProcess: () => mockProcesses.at(-1),
    getMockProcesses: () => mockProcesses,
    resetMockProcesses: () => mockProcesses.splice(0),
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('AntigravityRunner', () => {
  const originalEnv = process.env;
  const tempHomes: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ANTIGRAVITY_PRINT_TIMEOUT;
    const { resetMockProcesses } = await import('child_process');
    (resetMockProcesses as () => void)();
  });

  afterEach(() => {
    process.env = originalEnv;
    for (const home of tempHomes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  async function getProcesses(): Promise<any[]> {
    const { getMockProcesses } = await import('child_process');
    return (getMockProcesses as () => any[])();
  }

  async function waitForProcess(count = 1): Promise<any> {
    for (let i = 0; i < 25; i += 1) {
      const processes = await getProcesses();
      if (processes.length >= count) return processes[count - 1];
      await tick();
    }
    throw new Error(`Expected ${count} agy process(es) to be spawned`);
  }

  async function getSpawnArgs(runner: AntigravityRunner, mode: 'run' | 'stream', options = {}) {
    const { spawn } = await import('child_process');
    const promise =
      mode === 'run' ? runner.run('hello', options) : runner.runStream('hello', {}, options);
    const mockProcess = await waitForProcess();
    const spawnMock = spawn as ReturnType<typeof vi.fn>;
    const callArgs = spawnMock.mock.calls[0];
    const command = callArgs[0] as string;
    const args = callArgs[1] as string[];
    const spawnOptions = callArgs[2] as { cwd?: string; env: NodeJS.ProcessEnv };

    mockProcess.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ status: 'SUCCESS', response: 'ok', conversation_id: 'conv-1' }))
    );
    mockProcess.emit('close', 0);
    await promise;

    return { command, args, cwd: spawnOptions.cwd, env: spawnOptions.env };
  }

  function success(response: string, conversationId?: string) {
    return JSON.stringify({
      status: 'SUCCESS',
      response,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      duration_seconds: 1.2,
      num_turns: 2,
      usage: { input_tokens: 3, output_tokens: 4 },
    });
  }

  it('builds headless JSON args with permission skip by default', async () => {
    const runner = new AntigravityRunner({ skipPermissions: true });
    const { command, args } = await getSpawnArgs(runner, 'run');

    expect(command).toBe('agy');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('5m');
    expect(args).toContain('-p');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('allows overriding the Antigravity print timeout', async () => {
    process.env.ANTIGRAVITY_PRINT_TIMEOUT = '30s';
    const runner = new AntigravityRunner({});
    const { args } = await getSpawnArgs(runner, 'run');

    expect(args[args.indexOf('--print-timeout') + 1]).toBe('30s');
  });

  it('includes model, cwd, add-dir, and conversation args', async () => {
    const runner = new AntigravityRunner({ model: 'gemini-3.5-pro', workdir: '/tmp/project' });
    const { args, cwd } = await getSpawnArgs(runner, 'run', { sessionId: 'sess-prev' });

    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.5-pro');
    expect(args[args.indexOf('--conversation') + 1]).toBe('sess-prev');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('.');
    expect(cwd).toBe('/tmp/project');
  });

  it('passes account hiding env by default', async () => {
    const runner = new AntigravityRunner({});
    const { env } = await getSpawnArgs(runner, 'run');

    expect(env.AGY_CLI_HIDE_ACCOUNT_INFO).toBe('true');
  });

  it('uses the Agy 1.1.2 SUCCESS response and conversation id', async () => {
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();

    mockProcess.stdout.emit('data', Buffer.from(success('json answer', 'conv-1')));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'json answer', sessionId: 'conv-1' });
  });

  it('replaces a supplied session id with the JSON conversation id', async () => {
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello', { sessionId: 'conv-old' });
    const mockProcess = await waitForProcess();

    mockProcess.stdout.emit('data', Buffer.from(success('updated', 'conv-new')));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'updated', sessionId: 'conv-new' });
  });

  it('keeps a supplied session id when SUCCESS JSON has no conversation id', async () => {
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello', { sessionId: 'conv-existing' });
    const mockProcess = await waitForProcess();

    mockProcess.stdout.emit('data', Buffer.from(success('continued')));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'continued', sessionId: 'conv-existing' });
  });

  it('run parses plain text output without a second execution', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();

    mockProcess.stdout.emit('data', Buffer.from('final answer\n'));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'final answer', sessionId: '' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('treats an ordinary JSON answer without Agy status as legacy output', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const promise = runner.run('return JSON');
    const mockProcess = await waitForProcess();
    const answer = '{\"weather\":\"sunny\",\"error\":\"none\"}';

    mockProcess.stdout.emit('data', Buffer.from(answer));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: answer, sessionId: '' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('preserves UTF-8 characters split across stdout chunks', async () => {
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();
    const output = '水を落として根張りを活性化するのがベストです\n';

    for (const byte of Buffer.from(output)) {
      mockProcess.stdout.write(Buffer.from([byte]));
    }
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: output.trim(), sessionId: '' });
  });

  it('treats empty output as an Antigravity CLI error', async () => {
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();
    mockProcess.emit('close', 0);

    await expect(promise).rejects.toThrow('Antigravity CLI returned no output');
  });

  it('includes stderr details when Antigravity exits successfully without output', async () => {
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();
    mockProcess.stderr.emit('data', Buffer.from('print mode timed out after 30s\n'));
    mockProcess.emit('close', 0);

    await expect(promise).rejects.toThrow(
      'Antigravity CLI returned no output: print mode timed out after 30s'
    );
  });

  it('infers sessionId from a newly created Antigravity conversation database in legacy mode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-home-'));
    tempHomes.push(home);
    process.env.HOME = home;
    const conversationsDir = join(home, '.gemini', 'antigravity-cli', 'conversations');
    const conversationId = '12345678-1234-1234-1234-123456789abc';
    const runner = new AntigravityRunner({});

    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();
    mkdirSync(conversationsDir, { recursive: true });
    writeFileSync(join(conversationsDir, `${conversationId}.db`), '');
    mockProcess.stdout.emit('data', Buffer.from('final answer\n'));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'final answer', sessionId: conversationId });
  });

  it('parses ERROR JSON from stdout on a non-zero exit without retrying', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();

    mockProcess.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ status: 'ERROR', error: { message: 'quota exceeded' } }))
    );
    mockProcess.stderr.emit('data', Buffer.from('less useful stderr'));
    mockProcess.emit('close', 1);

    await expect(promise).rejects.toThrow('Antigravity CLI exited with code 1: quota exceeded');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('treats exit 0 ERROR JSON as a failure', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();

    mockProcess.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ status: 'ERROR', error: 'auth failed' }))
    );
    mockProcess.emit('close', 0);

    await expect(promise).rejects.toThrow('auth failed');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('fails safely for an unknown JSON status', async () => {
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();

    mockProcess.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ status: 'PENDING', response: 'ignore me' }))
    );
    mockProcess.emit('close', 0);

    await expect(promise).rejects.toThrow('unknown JSON status: PENDING');
  });

  it.each([
    ['timeout', 'print mode timed out after 30s'],
    ['invalid model', 'invalid model: does-not-exist'],
  ])('does not retry a %s error', async (_name, stderr) => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();

    mockProcess.stderr.emit('data', Buffer.from(stderr));
    mockProcess.emit('close', 1);

    await expect(promise).rejects.toThrow('Antigravity CLI exited with code 1');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('falls back exactly once when an old agy rejects --output-format', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const jsonProcess = await waitForProcess();

    jsonProcess.stderr.emit('data', Buffer.from('flags provided but not defined: -output-format'));
    jsonProcess.emit('close', 2);

    const legacyProcess = await waitForProcess(2);
    legacyProcess.stdout.emit('data', Buffer.from('legacy answer'));
    legacyProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'legacy answer', sessionId: '' });
    expect(spawn).toHaveBeenCalledTimes(2);
    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toContain('--output-format');
    expect(calls[1][1]).not.toContain('--output-format');
  });

  it('caches legacy capability after an unsupported output-format error', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    let promise = runner.run('first');
    let mockProcess = await waitForProcess();
    mockProcess.stderr.emit('data', Buffer.from("unrecognized flag '--output-format'"));
    mockProcess.emit('close', 1);
    mockProcess = await waitForProcess(2);
    mockProcess.stdout.emit('data', Buffer.from('first legacy answer'));
    mockProcess.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ result: 'first legacy answer' });

    promise = runner.run('second');
    mockProcess = await waitForProcess(3);
    mockProcess.stdout.emit('data', Buffer.from('second legacy answer'));
    mockProcess.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ result: 'second legacy answer' });

    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[2][1]).not.toContain('--output-format');
  });

  it('does not fall back for ordinary non-zero errors', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();
    mockProcess.stderr.emit('data', Buffer.from('authentication denied'));
    mockProcess.emit('close', 1);

    await expect(promise).rejects.toThrow(
      'Antigravity CLI exited with code 1: authentication denied'
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not expose malformed JSON-like output as an answer', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello');
    const mockProcess = await waitForProcess();
    mockProcess.stdout.emit('data', Buffer.from('{"status":"SUCCESS"'));
    mockProcess.emit('close', 0);

    await expect(promise).rejects.toThrow('Antigravity CLI returned malformed JSON output');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('runStream emits the final result once without stream-json', async () => {
    const runner = new AntigravityRunner({});
    const onText = vi.fn();
    const onComplete = vi.fn();
    const promise = runner.runStream('hello', { onText, onComplete });
    const mockProcess = await waitForProcess();
    mockProcess.stdout.emit('data', Buffer.from(success('stream final', 'conv-stream')));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'stream final', sessionId: 'conv-stream' });
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('stream final', 'stream final');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
