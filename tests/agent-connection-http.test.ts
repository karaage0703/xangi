import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  proxyConnectionSession,
  receiveConnectionApi,
  removeConnectionApi,
  connectionApiHeader,
  mapConnectionJson,
} from '../src/agent-connection-http.js';
import {
  connectionSessionId,
  connectionSessionRef,
  isSecretConversationId,
} from '../src/connection-session-id.js';

const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
afterEach(async () => {
  removeConnectionApi('test');
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});
const key = 'a'.repeat(64);
const id = connectionSessionId('test', 'session-a');

it('routes history and mutations to the owning Bot, retaining message IDs and text', async () => {
  const paths: string[] = [];
  const port = await listen(
    createServer(async (req, res) => {
      expect(req.headers[connectionApiHeader]).toBe(key);
      expect(req.headers.cookie).toBeUndefined();
      paths.push(req.url!);
      let raw = '';
      for await (const part of req) raw += part;
      if (raw) expect(JSON.parse(raw)).toMatchObject({ appSessionId: 'session-a', message: id });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'session-a',
          platform: 'discord',
          messages: [{ id: 'message-a', content: id }],
          appSessionId: 'session-a',
        })
      );
    })
  );
  receiveConnectionApi('test', { type: 'agent-connection-api-ready', port, key });
  const root = await listen(
    createServer(async (req, res) => {
      if (!(await proxyConnectionSession(req, res))) {
        res.writeHead(404);
        res.end();
      }
    })
  );
  const result = await fetch(
    `http://127.0.0.1:${root}/api/sessions/${encodeURIComponent(id)}?limit=50`
  ).then((r) => r.json());
  expect(result).toMatchObject({
    id,
    appSessionId: id,
    messages: [{ id: 'message-a', content: id }],
  });
  expect(paths).toEqual(['/api/sessions/session-a?limit=50']);
  const response = await fetch(
    `http://127.0.0.1:${root}/api/sessions/${encodeURIComponent(id)}/discord-continue`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'parent-only' },
      body: JSON.stringify({ appSessionId: id, message: id }),
    }
  );
  expect(response.status).toBe(200);
  expect(paths[1]).toBe('/api/sessions/session-a/discord-continue');
  const wrong = await fetch(
    `http://127.0.0.1:${root}/api/sessions/${encodeURIComponent(id)}/discord-continue`,
    { method: 'POST', body: JSON.stringify({ appSessionId: connectionSessionId('other', 's') }) }
  );
  expect(wrong.status).toBe(400);
  expect(paths).toHaveLength(2);
  removeConnectionApi('test');
  expect(
    (await fetch(`http://127.0.0.1:${root}/api/sessions/${encodeURIComponent(id)}`)).status
  ).toBe(503);
});

it('rewrites fragmented SSE identities without damaging Unicode or response text', async () => {
  const port = await listen(
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from(
        `event: session\ndata: ${JSON.stringify({ appSessionId: 'new-session', text: 'ボルト日本語' })}\n\n`
      );
      for (let i = 0; i < bytes.length; i += 2) res.write(bytes.subarray(i, i + 2));
      res.end();
    })
  );
  receiveConnectionApi('test', { type: 'agent-connection-api-ready', port, key });
  const root = await listen(
    createServer(async (req, res) => {
      await proxyConnectionSession(req, res, id, { appSessionId: id, message: 'hello' });
    })
  );
  const result = await fetch(`http://127.0.0.1:${root}/api/chat`, { method: 'POST' }).then((r) =>
    r.text()
  );
  expect(result).toContain('event: session');
  expect(result).toContain(connectionSessionId('test', 'new-session'));
  expect(result).toContain('ボルト日本語');
});

it('cancels the child request when the browser disconnects', async () => {
  let closed = false;
  const port = await listen(
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"text":"started"}\n\n');
      res.on('close', () => {
        closed = true;
      });
    })
  );
  receiveConnectionApi('test', { type: 'agent-connection-api-ready', port, key });
  const root = await listen(
    createServer(async (req, res) => {
      await proxyConnectionSession(req, res);
    })
  );
  const abort = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${root}/api/sessions/${encodeURIComponent(id)}/turn-requests/r/events`,
    { signal: abort.signal }
  );
  await response.body!.getReader().read();
  abort.abort();
  await vi.waitFor(() => expect(closed).toBe(true));
});

it('validates scoped identities and preserves private-mode identification', () => {
  expect(connectionSessionRef(id)).toEqual({ connectionId: 'test', sessionId: 'session-a' });
  expect(connectionSessionRef('connection:test:..%2Fprivate')).toBeUndefined();
  expect(isSecretConversationId(connectionSessionId('test', 'secret_example'))).toBe(true);
  expect(isSecretConversationId(null)).toBe(false);
  expect(
    mapConnectionJson({ ok: true, sessionId: 'fork', sourceId: 'session-a' }, 'test', true)
  ).toEqual({ ok: true, sessionId: connectionSessionId('test', 'fork'), sourceId: id });
  expect(mapConnectionJson({ kind: 'session', sessionId: 'fork' }, 'test', true)).toEqual({
    kind: 'session',
    sessionId: connectionSessionId('test', 'fork'),
  });
  expect(
    mapConnectionJson(
      { requestId: 'request', providerSessionId: 'provider', messages: [{ id: 'message' }] },
      'test',
      true
    )
  ).toEqual({ requestId: 'request', providerSessionId: 'provider', messages: [{ id: 'message' }] });
});
