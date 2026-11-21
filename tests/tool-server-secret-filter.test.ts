import { describe, expect, it, vi, afterEach } from 'vitest';
import { startToolServer, stopToolServer } from '../src/tool-server.js';
import { SECRET_AI_WARNING } from '../src/secret-filter.js';

afterEach(() => {
  stopToolServer();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('tool HTTP secret filter', () => {
  it('blocks a secret-bearing Discord operation before fetch and keeps logs/errors clean', async () => {
    const token = 'http-DUMMY-secret-"\\\n🔑';
    vi.stubEnv('DISCORD_TOKEN', token);
    vi.stubEnv('XANGI_TOOL_SERVER_PORT', '0');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realFetch = globalThis.fetch;
    const discordFetch = vi.fn();
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      url.startsWith('https://discord.com/') ? discordFetch(url, init) : realFetch(url, init)
    );
    await startToolServer();
    const url = process.env.XANGI_TOOL_SERVER!;
    const response = await fetch(`${url}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'discord_send',
        flags: { channel: 'channel', message: token },
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).not.toContain(token);
    expect(body.error).toContain(SECRET_AI_WARNING);
    expect(discordFetch).not.toHaveBeenCalled();
    for (const representation of [
      token,
      JSON.stringify(token).slice(1, -1),
      encodeURIComponent(token),
    ]) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(representation);
      expect(JSON.stringify(error.mock.calls)).not.toContain(representation);
    }
  });

  it('redacts a tool result before returning it to the caller', async () => {
    const token = 'http-DUMMY-secret';
    vi.stubEnv('DISCORD_TOKEN', token);
    vi.stubEnv('XANGI_TOOL_SERVER_PORT', '0');
    await startToolServer({ webStatusCommand: async () => `status ${token}` });
    const response = await fetch(`${process.env.XANGI_TOOL_SERVER}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'web_status', flags: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      result: `status [REDACTED_SECRET]\n\n${SECRET_AI_WARNING}`,
    });
  });

  it('returns unchanged results without an instruction when disabled', async () => {
    const token = 'http-DUMMY-secret';
    vi.stubEnv('DISCORD_TOKEN', token);
    vi.stubEnv('XANGI_SECRET_FILTER_ENABLED', 'false');
    await startToolServer({ webStatusCommand: async () => token });
    const response = await fetch(`${process.env.XANGI_TOOL_SERVER}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'web_status', flags: {} }),
    });
    expect(await response.json()).toEqual({ ok: true, result: token });
  });
});
