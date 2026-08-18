import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionAgentRunner } from '../src/extension-agent-runner.js';
import { resolveExtensionAgentBackend } from '../src/extensions.js';
import { installExtensionBackendFixture } from './helpers/extension-backend.js';

const originalExtensionsFile = process.env.XANGI_EXTENSIONS_FILE;
const originalPublicWebUrl = process.env.XANGI_PUBLIC_WEB_URL;
const originalWorkspaceSearchWebUrl = process.env.WORKSPACE_SEARCH_WEB_URL;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalExtensionsFile === undefined) delete process.env.XANGI_EXTENSIONS_FILE;
  else process.env.XANGI_EXTENSIONS_FILE = originalExtensionsFile;
  if (originalPublicWebUrl === undefined) delete process.env.XANGI_PUBLIC_WEB_URL;
  else process.env.XANGI_PUBLIC_WEB_URL = originalPublicWebUrl;
  if (originalWorkspaceSearchWebUrl === undefined) delete process.env.WORKSPACE_SEARCH_WEB_URL;
  else process.env.WORKSPACE_SEARCH_WEB_URL = originalWorkspaceSearchWebUrl;
});

describe('ExtensionAgentRunner', () => {
  it('posts the generic agent contract and returns the extension response', async () => {
    await installExtensionBackendFixture('example-backend', 'Example backend');
    const backend = resolveExtensionAgentBackend('example-backend');
    expect(backend).toBeDefined();
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        schemaVersion: 1,
        prompt: 'expanded prompt',
        userText: 'original text',
        platform: 'discord',
      });
      return new Response(JSON.stringify({ schemaVersion: 1, result: 'extension result' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const runner = new ExtensionAgentRunner({ backend: backend!, fetchFn });

    await expect(
      runner.run('expanded prompt', {
        userText: 'original text',
        platform: 'discord',
        channelId: 'channel-1',
      })
    ).resolves.toEqual({
      result: 'extension result',
      sessionId: 'example-backend:channel-1',
      sessionMode: 'stateless',
    });
    expect(fetchFn.mock.calls[0][0].toString()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agent$/);
  });

  it('rejects malformed extension responses', async () => {
    await installExtensionBackendFixture('example-backend', 'Example backend');
    const backend = resolveExtensionAgentBackend('example-backend')!;
    const runner = new ExtensionAgentRunner({
      backend,
      fetchFn: vi.fn(async () => new Response('{}', { status: 200 })),
    });
    await expect(runner.run('hello')).rejects.toThrow(/invalid agent response/);
  });

  it('does not fall back to the removed workspace-search URL setting', async () => {
    delete process.env.XANGI_PUBLIC_WEB_URL;
    process.env.WORKSPACE_SEARCH_WEB_URL = 'https://legacy.example';
    await installExtensionBackendFixture('example-backend', 'Example backend');
    const backend = resolveExtensionAgentBackend('example-backend')!;
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('workspaceUrl');
      return new Response(JSON.stringify({ schemaVersion: 1, result: 'ok' }), {
        status: 200,
      });
    });

    const runner = new ExtensionAgentRunner({ backend, fetchFn });
    await runner.run('hello');
  });
});
