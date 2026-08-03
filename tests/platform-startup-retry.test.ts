import { describe, expect, it, vi } from 'vitest';
import { isTransientNetworkError } from '../src/errors.js';
import { startPlatformWithRetry } from '../src/platform-startup-retry.js';

describe('platform startup retry', () => {
  it.each(['Discord', 'Slack'])(
    'retries a transient DNS failure for %s in the same process',
    async (platform) => {
      const start = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(
          Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })
        )
        .mockResolvedValueOnce();
      const sleep = vi.fn(async () => {});
      const log = vi.fn();

      await startPlatformWithRetry(platform, start, {
        initialDelayMs: 1_000,
        maxDelayMs: 60_000,
        random: () => 1,
        sleep,
        log,
      });

      expect(start).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(1_000);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`${platform} connection unavailable`));
    }
  );

  it('caps exponential backoff and suppresses repetitive warning logs', async () => {
    const start = vi.fn<() => Promise<void>>();
    for (let attempt = 0; attempt < 11; attempt++) {
      start.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }
    start.mockResolvedValueOnce();
    const sleep = vi.fn(async () => {});
    const log = vi.fn();

    await startPlatformWithRetry('Slack', start, {
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
      random: () => 1,
      sleep,
      log,
    });

    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000,
    ]);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent authentication failures', async () => {
    const start = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('401 invalid token'));

    await expect(
      startPlatformWithRetry('Discord', start, { sleep: async () => {}, log: () => {} })
    ).rejects.toThrow('401 invalid token');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('lets another platform become ready while one platform is waiting to retry', async () => {
    let releaseRetry!: () => void;
    const retryWait = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const discordStart = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('DNS unavailable'), { code: 'EAI_AGAIN' }))
      .mockResolvedValueOnce();
    const slackStart = vi.fn<() => Promise<void>>().mockResolvedValue();

    const discordTask = startPlatformWithRetry('Discord', discordStart, {
      sleep: () => retryWait,
      log: () => {},
    });
    const slackTask = startPlatformWithRetry('Slack', slackStart);

    await slackTask;
    expect(slackStart).toHaveBeenCalledTimes(1);
    expect(discordStart).toHaveBeenCalledTimes(1);

    releaseRetry();
    await discordTask;
    expect(discordStart).toHaveBeenCalledTimes(2);
  });

  it('detects transient network codes wrapped by SDK error causes', () => {
    const wrapped = new Error('Slack request failed', {
      cause: Object.assign(new Error('DNS lookup failed'), { code: 'EAI_AGAIN' }),
    });

    expect(isTransientNetworkError(wrapped)).toBe(true);
    expect(isTransientNetworkError(new Error('invalid_auth'))).toBe(false);
  });

  it('detects the original network error attached by the Slack Web API client', () => {
    const slackError = Object.assign(new Error('A request error occurred'), {
      code: 'slack_webapi_request_error',
      original: Object.assign(new Error('DNS lookup failed'), { code: 'EAI_AGAIN' }),
    });

    expect(isTransientNetworkError(slackError)).toBe(true);
  });
});
