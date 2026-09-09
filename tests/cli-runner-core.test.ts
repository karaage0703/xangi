import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamCallbacks } from '../src/agent-runner.js';
import type { RunOptions, RunResult } from '../src/agent-runner.js';
import { CliRunnerBase, type CliStreamParser } from '../src/cli-runner-core.js';
import { logResponse } from '../src/transcript-logger.js';

vi.mock('../src/transcript-logger.js', () => ({
  logPrompt: vi.fn(),
  logResponse: vi.fn(),
}));

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

/**
 * テスト用の最小ランナー。
 * イベント形式: {"text": "..."} 累積 / {"fail": "..."} fatal エラー /
 * {"detail": "..."} exit エラー詳細 / {"session_id": "..."}
 */
class TestRunner extends CliRunnerBase {
  protected readonly command = 'test-cli';
  protected readonly displayName = 'Test CLI';
  protected readonly logPrefix = 'test';

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const stdout = await this.collectOutput([prompt], options?.channelId, {
      exitErrorDetail: (out) => {
        const match = out.match(/"detail":\s*"([^"]+)"/);
        return match?.[1];
      },
    });
    return { result: stdout, sessionId: '' };
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    return this.executeStreamCore([prompt], callbacks, { channelId: options?.channelId });
  }

  runStreamWithOpts(
    prompt: string,
    callbacks: StreamCallbacks,
    opts: { channelId?: string; notifyOnError?: boolean }
  ): Promise<RunResult> {
    return this.executeStreamCore([prompt], callbacks, opts);
  }

  logResult(result: RunResult, options?: RunOptions): void {
    this.logResponseTranscript(result, options);
  }

  protected createStreamParser(callbacks: StreamCallbacks): CliStreamParser {
    let fullText = '';
    let sessionId = '';
    let detail: string | undefined;

    return {
      handleEvent: (json, phase) => {
        const event = json as {
          text?: string;
          fail?: string;
          detail?: string;
          session_id?: string;
        };
        if (event.session_id) sessionId = event.session_id;
        if (event.detail) detail = event.detail;
        if (event.fail && phase === 'stream') {
          return new Error(event.fail);
        }
        if (event.text) {
          fullText += event.text;
          if (phase === 'stream') {
            callbacks.onText?.(event.text, fullText);
          }
        }
        return undefined;
      },
      finalize: () => ({ result: fullText, sessionId }),
      exitErrorDetail: () => detail,
    };
  }
}

describe('CliRunnerBase transcript logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists common RunResult usage with the assistant response', () => {
    const runner = new TestRunner({ timeoutMs: 5000, workdir: '/tmp/workspace' });
    runner.logResult(
      {
        result: 'done',
        sessionId: 'provider-session',
        usage: { inputTokens: 120, cachedInputTokens: 80, outputTokens: 12 },
      },
      { appSessionId: 'app-session' }
    );

    expect(logResponse).toHaveBeenCalledWith('/tmp/workspace', 'app-session', {
      result: 'done',
      sessionId: 'provider-session',
      usage: { inputTokens: 120, cachedInputTokens: 80, outputTokens: 12 },
    });
  });
});

async function getMockProcess() {
  const { getMockProcess } = (await import('child_process')) as unknown as {
    getMockProcess: () => {
      stdout: { emit: (event: string, data: string | Buffer) => void };
      stderr: { emit: (event: string, data: string | Buffer) => void };
      emit: (event: string, ...args: unknown[]) => void;
      killed: boolean;
    };
  };
  return getMockProcess();
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('CliRunnerBase collectOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exit エラーの優先度: detail > stderr > exit code のみ', async () => {
    const runner = new TestRunner({ timeoutMs: 5000 });

    // detail あり
    let promise = runner.run('p', { channelId: 'ch1' });
    await tick();
    let proc = await getMockProcess();
    proc.stdout.emit('data', '{"detail": "usage limit reached"}\n');
    proc.stderr.emit('data', 'some stderr');
    proc.emit('close', 1);
    await expect(promise).rejects.toThrow('Test CLI exited with code 1: usage limit reached');

    // detail なし → stderr
    promise = runner.run('p', { channelId: 'ch1' });
    await tick();
    proc = await getMockProcess();
    proc.stderr.emit('data', 'boom from stderr');
    proc.emit('close', 1);
    await expect(promise).rejects.toThrow('Test CLI exited with code 1: boom from stderr');

    // どちらもなし → code のみ
    promise = runner.run('p', { channelId: 'ch1' });
    await tick();
    proc = await getMockProcess();
    proc.emit('close', 1);
    await expect(promise).rejects.toThrow(/Test CLI exited with code 1$/);
  });

  it('channelId が無いときはフォールバックタイマーでタイムアウトする', async () => {
    const runner = new TestRunner({ timeoutMs: 30 });
    const promise = runner.run('p'); // channelId なし
    await expect(promise).rejects.toThrow('Test CLI timed out after 30ms');
    const proc = await getMockProcess();
    expect(proc.killed).toBe(true);
  });

  it('正常終了で stdout を返し、フォールバックタイマーは発火しない', async () => {
    const runner = new TestRunner({ timeoutMs: 50 });
    const promise = runner.run('p');
    await tick();
    const proc = await getMockProcess();
    proc.stdout.emit('data', 'hello');
    proc.emit('close', 0);
    const result = await promise;
    expect(result.result).toBe('hello');
    // タイムアウト時間を過ぎても reject されない（clearTimeout 済み）
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

describe('CliRunnerBase executeStreamCore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('JSONL を逐次パースして onText / onComplete を呼ぶ', async () => {
    const runner = new TestRunner({ timeoutMs: 5000 });
    const texts: string[] = [];
    const onComplete = vi.fn();
    const promise = runner.runStream(
      'p',
      { onText: (t) => texts.push(t), onComplete },
      { channelId: 'ch1' }
    );
    await tick();
    const proc = await getMockProcess();
    proc.stdout.emit('data', '{"session_id": "s1"}\n{"text": "Hel');
    proc.stdout.emit('data', 'lo"}\n{"text": " world"}\n');
    proc.emit('close', 0);
    const result = await promise;
    expect(texts).toEqual(['Hello', ' world']);
    expect(result).toEqual({ result: 'Hello world', sessionId: 's1' });
    expect(onComplete).toHaveBeenCalledWith({ result: 'Hello world', sessionId: 's1' });
  });

  it('改行で終わらない末尾バッファも close 時に flush して取り込む', async () => {
    const runner = new TestRunner({ timeoutMs: 5000 });
    const promise = runner.runStream('p', {}, { channelId: 'ch1' });
    await tick();
    const proc = await getMockProcess();
    proc.stdout.emit('data', '{"text": "tail"}'); // 改行なし
    proc.emit('close', 0);
    const result = await promise;
    expect(result.result).toBe('tail');
  });

  it('UTF-8文字がstdoutチャンク境界で分割されてもJSONLを保持する', async () => {
    const runner = new TestRunner({ timeoutMs: 5000 });
    const promise = runner.runStream('p', {}, { channelId: 'ch1' });
    await tick();
    const proc = await getMockProcess();
    const output = Buffer.from('{"text":"水田チェック"}\n');
    const splitAt = output.indexOf(Buffer.from('水')) + 1;
    proc.stdout.emit('data', output.subarray(0, splitAt));
    proc.stdout.emit('data', output.subarray(splitAt));
    proc.emit('close', 0);

    await expect(promise).resolves.toEqual({ result: '水田チェック', sessionId: '' });
  });

  it('パーサが Error を返したら onError 通知の上で reject する', async () => {
    const runner = new TestRunner({ timeoutMs: 5000 });
    const onError = vi.fn();
    const promise = runner.runStream('p', { onError }, { channelId: 'ch1' });
    await tick();
    const proc = await getMockProcess();
    proc.stdout.emit('data', '{"fail": "fatal stream error"}\n');
    proc.emit('close', 0);
    await expect(promise).rejects.toThrow('fatal stream error');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('notifyOnError: false なら exit エラーでも onError を呼ばない', async () => {
    const runner = new TestRunner({ timeoutMs: 5000 });
    const onError = vi.fn();
    const promise = runner.runStreamWithOpts(
      'p',
      { onError },
      { channelId: 'ch1', notifyOnError: false }
    );
    await tick();
    const proc = await getMockProcess();
    proc.emit('close', 1);
    await expect(promise).rejects.toThrow('Test CLI exited with code 1');
    expect(onError).not.toHaveBeenCalled();
  });

  it('exit エラーに parser の exitErrorDetail を添える', async () => {
    const runner = new TestRunner({ timeoutMs: 5000 });
    const promise = runner.runStream('p', {}, { channelId: 'ch1' });
    await tick();
    const proc = await getMockProcess();
    proc.stdout.emit('data', '{"detail": "quota exceeded"}\n');
    proc.emit('close', 1);
    await expect(promise).rejects.toThrow('Test CLI exited with code 1: quota exceeded');
  });
});

describe('CliRunnerBase cancel / hasRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('channelId 指定で実行中プロセスを kill して true を返す', async () => {
    const runner = new TestRunner({ timeoutMs: 5000 });
    const promise = runner.runStream('p', {}, { channelId: 'ch1' });
    await tick();
    const proc = await getMockProcess();
    expect(runner.hasRunner('ch1')).toBe(true);
    expect(runner.cancel('ch1')).toBe(true);
    expect(proc.killed).toBe(true);
    expect(runner.hasRunner('ch1')).toBe(false);
    proc.emit('close', 1);
    await expect(promise).rejects.toThrow();
  });

  it('実行中プロセスが無ければ false を返す', () => {
    const runner = new TestRunner({ timeoutMs: 5000 });
    expect(runner.cancel('nope')).toBe(false);
    expect(runner.cancel()).toBe(false);
  });
});
