import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AntigravityRunner } from '../src/antigravity-cli.js';
import { processManager } from '../src/process-manager.js';
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

vi.mock('../src/transcript-logger.js', () => ({
  logPrompt: vi.fn(),
  logResponse: vi.fn(),
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('AntigravityRunner', () => {
  const originalEnv = process.env;
  const tempHomes: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ANTIGRAVITY_PRINT_TIMEOUT;
    process.env.ANTIGRAVITY_DISABLE_SLASH_COMMANDS = 'false';
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
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        thinking_tokens: 2,
        cache_read_tokens: 1,
        total_tokens: 9,
      },
    });
  }

  it('probes Agy 1.1.9 once and disables slash expansion for run and stream', async () => {
    const { spawn } = await import('child_process');
    delete process.env.ANTIGRAVITY_DISABLE_SLASH_COMMANDS;
    const runner = new AntigravityRunner({});

    let promise: Promise<unknown> = runner.run('first');
    let mockProcess = await waitForProcess();
    mockProcess.stdout.emit(
      'data',
      Buffer.from('  --disable-slash-commands  Disable slash command expansion\n')
    );
    mockProcess.emit('close', 0);

    mockProcess = await waitForProcess(2);
    mockProcess.stdout.emit('data', Buffer.from(success('first answer', 'conv-1')));
    mockProcess.emit('close', 0);
    await promise;

    promise = runner.runStream('second', {});
    mockProcess = await waitForProcess(3);
    mockProcess.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          event: 'result',
          result: { conversation_id: 'conv-2', status: 'SUCCESS', response: 'second answer' },
        })}\n`
      )
    );
    mockProcess.emit('close', 0);
    await promise;

    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][1]).toEqual(['--help']);
    expect(calls[1][1]).toContain('--disable-slash-commands');
    expect(calls[2][1]).toContain('--disable-slash-commands');
  });

  it('omits the slash opt-out flag when an older Agy help does not advertise it', async () => {
    const { spawn } = await import('child_process');
    delete process.env.ANTIGRAVITY_DISABLE_SLASH_COMMANDS;
    const runner = new AntigravityRunner({});
    let promise = runner.run('hello');

    let mockProcess = await waitForProcess();
    mockProcess.stdout.emit('data', Buffer.from('Usage of agy:\n  --print  Print a response\n'));
    mockProcess.emit('close', 0);

    mockProcess = await waitForProcess(2);
    mockProcess.stdout.emit('data', Buffer.from(success('old answer', 'conv-old')));
    mockProcess.emit('close', 0);
    await promise;

    promise = runner.run('again');
    mockProcess = await waitForProcess(3);
    mockProcess.stdout.emit('data', Buffer.from(success('cached old answer', 'conv-old-2')));
    mockProcess.emit('close', 0);
    await promise;

    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1][1]).not.toContain('--disable-slash-commands');
    expect(calls[2][1]).not.toContain('--disable-slash-commands');
  });

  it('retries the slash capability probe on the next request after a transient failure', async () => {
    const { spawn } = await import('child_process');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    delete process.env.ANTIGRAVITY_DISABLE_SLASH_COMMANDS;
    const runner = new AntigravityRunner({});
    let promise = runner.run('hello');

    let mockProcess = await waitForProcess();
    mockProcess.emit('error', new Error('help unavailable'));

    mockProcess = await waitForProcess(2);
    mockProcess.stdout.emit('data', Buffer.from(success('fallback answer', 'conv-fallback')));
    mockProcess.emit('close', 0);
    await promise;

    promise = runner.run('again');
    mockProcess = await waitForProcess(3);
    mockProcess.stdout.emit(
      'data',
      Buffer.from('  --disable-slash-commands  Disable slash command expansion\n')
    );
    mockProcess.emit('close', 0);

    mockProcess = await waitForProcess(4);
    mockProcess.stdout.emit('data', Buffer.from(success('recovered answer', 'conv-recovered')));
    mockProcess.emit('close', 0);
    await promise;

    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[1][1]).not.toContain('--disable-slash-commands');
    expect(calls[2][1]).toEqual(['--help']);
    expect(calls[3][1]).toContain('--disable-slash-commands');
  });

  it('shares a managed in-flight capability probe within the same channel', async () => {
    const { spawn } = await import('child_process');
    delete process.env.ANTIGRAVITY_DISABLE_SLASH_COMMANDS;
    const runner = new AntigravityRunner({});
    const timeoutStarted = vi.fn();
    const timeoutCleared = vi.fn();
    runner.on('timeout-started', timeoutStarted);
    runner.on('timeout-cleared', timeoutCleared);

    const probeRunner = runner as unknown as {
      supportsDisableSlashCommands(channelId?: string): Promise<boolean>;
    };
    const first = probeRunner.supportsDisableSlashCommands('channel-shared');
    const second = probeRunner.supportsDisableSlashCommands('channel-shared');
    const mockProcess = await waitForProcess();

    await tick();
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(runner.hasRunner('channel-shared')).toBe(true);
    expect(runner.getTimeoutState('channel-shared').active).toBe(true);
    expect(timeoutStarted).toHaveBeenCalledOnce();

    mockProcess.stdout.emit(
      'data',
      Buffer.from('  --disable-slash-commands  Disable slash command expansion\n')
    );
    mockProcess.emit('close', 0);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(runner.hasRunner('channel-shared')).toBe(false);
    expect(runner.getTimeoutState('channel-shared').active).toBe(false);
    expect(timeoutCleared).toHaveBeenCalledWith({
      channelId: 'channel-shared',
      reason: 'completed',
    });
  });

  it('does not start a prompt when the slash capability probe is cancelled', async () => {
    const { spawn } = await import('child_process');
    delete process.env.ANTIGRAVITY_DISABLE_SLASH_COMMANDS;
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello', { channelId: 'channel-1' });

    await waitForProcess();
    expect(runner.cancel('channel-1')).toBe(true);

    await expect(promise).rejects.toThrow('capability probe was cancelled');
    await tick();
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('does not start a prompt when the managed capability probe is stopped', async () => {
    const { spawn } = await import('child_process');
    delete process.env.ANTIGRAVITY_DISABLE_SLASH_COMMANDS;
    const runner = new AntigravityRunner({});
    const promise = runner.run('hello', { channelId: 'channel-managed-stop' });

    await waitForProcess();
    expect(processManager.stop('channel-managed-stop')).toBe(true);

    await expect(promise).rejects.toThrow('capability probe was cancelled');
    await tick();
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('does not start a prompt after the managed capability probe times out', async () => {
    const { spawn } = await import('child_process');
    delete process.env.ANTIGRAVITY_DISABLE_SLASH_COMMANDS;
    const runner = new AntigravityRunner({ timeoutMs: 5 });
    const promise = runner.run('hello', { channelId: 'channel-probe-timeout' });

    await waitForProcess();
    await expect(promise).rejects.toThrow('capability probe was cancelled');
    await tick();
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('builds headless JSON args with permission skip by default', async () => {
    const runner = new AntigravityRunner({ skipPermissions: true });
    const { command, args } = await getSpawnArgs(runner, 'run');

    expect(command).toBe('agy');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('1800s');
    expect(args).toContain('-p');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('instructs Agy to omit ArtifactMetadata for ordinary workspace writes', async () => {
    const runner = new AntigravityRunner({});
    const { args } = await getSpawnArgs(runner, 'run');
    const prompt = args[args.indexOf('-p') + 1];

    expect(prompt).toContain('omit ArtifactMetadata entirely');
    expect(prompt).toContain('not workspace files');
  });

  it('allows overriding the Antigravity print timeout', async () => {
    process.env.ANTIGRAVITY_PRINT_TIMEOUT = '30s';
    const runner = new AntigravityRunner({});
    const { args } = await getSpawnArgs(runner, 'run');

    expect(args[args.indexOf('--print-timeout') + 1]).toBe('30s');
  });

  it('matches the Agy print timeout to the runner timeout by default', async () => {
    const runner = new AntigravityRunner({ timeoutMs: 90_000 });
    const { args } = await getSpawnArgs(runner, 'run');

    expect(args[args.indexOf('--print-timeout') + 1]).toBe('90s');
  });

  it('includes model, cwd, add-dir, and conversation args', async () => {
    const runner = new AntigravityRunner({ model: 'gemini-3.5-pro', workdir: '/tmp/project' });
    const { args, cwd } = await getSpawnArgs(runner, 'run', { sessionId: 'sess-prev' });

    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.5-pro');
    expect(args[args.indexOf('--conversation') + 1]).toBe('sess-prev');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('.');
    expect(cwd).toBe('/tmp/project');
  });

  it('passes supported effort to Antigravity CLI', async () => {
    const runner = new AntigravityRunner({});
    const { args } = await getSpawnArgs(runner, 'run', { effort: 'high' });

    expect(args[args.indexOf('--effort') + 1]).toBe('high');
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

  it('continues a failed workspace write once in the same JSON conversation', async () => {
    const { spawn } = await import('child_process');
    const { logPrompt, logResponse } = await import('../src/transcript-logger.js');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runner = new AntigravityRunner({ workdir: '/tmp/project' });
    const promise = runner.run('write the daily memory', { appSessionId: 'app-session' });
    let mockProcess = await waitForProcess();
    const artifactError =
      'declaring permissions: cortex tool write_to_file: /workspace/memory.md is not a valid artifact path; artifacts must be in /home/user/.gemini/antigravity-cli/brain/conv-write/';

    mockProcess.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          status: 'ERROR',
          conversation_id: 'conv-write',
          error: artifactError,
        })
      )
    );
    mockProcess.emit('close', 0);

    mockProcess = await waitForProcess(2);
    const recoveryArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[1][1] as string[];
    expect(recoveryArgs[recoveryArgs.indexOf('--conversation') + 1]).toBe('conv-write');
    const recoveryPrompt = recoveryArgs[recoveryArgs.indexOf('-p') + 1];
    expect(recoveryPrompt).toContain('Retry that write without the ArtifactMetadata field');
    expect(recoveryPrompt).not.toContain('write the daily memory');

    mockProcess.stdout.emit('data', Buffer.from(success('memory written', 'conv-write')));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'memory written', sessionId: 'conv-write' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(logPrompt).toHaveBeenCalledTimes(1);
    expect(logPrompt).toHaveBeenCalledWith(
      '/tmp/project',
      'app-session',
      expect.stringContaining('write the daily memory')
    );
    expect(logResponse).toHaveBeenCalledOnce();
  });

  it('continues artifact-path ERROR JSON after a non-zero process exit', async () => {
    const { spawn } = await import('child_process');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runner = new AntigravityRunner({});
    const promise = runner.run('write the daily memory');
    const artifactError =
      'write_to_file: /workspace/memory.md is not a valid artifact path; artifacts must be in /brain/conv-write/';

    let mockProcess = await waitForProcess();
    mockProcess.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          status: 'ERROR',
          conversation_id: 'conv-write',
          error: artifactError,
        })
      )
    );
    mockProcess.emit('close', 1);

    mockProcess = await waitForProcess(2);
    const recoveryArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[1][1] as string[];
    expect(recoveryArgs[recoveryArgs.indexOf('--conversation') + 1]).toBe('conv-write');
    mockProcess.stdout.emit('data', Buffer.from(success('memory written', 'conv-write')));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'memory written', sessionId: 'conv-write' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('does not repeat workspace write recovery after the continuation fails', async () => {
    const { spawn } = await import('child_process');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runner = new AntigravityRunner({});
    const promise = runner.run('write the daily memory');
    const artifactError =
      'write_to_file: /workspace/memory.md is not a valid artifact path; artifacts must be in /brain/conv-write/';

    let mockProcess = await waitForProcess();
    mockProcess.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          status: 'ERROR',
          conversation_id: 'conv-write',
          error: artifactError,
        })
      )
    );
    mockProcess.emit('close', 0);

    mockProcess = await waitForProcess(2);
    mockProcess.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          status: 'ERROR',
          conversation_id: 'conv-write',
          error: artifactError,
        })
      )
    );
    mockProcess.emit('close', 0);

    await expect(promise).rejects.toThrow('is not a valid artifact path');
    expect(spawn).toHaveBeenCalledTimes(2);
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

  it('streams Agy 1.1.10 text deltas, tool starts, and the root conversation id', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const onText = vi.fn();
    const onToolUse = vi.fn();
    const onBackendReady = vi.fn();
    const onComplete = vi.fn();
    const promise = runner.runStream('hello', {
      onText,
      onToolUse,
      onBackendReady,
      onComplete,
    });
    const mockProcess = await waitForProcess();

    const events = [
      {
        event: 'init',
        conversation_id: 'conv-stream',
        init: { cwd: '/tmp/project', tools: ['list_dir'], permission_mode: 'request-review' },
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-stream',
          step_index: 3,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'list_dir',
          tool_info: { name: 'list_dir', parameters: { DirectoryPath: '.' } },
        },
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-stream',
          step_index: 3,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'list_dir',
          tool_info: { name: 'list_dir', parameters: { DirectoryPath: '.' }, output: 'files' },
        },
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-stream',
          step_index: 4,
          state: 'ACTIVE',
          step_type: 'subagent',
          subagent_info: {
            conversation_id: 'conv-child',
            log_uri: 'file:///tmp/conv-child.log',
          },
        },
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-stream',
          step_index: 5,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: '水田',
        },
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-stream',
          step_index: 5,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'チェック\n',
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            thinking_tokens: 2,
            cache_read_tokens: 3,
            total_tokens: 16,
          },
        },
      },
      {
        event: 'result',
        result: {
          conversation_id: 'conv-stream',
          status: 'SUCCESS',
          response: '水田チェック\n',
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            thinking_tokens: 2,
            cache_read_tokens: 3,
            total_tokens: 16,
          },
        },
      },
    ];
    mockProcess.stdout.emit(
      'data',
      Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
    );
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: '水田チェック\n', sessionId: 'conv-stream' });
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('stream-json');
    expect(onBackendReady).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledWith('list_dir', { DirectoryPath: '.' });
    expect(onText.mock.calls).toEqual([
      ['水田', '水田'],
      ['チェック\n', '水田チェック\n'],
    ]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps a tool error non-fatal when Agy later returns an answer', async () => {
    const runner = new AntigravityRunner({});
    const promise = runner.runStream('hello', {});
    const mockProcess = await waitForProcess();
    const events = [
      { event: 'init', conversation_id: 'conv-tool', init: {} },
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-tool',
          step_index: 2,
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { error: { type: 'TOOL_ERROR', message: 'permission denied' } },
        },
      },
      {
        event: 'result',
        result: { conversation_id: 'conv-tool', status: 'SUCCESS', response: 'recovered' },
      },
    ];
    mockProcess.stdout.emit(
      'data',
      Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
    );
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'recovered', sessionId: 'conv-tool' });
  });

  it('uses the tool error when SUCCESS has no response', async () => {
    const runner = new AntigravityRunner({});
    const onError = vi.fn();
    const promise = runner.runStream('hello', { onError });
    const mockProcess = await waitForProcess();
    mockProcess.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          event: 'step_update',
          step_update: {
            conversation_id: 'conv-tool',
            step_index: 2,
            state: 'ERROR',
            step_type: 'tool',
            tool_name: 'run_command',
            tool_info: { error: { message: 'permission denied' } },
          },
        })}\n${JSON.stringify({
          event: 'result',
          result: { conversation_id: 'conv-tool', status: 'SUCCESS', response: '' },
        })}\n`
      )
    );
    mockProcess.emit('close', 0);

    await expect(promise).rejects.toThrow('permission denied');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports a structured Agy 1.1.3 stream error once', async () => {
    const runner = new AntigravityRunner({});
    const onError = vi.fn();
    const promise = runner.runStream('hello', { onError });
    const mockProcess = await waitForProcess();
    mockProcess.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          event: 'result',
          result: {
            conversation_id: '',
            status: 'ERROR',
            response: '',
            error: 'invalid model',
          },
        })}\n`
      )
    );
    mockProcess.emit('close', 1);

    await expect(promise).rejects.toThrow('invalid model');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('continues a failed streamed workspace write in the same conversation', async () => {
    const { spawn } = await import('child_process');
    const { logPrompt, logResponse } = await import('../src/transcript-logger.js');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runner = new AntigravityRunner({ workdir: '/tmp/project' });
    const onBackendReady = vi.fn();
    const onText = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    const promise = runner.runStream(
      'write the daily memory',
      {
        onBackendReady,
        onText,
        onComplete,
        onError,
      },
      { appSessionId: 'app-session' }
    );
    const artifactError =
      'declaring permissions: cortex tool write_to_file: /workspace/memory.md is not a valid artifact path; artifacts must be in /brain/conv-stream-write/';

    let mockProcess = await waitForProcess();
    mockProcess.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          event: 'init',
          conversation_id: 'conv-stream-write',
          init: {},
        })}\n${JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'conv-stream-write',
            status: 'ERROR',
            response: '',
            error: artifactError,
          },
        })}\n`
      )
    );
    mockProcess.emit('close', 0);

    mockProcess = await waitForProcess(2);
    const recoveryArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[1][1] as string[];
    expect(recoveryArgs[recoveryArgs.indexOf('--conversation') + 1]).toBe('conv-stream-write');
    mockProcess.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          event: 'init',
          conversation_id: 'conv-stream-write',
          init: {},
        })}\n${JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'conv-stream-write',
            status: 'SUCCESS',
            response: 'memory written',
          },
        })}\n`
      )
    );
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({
      result: 'memory written',
      sessionId: 'conv-stream-write',
    });
    expect(onBackendReady).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('memory written', 'memory written');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(logPrompt).toHaveBeenCalledTimes(1);
    expect(logPrompt).toHaveBeenCalledWith(
      '/tmp/project',
      'app-session',
      expect.stringContaining('write the daily memory')
    );
    expect(logResponse).toHaveBeenCalledOnce();
  });

  it('recovers a new sessionId from Agy 1.1.2 plain output without re-running', async () => {
    const { spawn } = await import('child_process');
    const home = mkdtempSync(join(tmpdir(), 'agy-home-'));
    tempHomes.push(home);
    process.env.HOME = home;
    const conversationsDir = join(home, '.gemini', 'antigravity-cli', 'conversations');
    const conversationId = '12345678-1234-1234-1234-123456789abc';
    const runner = new AntigravityRunner({});
    const onText = vi.fn();
    const onComplete = vi.fn();
    const promise = runner.runStream('hello', { onText, onComplete });
    const mockProcess = await waitForProcess();
    mkdirSync(conversationsDir, { recursive: true });
    writeFileSync(join(conversationsDir, `${conversationId}.db`), '');
    mockProcess.stdout.emit('data', Buffer.from('legacy line 1\n\nlegacy line 2\n'));
    mockProcess.emit('close', 0);

    const expected = {
      result: 'legacy line 1\n\nlegacy line 2',
      sessionId: conversationId,
    };
    await expect(promise).resolves.toEqual(expected);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(expected);
    expect(onText).toHaveBeenCalledWith(
      'legacy line 1\n\nlegacy line 2',
      'legacy line 1\n\nlegacy line 2'
    );
  });

  it('preserves a resumed sessionId for Agy 1.1.2 plain output without re-running', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const onComplete = vi.fn();
    const promise = runner.runStream('hello again', { onComplete }, { sessionId: 'conv-existing' });
    const mockProcess = await waitForProcess();
    mockProcess.stdout.emit('data', Buffer.from('continued answer\n'));
    mockProcess.emit('close', 0);

    const expected = { result: 'continued answer', sessionId: 'conv-existing' };
    await expect(promise).resolves.toEqual(expected);
    expect(onComplete).toHaveBeenCalledWith(expected);
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(args[args.indexOf('--conversation') + 1]).toBe('conv-existing');
  });

  it('preserves an ordinary JSON answer returned as Agy 1.1.2 plain output', async () => {
    const runner = new AntigravityRunner({});
    const answer = '{"weather":"sunny","temperature":24}';
    const promise = runner.runStream('return JSON', {});
    const mockProcess = await waitForProcess();
    mockProcess.stdout.emit('data', Buffer.from(`${answer}\n`));
    mockProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: answer, sessionId: '' });
  });

  it('caches plain stream capability and uses final JSON on the next stream call', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});

    let promise = runner.runStream('first', {});
    let mockProcess = await waitForProcess();
    mockProcess.stdout.emit('data', Buffer.from('first legacy answer'));
    mockProcess.emit('close', 0);
    await promise;

    promise = runner.runStream('second', {});
    mockProcess = await waitForProcess(2);
    mockProcess.stdout.emit('data', Buffer.from(success('second JSON answer', 'conv-2')));
    mockProcess.emit('close', 0);
    await expect(promise).resolves.toEqual({ result: 'second JSON answer', sessionId: 'conv-2' });

    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1][calls[0][1].indexOf('--output-format') + 1]).toBe('stream-json');
    expect(calls[1][1][calls[1][1].indexOf('--output-format') + 1]).toBe('json');
  });

  it('falls back once when an older Agy rejects stream output-format', async () => {
    const { spawn } = await import('child_process');
    const runner = new AntigravityRunner({});
    const promise = runner.runStream('hello', {});
    const streamProcess = await waitForProcess();
    streamProcess.stderr.emit(
      'data',
      Buffer.from('flags provided but not defined: -output-format')
    );
    streamProcess.emit('close', 2);

    const legacyProcess = await waitForProcess(2);
    legacyProcess.stdout.emit('data', Buffer.from('old Agy answer'));
    legacyProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'old Agy answer', sessionId: '' });
    expect(spawn).toHaveBeenCalledTimes(2);
    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toContain('--output-format');
    expect(calls[1][1]).not.toContain('--output-format');
  });
});
