import { describe, it, expect, vi } from 'vitest';
import { RevisionCache } from '../src/revision-cache.js';
import { sharedReadJson } from '../web-ui/src/api.js';

describe('bounded list index', () => {
  it('reuses a revision, invalidates immediately, and expires missed notifications', () => {
    let now = 100;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const build = vi.fn(() => ({ sequence: build.mock.calls.length }));
      const cache = new RevisionCache(1000);
      expect(cache.get(build)).toBe(cache.get(build));
      expect(build).toHaveBeenCalledTimes(1);
      cache.invalidate();
      cache.get(build);
      expect(build).toHaveBeenCalledTimes(2);
      now += 1001;
      cache.get(build);
      expect(build).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('concurrent detail reads', () => {
  it('shares network work but gives each pane its own result and does not cache forever', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"messages":["a"]}'));
    try {
      const [first, second] = await Promise.all([
        sharedReadJson<{ messages: string[] }>('/fixture'),
        sharedReadJson<{ messages: string[] }>('/fixture'),
      ]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      first.messages.push('local');
      expect(second.messages).toEqual(['a']);
      fetcher.mockResolvedValueOnce(new Response('{"messages":["b"]}'));
      expect(await sharedReadJson('/fixture')).toEqual({ messages: ['b'] });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      fetcher.mockRestore();
    }
  });
});
