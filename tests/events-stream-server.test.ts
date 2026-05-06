/**
 * pull 型 events 配信 (`GET /api/events/stream`) の SSE ハンドラのテスト。
 *
 * - 接続直後に `event: ready` が流れること
 * - 以後 events.turnStarted などを呼ぶと SSE で `data: ...` が届くこと
 * - クライアント切断で subscriber が解除されること (subscriber count = 0)
 * - XANGI_EVENTS_ENABLED=false で 503 が返ること
 * - パス / メソッド違いは false を返してハンドラが素通しすること
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, request, type Server } from 'http';
import type { AddressInfo } from 'net';

interface SseFrame {
  event?: string;
  data?: string;
}

/** SSE のテキストバッファを `\n\n` 区切りでフレームに分解する。 */
function parseFrames(buf: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buf;
  let idx;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    if (block.startsWith(':')) continue; // コメント行 (keepalive 等)
    const frame: SseFrame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) frame.event = line.slice(7);
      else if (line.startsWith('data: ')) frame.data = line.slice(6);
    }
    frames.push(frame);
  }
  return { frames, rest };
}

interface SseClient {
  url: string;
  frames: SseFrame[];
  /** バッファに新しいフレームが入るまで待つ */
  waitForFrames(predicate: (frames: SseFrame[]) => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
  closed: Promise<void>;
}

async function connectSse(url: string): Promise<SseClient> {
  const u = new URL(url);
  return new Promise<SseClient>((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: parseInt(u.port, 10),
        path: u.pathname + u.search,
        method: 'GET',
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`unexpected status: ${res.statusCode}`));
          return;
        }
        const frames: SseFrame[] = [];
        let buf = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          const parsed = parseFrames(buf);
          buf = parsed.rest;
          frames.push(...parsed.frames);
        });
        const closed = new Promise<void>((r) => res.on('close', r));

        const waitForFrames = async (
          predicate: (frames: SseFrame[]) => boolean,
          timeoutMs = 1500
        ): Promise<void> => {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            if (predicate(frames)) return;
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new Error(
            `waitForFrames timed out (frames so far: ${JSON.stringify(frames)})`
          );
        };

        const client: SseClient = {
          url,
          frames,
          waitForFrames,
          close: () => req.destroy(),
          closed,
        };
        resolve(client);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

interface TestServer {
  url: string;
  close(): Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const { handleEventsStreamRequest } = await import('../src/events-stream-server.js');
  const server: Server = createServer((req, res) => {
    const handled = handleEventsStreamRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('events-stream-server', () => {
  let testServer: TestServer;

  beforeEach(async () => {
    vi.resetModules();
    process.env.XANGI_INSTANCE_ID = 'xangi-test';
    testServer = await startTestServer();
  });

  afterEach(async () => {
    await testServer.close();
    delete process.env.XANGI_INSTANCE_ID;
    delete process.env.XANGI_EVENTS_ENABLED;
  });

  it('emits a ready event right after connect with instance_id / host_hint', async () => {
    const client = await connectSse(`${testServer.url}/api/events/stream`);
    try {
      await client.waitForFrames((f) => f.some((x) => x.event === 'ready'));
      const ready = client.frames.find((f) => f.event === 'ready');
      expect(ready).toBeDefined();
      const data = JSON.parse(ready!.data!);
      expect(data.instance_id).toBe('xangi-test');
      expect(typeof data.host_hint).toBe('string');
    } finally {
      client.close();
      await client.closed;
    }
  });

  it('forwards published events as SSE data frames to connected clients', async () => {
    const client = await connectSse(`${testServer.url}/api/events/stream`);
    try {
      await client.waitForFrames((f) => f.some((x) => x.event === 'ready'));

      const { events } = await import('../src/events-emitter.js');
      events.turnStarted({
        threadId: 'web:s1',
        turnId: 'u1',
        platform: 'web',
        userText: 'hello',
      });
      events.messageDelta({
        threadId: 'web:s1',
        turnId: 'u1',
        platform: 'web',
        chunk: 'hi',
        fullText: 'hi',
      });
      events.turnComplete({
        threadId: 'web:s1',
        turnId: 'u1',
        platform: 'web',
        text: 'hi',
      });

      await client.waitForFrames(
        (f) => f.filter((x) => x.event === undefined && x.data).length >= 3
      );
      const dataFrames = client.frames
        .filter((f) => f.event === undefined && f.data)
        .map((f) => JSON.parse(f.data!));
      const types = dataFrames.map((d) => d.type);
      expect(types).toContain('turn.started');
      expect(types).toContain('message.delta');
      expect(types).toContain('turn.complete');
      const started = dataFrames.find((d) => d.type === 'turn.started');
      expect(started.instance_id).toBe('xangi-test');
      expect(started.user_text).toBe('hello');
    } finally {
      client.close();
      await client.closed;
    }
  });

  it('broadcasts events to multiple connected clients (fan-out)', async () => {
    const a = await connectSse(`${testServer.url}/api/events/stream`);
    const b = await connectSse(`${testServer.url}/api/events/stream`);
    try {
      await a.waitForFrames((f) => f.some((x) => x.event === 'ready'));
      await b.waitForFrames((f) => f.some((x) => x.event === 'ready'));

      const { events } = await import('../src/events-emitter.js');
      events.turnStarted({ threadId: 'web:s1', turnId: 'fan-out', platform: 'web' });

      await a.waitForFrames((f) => f.some((x) => x.data?.includes('fan-out')));
      await b.waitForFrames((f) => f.some((x) => x.data?.includes('fan-out')));
    } finally {
      a.close();
      b.close();
      await Promise.all([a.closed, b.closed]);
    }
  });

  it('cleans up subscriber when the client disconnects', async () => {
    const { getSubscriberCount } = await import('../src/events-emitter.js');
    expect(getSubscriberCount()).toBe(0);

    const client = await connectSse(`${testServer.url}/api/events/stream`);
    await client.waitForFrames((f) => f.some((x) => x.event === 'ready'));
    expect(getSubscriberCount()).toBe(1);

    client.close();
    await client.closed;
    // close ハンドラは next tick で動くので少し待つ
    await new Promise((r) => setTimeout(r, 50));
    expect(getSubscriberCount()).toBe(0);
  });

  it('returns 503 when XANGI_EVENTS_ENABLED=false', async () => {
    process.env.XANGI_EVENTS_ENABLED = 'false';
    // events 設定はモジュール初回ロード時にキャッシュされるので resetModules 後に再起動する
    await testServer.close();
    vi.resetModules();
    testServer = await startTestServer();

    const u = new URL(`${testServer.url}/api/events/stream`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: u.hostname,
          port: parseInt(u.port, 10),
          path: u.pathname,
          method: 'GET',
        },
        (res) => {
          resolve(res.statusCode || 0);
          res.resume();
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(503);
  });

  it('returns false (does not handle) for non-matching URL or method', async () => {
    const { handleEventsStreamRequest } = await import('../src/events-stream-server.js');
    // Mock な req/res で直接呼ぶ
    const fakeReq = { url: '/something/else', method: 'GET' } as never;
    const fakeRes = {} as never;
    expect(handleEventsStreamRequest(fakeReq, fakeRes)).toBe(false);

    const fakeReq2 = { url: '/api/events/stream', method: 'POST' } as never;
    expect(handleEventsStreamRequest(fakeReq2, fakeRes)).toBe(false);
  });
});
