import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PersistentRunner } from '../src/persistent-runner.js';

// Child process をモック
vi.mock('child_process', () => {
  const EventEmitter = require('events');

  class MockProcess extends EventEmitter {
    stdin = {
      write: vi.fn(),
      end: vi.fn(),
    };
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
      // 少し遅延してから init メッセージを送信
      setTimeout(() => {
        mockProcess.stdout.emit(
          'data',
          JSON.stringify({
            type: 'system',
            subtype: 'init',
            session_id: 'test-session-123',
          }) + '\n'
        );
      }, 10);
      return mockProcess;
    }),
    getMockProcess: () => mockProcess,
  };
});

describe('PersistentRunner', () => {
  let runner: PersistentRunner;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_BARE;
    delete process.env.CLAUDE_CODE_MAX_BUDGET_USD;
    runner = new PersistentRunner({
      workdir: '/test/workdir',
      skipPermissions: true,
    });
  });

  afterEach(async () => {
    process.env = originalEnv;
    // shutdown で発生する Promise rejection を無視
    try {
      runner.shutdown();
    } catch {
      // ignore
    }
    // 未処理の Promise を待つ
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('should create a runner instance', () => {
    expect(runner).toBeInstanceOf(PersistentRunner);
    expect(runner.isAlive()).toBe(false); // まだプロセス起動前
  });

  it('should start process on first request', async () => {
    const { spawn, getMockProcess } = await import('child_process');

    // リクエストを送信（レスポンスは手動でシミュレート）
    const runPromise = runner.run('test prompt');

    // プロセスが起動したか確認
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', '--input-format', 'stream-json']),
      expect.any(Object)
    );

    // レスポンスをシミュレート
    const mockProcess = getMockProcess();
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'test response',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    const result = await runPromise;
    expect(result.result).toBe('test response');
    expect(result.sessionId).toBe('test-session-123');
  });

  it('should queue multiple requests', async () => {
    const { getMockProcess } = await import('child_process');

    // 複数のリクエストを送信
    const promise1 = runner.run('prompt 1');
    const promise2 = runner.run('prompt 2');

    expect(runner.getQueueLength()).toBeGreaterThanOrEqual(1);

    // 最初のレスポンス
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = getMockProcess();
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'response 1',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    const result1 = await promise1;
    expect(result1.result).toBe('response 1');

    // 2番目のレスポンス
    await new Promise((resolve) => setTimeout(resolve, 50));
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'response 2',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    const result2 = await promise2;
    expect(result2.result).toBe('response 2');
  });

  it('should call streaming callbacks', async () => {
    const { getMockProcess } = await import('child_process');

    const onText = vi.fn();
    const onComplete = vi.fn();

    const promise = runner.runStream('test prompt', { onText, onComplete });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = getMockProcess();

    // テキストストリーム
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello ' }],
        },
      }) + '\n'
    );

    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'World!' }],
        },
      }) + '\n'
    );

    // 結果
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'Hello World!',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    await promise;

    expect(onText).toHaveBeenCalledWith('Hello ', 'Hello ');
    expect(onText).toHaveBeenCalledWith('World!', 'Hello World!');
    expect(onComplete).toHaveBeenCalled();
  });

  it('should handle errors', async () => {
    const { getMockProcess } = await import('child_process');

    const onError = vi.fn();
    const promise = runner.runStream('test prompt', { onError });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = getMockProcess();

    // エラーレスポンス
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'Something went wrong',
        session_id: 'test-session-123',
        is_error: true,
      }) + '\n'
    );

    await expect(promise).rejects.toThrow('Something went wrong');
    expect(onError).toHaveBeenCalled();
  });

  it('should include Claude Code error subtype when result text is missing', async () => {
    const { getMockProcess } = await import('child_process');

    const onError = vi.fn();
    const promise = runner.runStream('test prompt', { onError });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = getMockProcess();

    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'test-session-123',
        is_error: true,
      }) + '\n'
    );

    await expect(promise).rejects.toThrow('Claude Code returned error: error_during_execution');
    expect(onError).toHaveBeenCalled();
  });

  it('should emit Claude Code internal tool_use events to stream callbacks', async () => {
    const { getMockProcess } = await import('child_process');

    const onToolUse = vi.fn();
    const promise = runner.runStream('test prompt', { onToolUse });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = getMockProcess();

    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'cat /home/karaage/borot/AGENTS.md' },
            },
          ],
        },
      }) + '\n'
    );

    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'ok',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    await expect(promise).resolves.toMatchObject({ result: 'ok' });
    expect(onToolUse).toHaveBeenCalledWith('Bash', {
      command: 'cat /home/karaage/borot/AGENTS.md',
    });
  });

  it('should shutdown properly', async () => {
    // プロセスを起動
    const promise = runner.run('test').catch(() => {
      // shutdown によるエラーは無視
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    runner.shutdown();
    expect(runner.isAlive()).toBe(false);

    // Promise が終了するのを待つ
    await promise;
  });

  it('should cancel current request', async () => {
    const onError = vi.fn();
    const promise = runner.runStream('test prompt', { onError });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // cancel を呼ぶ
    const cancelled = runner.cancel();
    expect(cancelled).toBe(true);
    expect(onError).toHaveBeenCalled();

    await expect(promise).rejects.toThrow('Request cancelled by user');
  });

  it('should return false when cancelling with no active request', () => {
    const cancelled = runner.cancel();
    expect(cancelled).toBe(false);
  });

  it('should process next queued request after cancel', async () => {
    const { getMockProcess } = await import('child_process');

    const onError1 = vi.fn();
    const promise1 = runner.runStream('prompt 1', { onError: onError1 });
    const promise2 = runner.run('prompt 2');

    await new Promise((resolve) => setTimeout(resolve, 50));

    // 最初のリクエストをキャンセル
    runner.cancel();
    await expect(promise1).rejects.toThrow('Request cancelled by user');

    // 2番目のリクエストが処理される
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = getMockProcess();
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'response 2',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    const result2 = await promise2;
    expect(result2.result).toBe('response 2');
  });

  it('records provider model per persistent request and excludes child usage', async () => {
    const { getMockProcess } = await import('child_process');
    const onModel = vi.fn();
    const first = runner.runStream('first', { onModel });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const proc = getMockProcess();
    const emit = (event: unknown) => proc.stdout.emit('data', JSON.stringify(event) + '\n');
    emit({ type: 'assistant', message: { model: 'main-a', content: [] } });
    emit({ type: 'assistant', parent_tool_use_id: 'child', message: { model: 'child', content: [] } });
    emit({ type: 'result', result: 'ok', session_id: 'test-session-123' });
    expect((await first).models).toEqual(['main-a']);
    expect(onModel.mock.calls.flat()).toEqual(['main-a']);
    const second = runner.runStream('second', { onModel });
    emit({ type: 'result', result: 'ok', session_id: 'test-session-123' });
    expect((await second).model).toBeUndefined();
  });

  it('should preserve streamed text when result only has final text', async () => {
    // 問題2のテスト: ツール呼び出し前に出力されたテキストが result で消えないこと
    const { getMockProcess } = await import('child_process');

    const onText = vi.fn();
    const onComplete = vi.fn();

    const promise = runner.runStream('test prompt', { onText, onComplete });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = getMockProcess();

    // ツール呼び出し前にテキスト出力（!discord send を含む）
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '!discord send <#123> 作業開始します\n' }],
        },
      }) + '\n'
    );

    // ツール呼び出し後にテキスト出力
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '調査が完了しました。' }],
        },
      }) + '\n'
    );

    // result には最後のテキストだけが入る（Claude Code CLIの実際の挙動）
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: '調査が完了しました。',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    const result = await promise;

    // 累積テキスト全体が保持されていること
    expect(result.result).toContain('!discord send <#123> 作業開始します');
    expect(result.result).toContain('調査が完了しました。');
  });

  it('should not duplicate text when result matches streamed', async () => {
    // result と streamed が同一の場合は重複しないこと
    const { getMockProcess } = await import('child_process');

    const promise = runner.run('test prompt');

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = getMockProcess();

    // テキスト出力
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello World!' }],
        },
      }) + '\n'
    );

    // result が streamed と同じ
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'Hello World!',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    const result = await promise;
    // 重複していないこと
    expect(result.result).toBe('Hello World!');
  });

  it('should report session ID', async () => {
    const { getMockProcess } = await import('child_process');

    const promise = runner.run('test');

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = getMockProcess();

    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'ok',
        session_id: 'my-session-id',
        is_error: false,
      }) + '\n'
    );

    await promise;
    expect(runner.getSessionId()).toBe('my-session-id');

    // テスト終了前に明示的に shutdown してエラーを catch
    try {
      runner.shutdown();
    } catch {
      // ignore
    }
  });

  // リグレッションテスト: PersistentRunner が channelId を XANGI_CHANNEL_ID として
  // claude 子プロセスに注入することを検証。これが漏れると常駐セッション内から
  // xangi-cmd を呼んだ時に context.channelId が空になり、tool-server で
  // 「channel未指定」エラーが返って content-digest 等の投稿確認が失敗する。
  it('should inject XANGI_CHANNEL_ID into spawned process when channelId is provided', async () => {
    const { spawn } = await import('child_process');
    (spawn as unknown as { mockClear: () => void }).mockClear();

    const channelRunner = new PersistentRunner({
      workdir: '/test/workdir',
      skipPermissions: true,
      channelId: 'test-channel-456',
    });

    // run() でプロセス起動をトリガー（レスポンスは待たない）
    channelRunner.run('test prompt').catch(() => {
      // shutdown によるエラーは無視
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawn).toHaveBeenCalled();
    const callArgs = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const spawnOptions = callArgs[2] as { env: Record<string, string | undefined> };
    expect(spawnOptions.env.XANGI_CHANNEL_ID).toBe('test-channel-456');

    try {
      channelRunner.shutdown();
    } catch {
      // ignore
    }
  });

  it('should NOT inject XANGI_CHANNEL_ID when channelId is not provided', async () => {
    const { spawn } = await import('child_process');
    (spawn as unknown as { mockClear: () => void }).mockClear();

    // 既定の runner は constructor に channelId なし
    runner.run('test prompt').catch(() => {
      // ignore
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawn).toHaveBeenCalled();
    const callArgs = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const spawnOptions = callArgs[2] as { env: Record<string, string | undefined> };
    expect(spawnOptions.env.XANGI_CHANNEL_ID).toBeUndefined();
  });

  it('should pass ANTHROPIC_API_KEY only to the Claude Code child process when set', async () => {
    const { spawn } = await import('child_process');
    (spawn as unknown as { mockClear: () => void }).mockClear();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

    const apiRunner = new PersistentRunner({
      workdir: '/test/workdir',
      skipPermissions: true,
    });

    apiRunner.run('test prompt').catch(() => {
      // ignore
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const callArgs = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const spawnOptions = callArgs[2] as { env: Record<string, string | undefined> };
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');

    try {
      apiRunner.shutdown();
    } catch {
      // ignore
    }
  });

  it('should include Claude Code API mode args when configured', async () => {
    const { spawn } = await import('child_process');
    (spawn as unknown as { mockClear: () => void }).mockClear();
    process.env.CLAUDE_CODE_BARE = 'true';
    process.env.CLAUDE_CODE_MAX_BUDGET_USD = '0.25';

    const apiRunner = new PersistentRunner({
      workdir: '/test/workdir',
      skipPermissions: true,
    });

    apiRunner.run('test prompt').catch(() => {
      // ignore
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const callArgs = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const args = callArgs[1] as string[];
    expect(args).toContain('--bare');
    const budgetIndex = args.indexOf('--max-budget-usd');
    expect(budgetIndex).toBeGreaterThan(-1);
    expect(args[budgetIndex + 1]).toBe('0.25');

    try {
      apiRunner.shutdown();
    } catch {
      // ignore
    }
  });

  // ─── Timeout extend (Issue #235) ───

  it('getTimeoutState returns active=false before any request', () => {
    const state = runner.getTimeoutState();
    expect(state.active).toBe(false);
  });

  it('extendTimeout returns no_active_request before any request', () => {
    const result = runner.extendTimeout(undefined, 5 * 60_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_active_request');
  });

  it('getTimeoutState returns active=true with timeoutAt during a running request', async () => {
    runner.run('test prompt').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    const state = runner.getTimeoutState();
    expect(state.active).toBe(true);
    expect(state.timeoutAt).toBeGreaterThan(Date.now());
    expect(state.maxTimeoutAt).toBeGreaterThan(state.timeoutAt!);
    // 初期 timeoutMs = DEFAULT_TIMEOUT_MS (30 分)
    expect(state.timeoutMs).toBe(30 * 60_000);
    expect(state.remainingMs).toBeGreaterThan(0);
  });

  it('extendTimeout extends timeoutAt by additionalMs during a running request', async () => {
    runner.run('test prompt').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    const before = runner.getTimeoutState();
    const beforeTimeoutAt = before.timeoutAt!;
    const result = runner.extendTimeout(undefined, 5 * 60_000);

    expect(result.ok).toBe(true);
    expect(result.timeoutAt).toBe(beforeTimeoutAt + 5 * 60_000);
    expect(result.timeoutMs).toBe(35 * 60_000); // 30 + 5 分
    expect(result.remainingMs).toBeGreaterThan(0);

    const after = runner.getTimeoutState();
    expect(after.timeoutAt).toBe(beforeTimeoutAt + 5 * 60_000);
  });

  it('extendTimeout fails with max_timeout_exceeded when exceeding 10h cap', async () => {
    runner.run('test prompt').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 10 時間を超える延長を要求 → 拒否
    const result = runner.extendTimeout(undefined, 10 * 60 * 60_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('max_timeout_exceeded');
    expect(result.maxTimeoutAt).toBeGreaterThan(Date.now());

    // 元の timeoutAt は変わっていないこと
    const state = runner.getTimeoutState();
    expect(state.timeoutMs).toBe(30 * 60_000);
  });

  it('extendTimeout can be called multiple times until reaching cap', async () => {
    runner.run('test prompt').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 30 分初期 + 19 回 30 分延長 = 10 時間 (上限ぴったり)、20 回目で超える
    for (let i = 0; i < 19; i++) {
      const r = runner.extendTimeout(undefined, 30 * 60_000);
      expect(r.ok).toBe(true);
    }
    const final = runner.getTimeoutState();
    expect(final.timeoutMs).toBe(10 * 60 * 60_000);

    const overflow = runner.extendTimeout(undefined, 30 * 60_000);
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toBe('max_timeout_exceeded');
  });

  it('emits timeout-started on request start and timeout-cleared on completion', async () => {
    const { getMockProcess } = await import('child_process');
    const startedSpy = vi.fn();
    const clearedSpy = vi.fn();
    runner.on('timeout-started', startedSpy);
    runner.on('timeout-cleared', clearedSpy);

    const promise = runner.run('test prompt');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startedSpy).toHaveBeenCalledTimes(1);
    const startedPayload = startedSpy.mock.calls[0][0];
    expect(startedPayload.timeoutAt).toBeGreaterThan(Date.now());
    expect(startedPayload.maxTimeoutAt).toBeGreaterThan(startedPayload.timeoutAt);

    const mockProcess = getMockProcess();
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'done',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );
    await promise;
    expect(clearedSpy).toHaveBeenCalledTimes(1);
    expect(clearedSpy.mock.calls[0][0].reason).toBe('completed');
  });

  it('emits timeout-extended when extendTimeout succeeds', async () => {
    const extendedSpy = vi.fn();
    runner.on('timeout-extended', extendedSpy);

    runner.run('test prompt').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    runner.extendTimeout(undefined, 5 * 60_000);
    expect(extendedSpy).toHaveBeenCalledTimes(1);
    const payload = extendedSpy.mock.calls[0][0];
    expect(payload.timeoutAt).toBeGreaterThan(Date.now());
    expect(payload.timeoutMs).toBe(35 * 60_000);
    expect(payload.remainingMs).toBeGreaterThan(0);
  });
});

// issue #286: どの経路でプロセスを失っても呼び出し側の Promise を必ず settle させる
describe('PersistentRunner orphaned request prevention (issue #286)', () => {
  let runner: PersistentRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new PersistentRunner({
      workdir: '/test/workdir',
      skipPermissions: true,
    });
  });

  afterEach(async () => {
    try {
      runner.shutdown();
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('rejects in-flight request when process closes while shuttingDown flag is set', async () => {
    const { getMockProcess } = await import('child_process');

    const promise = runner.run('test prompt');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // shutdown フラグだけ立った状態 (本来 shutdown() が reject するが、
    // 何らかの経路で currentItem が残った場合のセーフティネット)
    (runner as unknown as { shuttingDown: boolean }).shuttingDown = true;
    const mockProcess = getMockProcess() as unknown as { emit: (e: string, c: number) => void };
    mockProcess.emit('close', 143);

    await expect(promise).rejects.toThrow(/shutdown/);
  });

  it('rejects in-flight request when process closes while cancelling flag is set', async () => {
    const { getMockProcess } = await import('child_process');

    const promise = runner.run('test prompt');
    await new Promise((resolve) => setTimeout(resolve, 50));

    (runner as unknown as { cancelling: boolean }).cancelling = true;
    const mockProcess = getMockProcess() as unknown as { emit: (e: string, c: number) => void };
    mockProcess.emit('close', 143);

    await expect(promise).rejects.toThrow(/cancellation/);
  });

  it('ignores stale close events from a previous process', async () => {
    const { getMockProcess } = await import('child_process');

    // 1 つ目のプロセスがクラッシュ
    const promise1 = runner.run('prompt 1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const procA = getMockProcess() as unknown as {
      emit: (e: string, c: number) => void;
      stdout: { emit: (e: string, d: string) => void };
    };
    procA.emit('close', 1);
    await expect(promise1).rejects.toThrow(/exited unexpectedly/);

    // 2 つ目のリクエストが新プロセスで進行中
    const promise2 = runner.run('prompt 2');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const procB = getMockProcess() as unknown as {
      emit: (e: string, c: number) => void;
      stdout: { emit: (e: string, d: string) => void };
    };
    expect(procB).not.toBe(procA);

    // 古いプロセスの close が遅れて届いても新リクエストに影響しない
    procA.emit('close', 143);

    procB.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'response 2',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    const result2 = await promise2;
    expect(result2.result).toBe('response 2');
  });

  it('rejects queued requests on shutdown even when process is null', async () => {
    // プロセス未起動のまま queue にアイテムが残った状況を直接再現
    const promise = new Promise((resolve, reject) => {
      (
        runner as unknown as {
          queue: Array<{ prompt: string; resolve: unknown; reject: unknown }>;
        }
      ).queue.push({ prompt: 'orphan', resolve, reject });
    });

    runner.shutdown();

    await expect(promise).rejects.toThrow('Runner is shutting down');
  });

  it('rejects request instead of hanging when circuit breaker is open', async () => {
    const { getMockProcess } = await import('child_process');

    // 1 分以内に 3 回クラッシュさせてサーキットブレーカーを開く
    for (let i = 0; i < 3; i++) {
      const p = runner.run(`prompt ${i}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      (getMockProcess() as unknown as { emit: (e: string, c: number) => void }).emit('close', 1);
      await expect(p).rejects.toThrow();
    }

    // ブレーカーオープン中のリクエストは throw で宙吊りにならず reject される
    await expect(runner.run('prompt after open')).rejects.toThrow(/Circuit breaker open/);
  });

  it('reports isBusy during request and idle after completion', async () => {
    const { getMockProcess } = await import('child_process');

    expect(runner.isBusy()).toBe(false);

    const promise = runner.run('test prompt');
    expect(runner.isBusy()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const mockProcess = getMockProcess() as unknown as {
      stdout: { emit: (e: string, d: string) => void };
    };
    mockProcess.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'done',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    await promise;
    expect(runner.isBusy()).toBe(false);
  });

  it('resumes queued requests after cancel when close arrives late (stale-guard regression)', async () => {
    const { getMockProcess } = await import('child_process');

    const promise1 = runner.run('one');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const procA = getMockProcess() as unknown as {
      emit: (e: string, c: number) => void;
      kill: () => void;
      killed: boolean;
    };

    const promise2 = runner.run('two'); // procA が busy なのでキュー待ち
    expect(runner.getQueueLength()).toBe(1);

    // 実環境では kill() の close は非同期に届く (mock は同期 emit なので無効化して再現)
    procA.kill = () => {
      procA.killed = true;
    };

    expect(runner.cancel()).toBe(true);
    await expect(promise1).rejects.toThrow('Request cancelled by user');

    // 遅れて close が届く → cancelling リセット + キューの次リクエストが開始される
    procA.emit('close', 143);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const procB = getMockProcess() as unknown as {
      emit: (e: string, c: number) => void;
      stdout: { emit: (e: string, d: string) => void };
    };
    expect(procB).not.toBe(procA);
    procB.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        result: 'response two',
        session_id: 'test-session-123',
        is_error: false,
      }) + '\n'
    );

    const result2 = await promise2;
    expect(result2.result).toBe('response two');
  });
});
