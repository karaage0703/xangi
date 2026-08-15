import { describe, expect, it, vi } from 'vitest';
import {
  collectWebStatus,
  resolveWebChatHost,
  resolveWebChatPort,
  webStatusCmd,
} from '../src/web-status.js';

describe('Web UI status command', () => {
  it('uses the default port for an unset or invalid value and accepts quoted values', () => {
    expect(resolveWebChatPort(undefined, {} as NodeJS.ProcessEnv)).toEqual({
      port: 18888,
      source: 'default',
      defaultApplied: true,
    });
    expect(resolveWebChatPort(undefined, { WEB_CHAT_PORT: '"19991"' } as NodeJS.ProcessEnv)).toEqual(
      {
        port: 19991,
        source: 'environment',
        defaultApplied: false,
      }
    );
    for (const value of ['invalid', '18888x', '0', '65536']) {
      expect(resolveWebChatPort(undefined, { WEB_CHAT_PORT: value } as NodeJS.ProcessEnv).port).toBe(
        18888
      );
    }
  });

  it('normalizes quoted bind hosts and preserves loopback, wildcard, and specific hosts', () => {
    expect(resolveWebChatHost(undefined, {} as NodeJS.ProcessEnv)).toBe('0.0.0.0');
    expect(resolveWebChatHost(undefined, { WEB_CHAT_HOST: "'127.0.0.1'" } as NodeJS.ProcessEnv)).toBe(
      '127.0.0.1'
    );
    expect(resolveWebChatHost(undefined, { WEB_CHAT_HOST: '0.0.0.0' } as NodeJS.ProcessEnv)).toBe(
      '0.0.0.0'
    );
    expect(resolveWebChatHost(undefined, { WEB_CHAT_HOST: '192.0.2.10' } as NodeJS.ProcessEnv)).toBe(
      '192.0.2.10'
    );
  });

  it('returns multiple access URL candidates and successful root/workspace checks', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const resolveUrls = vi.fn(async () => [
      'http://localhost:18888',
      'http://device.example.test:18888',
      'http://192.0.2.20:18888',
    ]);

    const status = await collectWebStatus({
      env: { WEB_CHAT_ENABLED: 'true' } as NodeJS.ProcessEnv,
      fetchImpl,
      resolveUrls,
    });

    expect(status).toMatchObject({
      enabled: true,
      port: 18888,
      portSource: 'default',
      defaultPortApplied: true,
      bindHost: '0.0.0.0',
      bindHostKind: 'wildcard',
      accessUrls: [
        'http://localhost:18888',
        'http://device.example.test:18888',
        'http://192.0.2.20:18888',
      ],
      workspaceUrls: [
        'http://localhost:18888/workspace',
        'http://device.example.test:18888/workspace',
        'http://192.0.2.20:18888/workspace',
      ],
      http: {
        root: { url: 'http://127.0.0.1:18888/', ok: true, status: 200 },
        workspace: { url: 'http://127.0.0.1:18888/workspace', ok: true, status: 200 },
      },
    });
    expect(resolveUrls).toHaveBeenCalledWith(18888, '0.0.0.0');
  });

  it('reports HTTP failures without losing the remaining status', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockRejectedValueOnce(new Error('connection refused'));

    const status = await collectWebStatus({
      env: {
        WEB_CHAT_ENABLED: 'true',
        WEB_CHAT_PORT: "'19991'",
        WEB_CHAT_HOST: '127.0.0.1',
      } as NodeJS.ProcessEnv,
      fetchImpl,
      resolveUrls: async () => ['http://localhost:19991'],
    });

    expect(status.bindHostKind).toBe('loopback');
    expect(status.http.root).toEqual({
      url: 'http://127.0.0.1:19991/',
      ok: false,
      status: 503,
    });
    expect(status.http.workspace).toMatchObject({
      url: 'http://127.0.0.1:19991/workspace',
      ok: false,
      status: null,
      error: 'connection refused',
    });
  });

  it('probes a specific bind host instead of localhost', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const status = await collectWebStatus({
      env: {
        WEB_CHAT_ENABLED: 'true',
        WEB_CHAT_PORT: '18889',
        WEB_CHAT_HOST: '192.0.2.10',
      } as NodeJS.ProcessEnv,
      fetchImpl,
      resolveUrls: async () => ['http://192.0.2.10:18889'],
    });

    expect(status.bindHostKind).toBe('specific');
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'http://192.0.2.10:18889/',
      'http://192.0.2.10:18889/workspace',
    ]);
  });

  it('does not probe or advertise URLs when Web UI is disabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const resolveUrls = vi.fn(async () => ['http://localhost:18888']);

    const status = await collectWebStatus({
      env: { WEB_CHAT_ENABLED: 'false' } as NodeJS.ProcessEnv,
      fetchImpl,
      resolveUrls,
    });

    expect(status).toMatchObject({
      enabled: false,
      accessUrls: [],
      chatUrls: [],
      workspaceUrls: [],
      http: { root: null, workspace: null },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveUrls).not.toHaveBeenCalled();
  });

  it('emits structured JSON', async () => {
    const output = await webStatusCmd({
      env: { WEB_CHAT_ENABLED: 'false' } as NodeJS.ProcessEnv,
    });
    expect(JSON.parse(output)).toMatchObject({ enabled: false, port: 18888 });
  });
});
