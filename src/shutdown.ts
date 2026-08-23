export interface ShutdownCleanupOptions {
  stopScheduler: () => void;
  finalizeActiveStreams: () => Promise<void>;
  stopAgentProcesses?: (() => Promise<void>) | null;
  stopExtensions?: (() => Promise<void>) | null;
  releaseDataDirLock?: (() => Promise<void>) | null;
  exit: (code: number) => void;
  log?: (message: string) => void;
  warn?: (message: string, error?: unknown) => void;
  hardTimeoutMs?: number;
}

/**
 * Run graceful shutdown cleanup, but never let cleanup block process exit.
 *
 * system_restart depends on the process actually exiting so pm2/Docker can
 * start it again. If stream finalization or lock release hangs, force exit.
 */
export async function runShutdownCleanup({
  stopScheduler,
  finalizeActiveStreams,
  stopAgentProcesses,
  stopExtensions,
  releaseDataDirLock,
  exit,
  log = console.log,
  warn = console.warn,
  hardTimeoutMs = 1500,
}: ShutdownCleanupOptions): Promise<void> {
  let didExit = false;
  const exitOnce = () => {
    if (didExit) return;
    didExit = true;
    exit(0);
  };

  const forceExitTimer = setTimeout(() => {
    warn(`[xangi] Shutdown cleanup timed out after ${hardTimeoutMs}ms; forcing exit`);
    exitOnce();
  }, hardTimeoutMs);
  forceExitTimer.unref?.();

  try {
    log('[xangi] Shutting down scheduler...');
    try {
      stopScheduler();
    } catch (err) {
      warn('[xangi] Failed to stop scheduler during shutdown:', err);
    }

    try {
      await finalizeActiveStreams();
    } catch (err) {
      warn('[xangi] Failed to finalize active streams during shutdown:', err);
    }

    if (stopAgentProcesses) {
      try {
        await stopAgentProcesses();
      } catch (err) {
        warn('[xangi] Failed to stop agent processes during shutdown:', err);
      }
    }

    if (stopExtensions) {
      try {
        await stopExtensions();
      } catch (err) {
        warn('[xangi] Failed to stop extensions during shutdown:', err);
      }
    }

    if (releaseDataDirLock) {
      try {
        await releaseDataDirLock();
      } catch (err) {
        warn('[xangi] Failed to release dataDir lock during shutdown:', err);
      }
    }
  } finally {
    clearTimeout(forceExitTimer);
    exitOnce();
  }
}
