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

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new PersistentRunner({
      workdir: '/test/workdir',
      skipPermissions: true,
    });
  });

  afterEach(async () => {
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
});
