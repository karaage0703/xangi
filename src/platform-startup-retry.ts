import { isTransientNetworkError } from './errors.js';

export interface PlatformStartupRetryOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export async function startPlatformWithRetry(
  platform: string,
  start: () => Promise<unknown>,
  options: PlatformStartupRetryOptions = {}
): Promise<void> {
  const initialDelayMs = Math.max(1, options.initialDelayMs ?? 1_000);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 60_000);
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? console.warn;
  let failures = 0;

  for (;;) {
    try {
      await start();
      if (failures > 0) {
        console.info(`[xangi] ${platform} connection restored after ${failures} failed attempt(s)`);
      }
      return;
    } catch (error) {
      if (!isTransientNetworkError(error)) throw error;

      failures += 1;
      const exponent = Math.min(failures - 1, 16);
      const capped = Math.min(maxDelayMs, initialDelayMs * 2 ** exponent);
      const jitter = 0.75 + Math.max(0, Math.min(1, random())) * 0.25;
      const delayMs = Math.round(capped * jitter);
      if (failures === 1 || failures % 10 === 0) {
        log(
          `[xangi] ${platform} connection unavailable (attempt ${failures}); ` +
            `retrying in ${Math.ceil(delayMs / 1000)}s`
        );
      }
      await sleep(delayMs);
    }
  }
}
