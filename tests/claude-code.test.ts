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
    runner: ClaudeCodeRunner,
    prompt: string,
    options?: { sessionId?: string; skipPermissions?: boolean }
  ) {
    const { spawn, getMockProcess } = await import('child_process');

    const runPromise = runner.run(prompt, options);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const spawnMock = spawn as ReturnType<typeof vi.fn>;
    const callArgs = spawnMock.mock.calls[0];
    const command = callArgs[0] as string;
    const args = callArgs[1] as string[];
    const spawnOptions = callArgs[2] as { cwd?: string };

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

  it('should include --append-system-prompt', async () => {
    const runner = new ClaudeCodeRunner({});
    const { args } = await getSpawnArgs(runner, 'hello');

    expect(args).toContain('--append-system-prompt');
  });

  it('should place prompt as the last argument', async () => {
    const runner = new ClaudeCodeRunner({});
    const { args } = await getSpawnArgs(runner, 'test prompt');

    const lastArg = args[args.length - 1];
    expect(lastArg).toBe('test prompt');
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

    // prompt は最後
    expect(args[args.length - 1]).toBe('do stuff');

    // 各オプションが含まれている
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--resume');
    expect(args).toContain('--model');
    expect(args).toContain('--append-system-prompt');
  });
});
