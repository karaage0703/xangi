import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimeoutController } from '../src/timeout-controller.js';

describe('TimeoutController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() emits timeout-started with timeoutAt/maxTimeoutAt', () => {
    const c = new TimeoutController({ baseTimeoutMs: 1000, maxTimeoutMs: 10_000 });
    const events: unknown[] = [];
    c.on('timeout-started', (p) => events.push(p));
    const onTimeout = vi.fn();
    c.start('ch1', onTimeout);

    expect(events).toHaveLength(1);
    const p = events[0] as { channelId: string; timeoutAt: number; maxTimeoutAt: number };
    expect(p.channelId).toBe('ch1');
    expect(p.timeoutAt).toBeGreaterThan(Date.now());
    expect(p.maxTimeoutAt).toBeGreaterThanOrEqual(p.timeoutAt);
  });

  it('getState() returns active=true after start, active=false after clear', () => {
    const c = new TimeoutController({ baseTimeoutMs: 1000 });
    expect(c.getState('ch1').active).toBe(false);
    c.start('ch1', vi.fn());
    expect(c.getState('ch1').active).toBe(true);
    c.clear('ch1', 'completed');
    expect(c.getState('ch1').active).toBe(false);
  });

  it('clear() emits timeout-cleared with reason', () => {
    const c = new TimeoutController({ baseTimeoutMs: 1000 });
    const cleared: unknown[] = [];
    c.on('timeout-cleared', (p) => cleared.push(p));
    c.start('ch1', vi.fn());
    c.clear('ch1', 'completed');
    expect(cleared).toHaveLength(1);
    expect((cleared[0] as { reason: string }).reason).toBe('completed');
  });

  it('clear() on unknown channel is a no-op (no emit)', () => {
    const c = new TimeoutController();
    const cleared: unknown[] = [];
    c.on('timeout-cleared', (p) => cleared.push(p));
    c.clear('nope', 'completed');
    expect(cleared).toHaveLength(0);
  });

  it('timer fires onTimeout then emits timeout-cleared with reason=timeout', () => {
    const c = new TimeoutController({ baseTimeoutMs: 500 });
    const onTimeout = vi.fn();
    const cleared: unknown[] = [];
    c.on('timeout-cleared', (p) => cleared.push(p));
    c.start('ch1', onTimeout);

    vi.advanceTimersByTime(499);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(cleared).toHaveLength(1);
    expect((cleared[0] as { reason: string }).reason).toBe('timeout');
    expect(c.getState('ch1').active).toBe(false);
  });

  it('extend() within max extends timeoutAt and emits timeout-extended', () => {
    const c = new TimeoutController({ baseTimeoutMs: 1000, maxTimeoutMs: 10_000 });
    const extended: unknown[] = [];
    c.on('timeout-extended', (p) => extended.push(p));
    c.start('ch1', vi.fn());

    const result = c.extend('ch1', 2000);
    expect(result.ok).toBe(true);
    expect(result.timeoutMs).toBe(3000);
    expect(extended).toHaveLength(1);
  });

  it('extend() over maxTimeoutAt rejects with max_timeout_exceeded', () => {
    const c = new TimeoutController({ baseTimeoutMs: 1000, maxTimeoutMs: 2000 });
    c.start('ch1', vi.fn());
    const result = c.extend('ch1', 9999);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('max_timeout_exceeded');
    expect(result.maxTimeoutAt).toBeGreaterThan(0);
  });

  it('extend() on inactive channel rejects with no_active_request', () => {
    const c = new TimeoutController();
    const result = c.extend('nope', 1000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_active_request');
  });

  it('extend() with non-positive additionalMs rejects with no_active_request', () => {
    const c = new TimeoutController({ baseTimeoutMs: 1000, maxTimeoutMs: 10_000 });
    c.start('ch1', vi.fn());
    expect(c.extend('ch1', 0).ok).toBe(false);
    expect(c.extend('ch1', -1).ok).toBe(false);
    expect(c.extend('ch1', NaN).ok).toBe(false);
  });

  it('extend() with additionalMs omitted adds the remaining time (doubles the remaining)', () => {
    const c = new TimeoutController({ baseTimeoutMs: 1000, maxTimeoutMs: 10_000 });
    c.start('ch1', vi.fn());
    // 400ms 経過 → 残り 600ms。省略呼び出しでさらに +600ms 加算 → 残り 1200ms (= 2x)
    vi.advanceTimersByTime(400);
    const result = c.extend('ch1');
    expect(result.ok).toBe(true);
    // remainingMs は呼び出し時点からの残り時間 (元の残り 600ms * 2 = 1200ms)
    expect(result.remainingMs).toBe(1200);
    expect(result.timeoutMs).toBe(1600); // 元の 1000ms + 加算した 600ms
  });

  it('extend() rescheduled timer fires after the new deadline, not the original one', () => {
    const c = new TimeoutController({ baseTimeoutMs: 1000, maxTimeoutMs: 10_000 });
    const onTimeout = vi.fn();
    c.start('ch1', onTimeout);

    vi.advanceTimersByTime(500);
    c.extend('ch1', 2000);
    // 元の deadline (1000ms) を超えても fire しない
    vi.advanceTimersByTime(600);
    expect(onTimeout).not.toHaveBeenCalled();
    // 新 deadline (1000+2000=3000ms) で fire
    vi.advanceTimersByTime(2000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('start() on already-active channel silently replaces (no double timeout-cleared)', () => {
    const c = new TimeoutController({ baseTimeoutMs: 1000 });
    const cleared: unknown[] = [];
    c.on('timeout-cleared', (p) => cleared.push(p));
    c.start('ch1', vi.fn());
    c.start('ch1', vi.fn());
    expect(cleared).toHaveLength(0);
    expect(c.getState('ch1').active).toBe(true);
  });

  it('clearAll() clears all channels', () => {
    const c = new TimeoutController();
    c.start('a', vi.fn());
    c.start('b', vi.fn());
    expect(c.getState('a').active).toBe(true);
    expect(c.getState('b').active).toBe(true);
    c.clearAll('shutdown');
    expect(c.getState('a').active).toBe(false);
    expect(c.getState('b').active).toBe(false);
  });

  it('multiple channels are independent', () => {
    const c = new TimeoutController({ baseTimeoutMs: 1000 });
    const aTimeout = vi.fn();
    const bTimeout = vi.fn();
    c.start('a', aTimeout);
    c.start('b', bTimeout);
    c.clear('a', 'completed');
    vi.advanceTimersByTime(1100);
    expect(aTimeout).not.toHaveBeenCalled();
    expect(bTimeout).toHaveBeenCalledTimes(1);
  });
});
