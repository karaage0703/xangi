import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { executeExtensionRequest } from '../src/extension-request.js';

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not start');
  return `http://127.0.0.1:${address.port}`;
}

describe('extension_request', () => {
  it('injects authorization and URL-encodes query JSON', async () => {
    const baseUrl = await listen((request, response) => {
      expect(request.headers.authorization).toBe('Bearer secret');
      expect(request.url).toBe('/facts/similar?q=%E7%8C%AB+%26+AI&k=3');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });

    await expect(
      executeExtensionRequest(
        {
          id: 'xangi-search',
          capability: 'workspace.search',
          path: '/facts/similar',
          'query-json': JSON.stringify({ q: '猫 & AI', k: 3 }),
        },
        () => ({ baseUrl, authorization: 'Bearer secret' })
      )
    ).resolves.toBe('{"ok":true}');
  });

  it('sends JSON bodies and keeps the token out of the result', async () => {
    const baseUrl = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      expect(request.method).toBe('POST');
      expect(request.headers.authorization).toBe('Bearer secret');
      expect(Buffer.concat(chunks).toString()).toBe('{"subject":"cat"}');
      response.writeHead(200).end('created');
    });

    await expect(
      executeExtensionRequest(
        {
          id: 'xangi-search',
          capability: 'workspace.search',
          path: '/facts',
          method: 'POST',
          'body-json': '{"subject":"cat"}',
        },
        () => ({ baseUrl, authorization: 'Bearer secret' })
      )
    ).resolves.toBe('created');
  });

  it('rejects external URLs and unavailable capabilities', async () => {
    await expect(
      executeExtensionRequest(
        { id: 'xangi-search', capability: 'workspace.search', path: '//example.com/data' },
        () => ({ baseUrl: 'http://127.0.0.1:7891', authorization: 'Bearer secret' })
      )
    ).rejects.toThrow(/absolute service --path/);
    await expect(
      executeExtensionRequest(
        { id: 'missing', capability: 'workspace.search', path: '/search' },
        () => undefined
      )
    ).rejects.toThrow(/not running or unavailable/);
  });
});
