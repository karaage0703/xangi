import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  clearRecoveredReadError,
  getJsonWithTimeout,
  request,
} from '../web-ui/src/api.js';

const originalFetch = globalThis.fetch;

describe('Web API transient retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('retries a transient GET network failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const pending = request('/api/sessions');
    await vi.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry mutations after a network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(request('/api/sessions', { method: 'POST' })).rejects.toThrow('Load failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry HTTP responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(request('/api/sessions')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears a recovered read error without hiding a newer action error', () => {
    expect(clearRecoveredReadError('Load failed', 'Load failed')).toBe('');
    expect(clearRecoveredReadError('Upload failed', 'Load failed')).toBe('Upload failed');
  });

  it('aborts a JSON request with an actionable timeout message', async () => {
    globalThis.fetch = vi.fn((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;

    const pending = getJsonWithTimeout('/api/runtime-settings/channels', 25, '読み込み失敗');
    const rejection = expect(pending).rejects.toThrow('読み込み失敗');
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });
});
