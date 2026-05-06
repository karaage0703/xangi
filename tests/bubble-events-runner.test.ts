/**
 * runWithBubbleEvents の events.* 配信契約をロックするテスト。
 *
 * 4箇所 (web-chat / Discord / Slack / auto-talk) すべてが
 * このラッパー経由で events.* を投げる構造になっているため、ここで仕様を固定する
 * ことで「呼び出し元によって events.* が抜ける」回帰を防ぐ。
 *
 * pull 型 SSE 配信に切り替えたので、テストは external collector ではなく
 * subscribeEvents() でイベントを集める。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentRunner, RunOptions, StreamCallbacks, RunResult } from '../src/agent-runner.js';

interface ReceivedEvent {
  type: string;
  thread_id: string;
  turn_id: string;
  thread_label?: string;
  platform?: string;
  ts: number;
  [key: string]: unknown;
}

class FakeRunner implements AgentRunner {
  constructor(
    private behavior: (
      prompt: string,
      callbacks: StreamCallbacks,
      options?: RunOptions
    ) => Promise<RunResult>
  ) {}
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    return this.runStream(prompt, {}, options);
  }
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    return this.behavior(prompt, callbacks, options);
  }
}

describe('runWithBubbleEvents', () => {
  let collected: ReceivedEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    vi.resetModules();
    collected = [];
    const ee = await import('../src/events-emitter.js');
    unsubscribe = ee.subscribeEvents((ev) => {
      collected.push(ev as unknown as ReceivedEvent);
    });
  });

  afterEach(() => {
    unsubscribe?.();
    delete process.env.XANGI_EVENTS_ENABLED;
  });

  it('publishes turn.started → message.delta×N → turn.complete in normal flow', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const runner = new FakeRunner(async (_p, cb) => {
      cb.onText?.('a', 'a');
      cb.onText?.('b', 'ab');
      const result = { result: 'ab', sessionId: 'sess-1' };
      cb.onComplete?.(result);
      return result;
    });
    const r = await runWithBubbleEvents(
      runner,
      'hi',
      { threadId: 'web:s1', turnId: 'u1', platform: 'web', userText: 'hi' },
      {}
    );
    expect(r.result).toBe('ab');
    expect(collected.map((e) => e.type)).toEqual([
      'turn.started',
      'message.delta',
      'message.delta',
      'turn.complete',
    ]);
    expect(collected[0].user_text).toBe('hi');
    expect(collected[3].text).toBe('ab');
  });

  it('passes through caller callbacks (onText / onToolUse / onComplete / onError)', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const seen = { texts: [] as string[], tools: [] as string[], complete: 0, error: 0 };
    const runner = new FakeRunner(async (_p, cb) => {
      cb.onText?.('x', 'x');
      cb.onToolUse?.('Bash', { cmd: 'ls' });
      const result = { result: 'x', sessionId: 's' };
      cb.onComplete?.(result);
      return result;
    });
    await runWithBubbleEvents(
      runner,
      'hi',
      { threadId: 't', turnId: 'u', platform: 'web' },
      {
        onText: (_c, full) => seen.texts.push(full),
        onToolUse: (name) => seen.tools.push(name),
        onComplete: () => {
          seen.complete++;
        },
        onError: () => {
          seen.error++;
        },
      }
    );
    expect(seen.texts).toEqual(['x']);
    expect(seen.tools).toEqual(['Bash']);
    expect(seen.complete).toBe(1);
    expect(seen.error).toBe(0);
  });

  it('publishes turn.aborted (not agent.error) when the runner reports cancel via onError', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const runner = new FakeRunner(async (_p, cb) => {
      const err = new Error('Request cancelled by user');
      cb.onError?.(err);
      throw err;
    });
    await expect(
      runWithBubbleEvents(runner, 'hi', { threadId: 't', turnId: 'u', platform: 'web' }, {})
    ).rejects.toThrow('Request cancelled by user');
    const types = collected.map((e) => e.type);
    expect(types).toContain('turn.aborted');
    expect(types).not.toContain('agent.error');
  });

  it('publishes agent.error on non-cancel runner failure', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const runner = new FakeRunner(async () => {
      throw new Error('boom');
    });
    await expect(
      runWithBubbleEvents(runner, 'hi', { threadId: 't', turnId: 'u', platform: 'web' }, {})
    ).rejects.toThrow('boom');
    const errEv = collected.find((e) => e.type === 'agent.error');
    expect(errEv?.message).toBe('boom');
  });

  it('does not double-publish error when runner throws after onError', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const runner = new FakeRunner(async (_p, cb) => {
      const err = new Error('boom');
      cb.onError?.(err);
      throw err;
    });
    await expect(
      runWithBubbleEvents(runner, 'hi', { threadId: 't', turnId: 'u', platform: 'web' }, {})
    ).rejects.toThrow('boom');
    expect(collected.filter((e) => e.type === 'agent.error')).toHaveLength(1);
  });
});
