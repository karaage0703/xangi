import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexRunner } from '../src/codex-cli.js';

// child_process をモック
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

// fs をモック（buildSystemPrompt でファイル読み込みを防止）
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

describe('CodexRunner buildArgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * spawn に渡された引数を取得するヘルパー
   */
  async function getSpawnArgs(
    runner: CodexRunner,
    prompt: string,
    options?: {
      sessionId?: string;
      skipPermissions?: boolean;
      effort?: 'low' | 'medium' | 'high' | 'max';
    }
  ) {
    const { spawn, getMockProcess } = await import('child_process');

    // run を開始（完了は待たない）
    const runPromise = runner.run(prompt, options);

    // spawn が呼ばれるまで少し待つ
    await new Promise((resolve) => setTimeout(resolve, 50));

    // spawn の呼び出し引数を取得
    const spawnMock = spawn as ReturnType<typeof vi.fn>;
    const callArgs = spawnMock.mock.calls[0];
    const command = callArgs[0] as string;
    const args = callArgs[1] as string[];

    // プロセスを終了させてクリーンアップ
    const mockProcess = (getMockProcess as () => any)();
    mockProcess.emit('close', 0);

    // run の結果を待つ（エラーは無視）
    await runPromise.catch(() => {});

    return { command, args };
  }

  it('should include basic args', async () => {
    const runner = new CodexRunner({});
    const { command, args } = await getSpawnArgs(runner, 'hello');

    expect(command).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    expect(args).toContain('--full-auto');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('should use --dangerously-bypass-approvals-and-sandbox when skipPermissions is true', async () => {
    const runner = new CodexRunner({ skipPermissions: true });
    const { args } = await getSpawnArgs(runner, 'hello');

    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--full-auto');
  });

  it('should use --full-auto when skipPermissions is false', async () => {
    const runner = new CodexRunner({ skipPermissions: false });
    const { args } = await getSpawnArgs(runner, 'hello');

    expect(args).toContain('--full-auto');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('should include --model when model is set', async () => {
    const runner = new CodexRunner({ model: 'o3' });
    const { args } = await getSpawnArgs(runner, 'hello');

    const modelIndex = args.indexOf('--model');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(args[modelIndex + 1]).toBe('o3');
  });

  it('should pass effort as model_reasoning_effort config', async () => {
    const runner = new CodexRunner({});
    const { args } = await getSpawnArgs(runner, 'hello', { effort: 'max' });

    const configIndex = args.indexOf('--config');
    expect(configIndex).toBeGreaterThan(-1);
    expect(args[configIndex + 1]).toBe('model_reasoning_effort="max"');
  });

  it('should place effort config before resume subcommand', async () => {
    const runner = new CodexRunner({});
    const { args } = await getSpawnArgs(runner, 'hello', {
      sessionId: 'abc-123',
      effort: 'high',
    });

    const configIndex = args.indexOf('--config');
    const resumeIndex = args.indexOf('resume');
    expect(configIndex).toBeLessThan(resumeIndex);
    expect(args[configIndex + 1]).toBe('model_reasoning_effort="high"');
  });

  it('should include --cd when workdir is set', async () => {
    const runner = new CodexRunner({ workdir: '/tmp/test' });
    const { args } = await getSpawnArgs(runner, 'hello');

    const cdIndex = args.indexOf('--cd');
    expect(cdIndex).toBeGreaterThan(-1);
    expect(args[cdIndex + 1]).toBe('/tmp/test');
  });

  it('should include resume with sessionId', async () => {
    const runner = new CodexRunner({});
    const { args } = await getSpawnArgs(runner, 'hello', { sessionId: 'abc-123' });

    expect(args).toContain('resume');
    const resumeIndex = args.indexOf('resume');
    expect(args[resumeIndex + 1]).toBe('abc-123');
  });

  it('should place --cd and --model BEFORE resume subcommand', async () => {
    const runner = new CodexRunner({ model: 'o3', workdir: '/tmp/test' });
    const { args } = await getSpawnArgs(runner, 'hello', { sessionId: 'abc-123' });

    const modelIndex = args.indexOf('--model');
    const cdIndex = args.indexOf('--cd');
    const resumeIndex = args.indexOf('resume');

    // --model と --cd は resume の前にあるべき
    expect(modelIndex).toBeLessThan(resumeIndex);
    expect(cdIndex).toBeLessThan(resumeIndex);
  });

  it('should place prompt as the last argument', async () => {
    const runner = new CodexRunner({});
    const { args } = await getSpawnArgs(runner, 'test prompt');

    // 最後の引数がプロンプトを含む
    const lastArg = args[args.length - 1];
    expect(lastArg).toContain('test prompt');
  });

  it('should pass platform-specific xangi commands in the system prompt', async () => {
    const runner = new CodexRunner({ platform: 'discord' });
    const { args } = await getSpawnArgs(runner, 'test prompt');

    const lastArg = args[args.length - 1];
    expect(lastArg).toContain('Discord操作');
    expect(lastArg).not.toContain('Slack操作');
  });

  it('should place prompt after resume and sessionId', async () => {
    const runner = new CodexRunner({});
    const { args } = await getSpawnArgs(runner, 'test prompt', { sessionId: 'abc-123' });

    const resumeIndex = args.indexOf('resume');
    const lastArg = args[args.length - 1];

    expect(resumeIndex).toBeGreaterThan(-1);
    expect(lastArg).toContain('test prompt');
    // プロンプトは resume + sessionId の後
    expect(args.length - 1).toBeGreaterThan(resumeIndex + 1);
  });

  it('should have correct full arg order with all options', async () => {
    const runner = new CodexRunner({ model: 'o3', workdir: '/tmp/test', skipPermissions: true });
    const { args } = await getSpawnArgs(runner, 'do stuff', { sessionId: 'sess-456' });

    // 期待される順序:
    // exec --json --dangerously-bypass... --skip-git-repo-check --model o3 --cd /tmp/test resume sess-456 <prompt>
    const execIndex = args.indexOf('exec');
    const jsonIndex = args.indexOf('--json');
    const skipGitIndex = args.indexOf('--skip-git-repo-check');
    const modelIndex = args.indexOf('--model');
    const cdIndex = args.indexOf('--cd');
    const resumeIndex = args.indexOf('resume');

    expect(execIndex).toBe(0);
    expect(jsonIndex).toBe(1);
    expect(skipGitIndex).toBeLessThan(modelIndex);
    expect(modelIndex).toBeLessThan(cdIndex);
    expect(cdIndex).toBeLessThan(resumeIndex);
    expect(resumeIndex).toBeLessThan(args.length - 1); // prompt is last
  });
});

describe('CodexRunner エラー本文の救出', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * stdout に流すイベントを emit してから code で close する。
   */
  async function emitEventsThenClose(events: object[], code: number) {
    const { getMockProcess } = await import('child_process');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = (getMockProcess as () => any)();
    for (const ev of events) {
      mockProcess.stdout.emit('data', Buffer.from(JSON.stringify(ev) + '\n'));
    }
    mockProcess.emit('close', code);
  }

  it('runStream: error イベントの message を exit エラーに含める', async () => {
    const runner = new CodexRunner({});
    let captured: Error | undefined;
    const promise = runner.runStream('hi', { onError: (e) => (captured = e) });

    await emitEventsThenClose(
      [{ type: 'error', message: "You've hit your usage limit. try again at 5:58 AM." }],
      1
    );

    await expect(promise).rejects.toThrow(/exited with code 1/);
    await promise.catch(() => {});
    expect(captured?.message).toContain('usage limit');
    expect(captured?.message).toContain('5:58 AM');
  });

  it('runStream: stale resume error retries with a new session without surfacing onError', async () => {
    const runner = new CodexRunner({});
    const { spawn, getMockProcess } = await import('child_process');
    const errors: Error[] = [];

    const promise = runner.runStream(
      'hi',
      { onError: (e) => errors.push(e) },
      { sessionId: 'old-thread' }
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const firstProcess = (getMockProcess as () => any)();
    firstProcess.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'turn.failed',
          error: { message: 'thread/resume failed: no rollout found for thread id old-thread' },
        }) + '\n'
      )
    );
    firstProcess.emit('close', 1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondProcess = (getMockProcess as () => any)();
    secondProcess.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 'new-thread' }) + '\n')
    );
    secondProcess.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) +
          '\n'
      )
    );
    secondProcess.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: 'ok', sessionId: 'new-thread' });
    expect(errors).toEqual([]);

    const spawnMock = spawn as ReturnType<typeof vi.fn>;
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][1]).toContain('resume');
    expect(spawnMock.mock.calls[1][1]).not.toContain('resume');
  });

  it('runStream: turn.failed イベントの error.message を救出する', async () => {
    const runner = new CodexRunner({});
    const promise = runner.runStream('hi', {});

    await emitEventsThenClose([{ type: 'turn.failed', error: { message: 'rate limited' } }], 1);

    await expect(promise).rejects.toThrow(/rate limited/);
  });

  it('run: error イベントが無ければ従来どおり exit code のみ', async () => {
    const runner = new CodexRunner({});
    const promise = runner.run('hi');

    await emitEventsThenClose([], 1);

    await expect(promise).rejects.toThrow(/Codex CLI exited with code 1/);
  });

  it('run: 空の agent_message は raw JSONL ではなく空文字として返す', async () => {
    const runner = new CodexRunner({});
    const promise = runner.run('hi');

    await emitEventsThenClose(
      [
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: {
            id: 'item_0',
            type: 'command_execution',
            command: '/bin/bash -lc true',
            aggregated_output: '',
            exit_code: 0,
            status: 'completed',
          },
        },
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '' } },
      ],
      0
    );

    await expect(promise).resolves.toEqual({ result: '', sessionId: 'thread-1' });
  });

  it('runStream: exit 0 なら error イベントが無くても正常完了', async () => {
    const runner = new CodexRunner({});
    const promise = runner.runStream('hi', {});

    await emitEventsThenClose(
      [{ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }],
      0
    );

    const result = await promise;
    expect(result.result).toBe('done');
  });

  it('runStream: Codex tool call event を onToolUse に流す', async () => {
    const runner = new CodexRunner({});
    const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
    const promise = runner.runStream('hi', {
      onToolUse: (name, input) => tools.push({ name, input }),
    });

    await emitEventsThenClose(
      [
        {
          type: 'item.started',
          item: {
            id: 'call-1',
            type: 'function_call',
            name: 'exec_command',
            arguments: '{"cmd":"ls -la"}',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'call-1',
            type: 'function_call',
            name: 'exec_command',
            arguments: '{"cmd":"ls -la"}',
          },
        },
        { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      ],
      0
    );

    const result = await promise;
    expect(result.result).toBe('done');
    expect(tools).toEqual([{ name: 'exec_command', input: { cmd: 'ls -la' } }]);
  });

  it('runStream: Codex command_execution event を Bash の onToolUse に流す', async () => {
    const runner = new CodexRunner({});
    const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
    const promise = runner.runStream('hi', {
      onToolUse: (name, input) => tools.push({ name, input }),
    });

    await emitEventsThenClose(
      [
        {
          type: 'item.started',
          item: {
            id: 'item_0',
            type: 'command_execution',
            command: '/bin/bash -lc pwd',
            aggregated_output: '',
            exit_code: null,
            status: 'in_progress',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'item_0',
            type: 'command_execution',
            command: '/bin/bash -lc pwd',
            aggregated_output: '/tmp\n',
            exit_code: 0,
            status: 'completed',
          },
        },
        { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      ],
      0
    );

    const result = await promise;
    expect(result.result).toBe('done');
    expect(tools).toEqual([{ name: 'Bash', input: { command: '/bin/bash -lc pwd' } }]);
  });
});
