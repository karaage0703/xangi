import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexRunner, classifyResumeError } from '../src/codex-cli.js';

const SESSION_ID = '01a0a241-ca10-7921-8047-fe849837e6e8';

const BUSY_MESSAGE =
  'thread/resume: thread/resume failed: thread 01a0a241-ca10-7921-8047-fe849837e6e8 ' +
  'already has an active writer (code -32600)';
const STALE_MESSAGE = 'thread/resume failed: no rollout found';

/** codex の JSONL 出力（最小限） */
function codexOutput(text: string): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: SESSION_ID }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
}

/** collectOutput を差し替えて、呼び出し引数と回数を記録する */
class StubbedCodexRunner extends CodexRunner {
  readonly calls: string[][] = [];
  constructor(private readonly outcomes: Array<Error | string>) {
    super({ workdir: '/tmp' } as never);
  }
  protected collectOutput(args: string[]): Promise<string> {
    this.calls.push(args);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('想定より多く呼ばれた');
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome);
  }
}

function busyError(): Error {
  return new Error(BUSY_MESSAGE);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 待機を含む run() を最後まで進める */
async function runWithTimers(runner: StubbedCodexRunner): Promise<string> {
  const promise = runner.run('大阪です', { sessionId: SESSION_ID });
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await promise;
  return result.result;
}

describe('resume エラーの分類', () => {
  it('No.1 書き込み中のスレッドはbusyと判定する', () => {
    expect(classifyResumeError(new Error(BUSY_MESSAGE))).toBe('busy');
  });

  it('No.2 ロールアウトが無ければstaleと判定する', () => {
    expect(classifyResumeError(new Error(STALE_MESSAGE))).toBe('stale');
  });

  it('No.3 resumeと無関係なエラーはotherと判定する', () => {
    expect(classifyResumeError(new Error('spawn codex ENOENT'))).toBe('other');
  });
});

describe('busy のときの再試行', () => {
  it('No.4 busyなら同じセッションIDで再試行する', async () => {
    const runner = new StubbedCodexRunner([busyError(), codexOutput('大阪市は晴れのち雨。')]);

    expect(await runWithTimers(runner)).toBe('大阪市は晴れのち雨。');
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]).toContain('resume');
    expect(runner.calls[1]).toContain(SESSION_ID);
  });

  it('No.5 busyの再試行を使い切ったら新セッションへ落ちる', async () => {
    const runner = new StubbedCodexRunner([
      busyError(),
      busyError(),
      busyError(),
      busyError(),
      codexOutput('はじめまして。'),
    ]);

    expect(await runWithTimers(runner)).toBe('はじめまして。');
    expect(runner.calls).toHaveLength(5);
    expect(runner.calls[4]).not.toContain('resume');
  });

  it('No.6 staleは待たずに新セッションへ落ちる', async () => {
    const runner = new StubbedCodexRunner([
      new Error(STALE_MESSAGE),
      codexOutput('はじめまして。'),
    ]);

    expect(await runWithTimers(runner)).toBe('はじめまして。');
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]).not.toContain('resume');
  });

  it('No.7 otherは再試行しない', async () => {
    const runner = new StubbedCodexRunner([new Error('spawn codex ENOENT')]);

    // タイマーを進める前に reject のハンドラを付ける（未処理の rejection にしない）
    const assertion = expect(runner.run('大阪です', { sessionId: SESSION_ID })).rejects.toThrow(
      'spawn codex ENOENT'
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(runner.calls).toHaveLength(1);
  });

  it('No.8 busy後にotherへ変わったら新セッションへ落とさず返す', async () => {
    const runner = new StubbedCodexRunner([busyError(), new Error('spawn codex ENOENT')]);

    const assertion = expect(
      runner.run('大阪です', { sessionId: SESSION_ID })
    ).rejects.toThrow('spawn codex ENOENT');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]).toContain('resume');
  });

  it('No.9 busyの待機中にcancelしたら再起動しない', async () => {
    const runner = new StubbedCodexRunner([busyError(), codexOutput('再起動してはいけない')]);
    const assertion = expect(
      runner.run('大阪です', { sessionId: SESSION_ID, channelId: 'line:user' })
    ).rejects.toThrow('request cancelled');

    await vi.advanceTimersByTimeAsync(0);
    expect(runner.hasRunner('line:user')).toBe(true);
    expect(runner.cancel('line:user')).toBe(true);
    await assertion;
    expect(runner.calls).toHaveLength(1);
    expect(runner.hasRunner('line:user')).toBe(false);
  });
});
