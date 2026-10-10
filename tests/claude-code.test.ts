import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeCodeRunner } from '../src/claude-code.js';

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

// fs をモック（loadProjectContext でファイル読み込みを防止）
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

describe('ClaudeCodeRunner args', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_BARE;
    delete process.env.CLAUDE_CODE_MAX_BUDGET_USD;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  /**
   * spawn に渡された引数を取得するヘルパー
   */
  async function getSpawnArgs(
    runner: ClaudeCodeRunner,
    prompt: string,
    options?: { sessionId?: string; skipPermissions?: boolean; secret?: boolean }
  ) {
    const { spawn, getMockProcess } = await import('child_process');

    const runPromise = runner.run(prompt, options);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const spawnMock = spawn as ReturnType<typeof vi.fn>;
    const callArgs = spawnMock.mock.calls[0];
    const command = callArgs[0] as string;
    const args = callArgs[1] as string[];
    const spawnOptions = callArgs[2] as { cwd?: string; env: NodeJS.ProcessEnv };

    // プロセスを終了させてクリーンアップ
    const mockProcess = (getMockProcess as () => any)();
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        session_id: 'test-session',
        total_cost_usd: 0,
        duration_ms: 100,
      })
    );
    mockProcess.emit('close', 0);

    await runPromise.catch(() => {});

    return { command, args, spawnOptions };
  }

  it('uses nonpersistent print mode without overriding user memory/hooks settings', async () => {
    const { args } = await getSpawnArgs(new ClaudeCodeRunner({}), 'private', { secret: true, sessionId: 'old' });
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--settings');
  });

  it('should include basic args', async () => {
    const runner = new ClaudeCodeRunner({});
    const { command, args } = await getSpawnArgs(runner, 'hello');

    expect(command).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('should include --dangerously-skip-permissions when skipPermissions is true', async () => {
    const runner = new ClaudeCodeRunner({ skipPermissions: true });
    const { args } = await getSpawnArgs(runner, 'hello');

    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('should not include --dangerously-skip-permissions when skipPermissions is false', async () => {
    const runner = new ClaudeCodeRunner({ skipPermissions: false });
    const { args } = await getSpawnArgs(runner, 'hello');

    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('should include --resume with sessionId', async () => {
    const runner = new ClaudeCodeRunner({});
    const { args } = await getSpawnArgs(runner, 'hello', { sessionId: 'abc-123' });

    const resumeIndex = args.indexOf('--resume');
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(args[resumeIndex + 1]).toBe('abc-123');
  });

  it('should include --model when model is set', async () => {
    const runner = new ClaudeCodeRunner({ model: 'claude-sonnet-4-5-20250929' });
    const { args } = await getSpawnArgs(runner, 'hello');

    const modelIndex = args.indexOf('--model');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(args[modelIndex + 1]).toBe('claude-sonnet-4-5-20250929');
  });

  it('passes ANTHROPIC_API_KEY only to the Claude Code child process when set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const runner = new ClaudeCodeRunner({});
    const { spawnOptions } = await getSpawnArgs(runner, 'hello');

    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
  });

  it('should include --bare when CLAUDE_CODE_BARE=true', async () => {
    process.env.CLAUDE_CODE_BARE = 'true';
    const runner = new ClaudeCodeRunner({});
    const { args } = await getSpawnArgs(runner, 'hello');

    expect(args).toContain('--bare');
  });

  it('should include --max-budget-usd when CLAUDE_CODE_MAX_BUDGET_USD is set', async () => {
    process.env.CLAUDE_CODE_MAX_BUDGET_USD = '0.25';
    const runner = new ClaudeCodeRunner({});
    const { args } = await getSpawnArgs(runner, 'hello');

    const budgetIndex = args.indexOf('--max-budget-usd');
    expect(budgetIndex).toBeGreaterThan(-1);
    expect(args[budgetIndex + 1]).toBe('0.25');
  });

  it('should include --append-system-prompt', async () => {
    const runner = new ClaudeCodeRunner({});
    const { args } = await getSpawnArgs(runner, 'hello');

    expect(args).toContain('--append-system-prompt');
  });

  it('should place prompt as the last argument (with runtime context prepended)', async () => {
    const runner = new ClaudeCodeRunner({});
    const { args } = await getSpawnArgs(runner, 'test prompt');

    const lastArg = args[args.length - 1];
    // runtime context が先頭に付き、ユーザープロンプト本文が末尾に来る
    expect(lastArg.endsWith('test prompt')).toBe(true);
    expect(lastArg).toMatch(/^\[runtime\] /);
  });

  it('should use workdir as cwd in spawn options', async () => {
    const runner = new ClaudeCodeRunner({ workdir: '/tmp/test' });
    const { spawnOptions } = await getSpawnArgs(runner, 'hello');

    expect(spawnOptions.cwd).toBe('/tmp/test');
  });

  it('should have correct arg order with all options', async () => {
    const runner = new ClaudeCodeRunner({
      model: 'claude-sonnet-4-5-20250929',
      skipPermissions: true,
    });
    const { args } = await getSpawnArgs(runner, 'do stuff', { sessionId: 'sess-456' });

    // -p と --output-format json は最初
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('--output-format');
    expect(args[2]).toBe('json');

    // prompt は最後（runtime context が先頭に付くため、本文は末尾に来る）
    const lastArg = args[args.length - 1];
    expect(lastArg.endsWith('do stuff')).toBe(true);
    expect(lastArg).toMatch(/^\[runtime\] /);

    // 各オプションが含まれている
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--resume');
    expect(args).toContain('--model');
    expect(args).toContain('--append-system-prompt');
  });
});
