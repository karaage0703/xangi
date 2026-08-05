import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, request } from '../web-ui/src/api.js';

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
});
