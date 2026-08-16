import { describe, it, expect, vi } from 'vitest';
import { runShutdownCleanup } from '../src/shutdown.js';

describe('runShutdownCleanup', () => {
  it('exits after successful cleanup', async () => {
    const exit = vi.fn();
    const stopScheduler = vi.fn();
    const finalizeActiveStreams = vi.fn().mockResolvedValue(undefined);
    const stopExtensions = vi.fn().mockResolvedValue(undefined);
    const releaseDataDirLock = vi.fn().mockResolvedValue(undefined);

    await runShutdownCleanup({
      stopScheduler,
      finalizeActiveStreams,
      stopExtensions,
      releaseDataDirLock,
      exit,
      log: vi.fn(),
      warn: vi.fn(),
    });

    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(finalizeActiveStreams).toHaveBeenCalledTimes(1);
    expect(stopExtensions).toHaveBeenCalledTimes(1);
    expect(releaseDataDirLock).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('forces exit when cleanup hangs', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const warn = vi.fn();

    const promise = runShutdownCleanup({
      stopScheduler: vi.fn(),
      finalizeActiveStreams: () => new Promise<void>(() => {}),
      exit,
      log: vi.fn(),
      warn,
      hardTimeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(60);

    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[xangi] Shutdown cleanup timed out after 50ms; forcing exit'
    );

    await expect(Promise.race([promise, Promise.resolve('pending')])).resolves.toBe('pending');
    vi.useRealTimers();
  });
});
