import { describe, expect, it, vi } from 'vitest';
import { DiscordTurnCoordinator } from '../src/discord/turn-coordinator.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('DiscordTurnCoordinator', () => {
  it('queues work for the same key in FIFO order and reports busy until the tail completes', async () => {
    const coordinator = new DiscordTurnCoordinator();
    const first = deferred<void>();
    const order: string[] = [];

    const firstRun = coordinator.enqueue('channel-1', async () => {
      order.push('first:start');
      await first.promise;
      order.push('first:end');
    });
    const secondRun = coordinator.enqueue('channel-1', async () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(coordinator.isBusy('channel-1')).toBe(true);
    expect(order).toEqual(['first:start']);

    first.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(coordinator.isBusy('channel-1')).toBe(false);
  });

  it('allows different keys to run in parallel', async () => {
    const coordinator = new DiscordTurnCoordinator();
    const first = deferred<void>();
    const secondStarted = vi.fn();

    const firstRun = coordinator.enqueue('channel-1', () => first.promise);
    const secondRun = coordinator.enqueue('channel-2', async () => {
      secondStarted();
    });

    await secondRun;
    expect(secondStarted).toHaveBeenCalledOnce();
    expect(coordinator.isBusy('channel-1')).toBe(true);
    first.resolve();
    await firstRun;
  });

  it('runs the next queued task after the preceding task rejects', async () => {
    const coordinator = new DiscordTurnCoordinator();
    const first = deferred<void>();
    const nextTask = vi.fn(async () => 'completed');

    const firstRun = coordinator.enqueue('channel-1', () => first.promise);
    const secondRun = coordinator.enqueue('channel-1', nextTask);
    first.reject(new Error('failed'));

    await expect(firstRun).rejects.toThrow('failed');
    await expect(secondRun).resolves.toBe('completed');
    expect(nextTask).toHaveBeenCalledOnce();
    expect(coordinator.isBusy('channel-1')).toBe(false);
  });

  it('rejects a normal turn while the key has active or queued work', async () => {
    const coordinator = new DiscordTurnCoordinator();
    const first = deferred<void>();
    const normalTask = vi.fn(async () => 'normal');

    const queuedRun = coordinator.enqueue('channel-1', () => first.promise);
    const result = await coordinator.tryRun('channel-1', normalTask);

    expect(result).toEqual({ accepted: false });
    expect(normalTask).not.toHaveBeenCalled();
    first.resolve();
    await queuedRun;
  });

  it('accepts a normal turn on an idle key and returns its result', async () => {
    const coordinator = new DiscordTurnCoordinator();

    await expect(coordinator.tryRun('channel-1', async () => 'done')).resolves.toEqual({
      accepted: true,
      result: 'done',
    });
    expect(coordinator.isBusy('channel-1')).toBe(false);
  });

  it('keeps a normal turn busy until completion and starts queued work afterward', async () => {
    const coordinator = new DiscordTurnCoordinator();
    const normal = deferred<string>();
    const triggerTask = vi.fn(async () => 'trigger');

    const normalRun = coordinator.tryRun('channel-1', () => normal.promise);
    const triggerRun = coordinator.enqueue('channel-1', triggerTask);

    await Promise.resolve();
    expect(coordinator.isBusy('channel-1')).toBe(true);
    expect(triggerTask).not.toHaveBeenCalled();

    normal.resolve('normal');
    await expect(normalRun).resolves.toEqual({ accepted: true, result: 'normal' });
    await expect(triggerRun).resolves.toBe('trigger');
  });
});
