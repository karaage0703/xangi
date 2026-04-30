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
    options?: { sessionId?: string; skipPermissions?: boolean }
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
