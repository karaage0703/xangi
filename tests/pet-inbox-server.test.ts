/**
 * `POST /api/pet/inbox` ハンドラのテスト。
 *
 * - 認証 (loopback / token Bearer / 401 / 403)
 * - body 検証 (text 必須 / 長さ / 不正 JSON)
 * - 成功時 202 + 既存 events SSE への broadcast
 * - 無効化 (XANGI_PET_INBOX_ENABLED=false → 503)
 * - 非対象 (method / path) は false で素通し
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, request, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  AgentRunner,
  RunOptions,
  RunResult,
  StreamCallbacks,
} from '../src/agent-runner.js';

interface RecordedRun {
  prompt: string;
  callbacks: StreamCallbacks;
  options?: RunOptions;
}

function makeStubRunner(opts: { onRun?: (rec: RecordedRun) => void } = {}): AgentRunner {
  return {
    async run(): Promise<RunResult> {
      return { result: 'stub', sessionId: 'stub-session' };
    },
    async runStream(prompt, callbacks, options): Promise<RunResult> {
      opts.onRun?.({ prompt, callbacks, options });
      const result: RunResult = { result: 'echo', sessionId: 'stub-session' };
      callbacks.onComplete?.(result);
      return result;
    },
  };
}

interface PostResponse {
  status: number;
  body: Record<string, unknown> | string;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<PostResponse> {
  const u = new URL(url);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise<PostResponse>((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: parseInt(u.port, 10),
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload).toString(),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          let parsed: Record<string, unknown> | string;
          try {
            parsed = JSON.parse(buf);
          } catch {
            parsed = buf;
          }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

interface TestServer {
  url: string;
  runner: AgentRunner;
  lastRun: RecordedRun | null;
  close(): Promise<void>;
}

async function startTestServer(
  replySuggestions = { replySuggestions: true, replySuggestionCount: 3 }
): Promise<TestServer> {
  const { handlePetInboxRequest } = await import('../src/pet-inbox-server.js');
  const captured: { last: RecordedRun | null } = { last: null };
  const runner = makeStubRunner({
    onRun: (rec) => {
      captured.last = rec;
    },
  });
  const server: Server = createServer(async (req, res) => {
    try {
      const handled = await handlePetInboxRequest(req, res, runner, replySuggestions);
      if (!handled) {
        res.writeHead(404);
        res.end('not found');
      }
    } catch (err) {
      console.error('[pet-inbox-test] handler threw:', err);
      res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    runner,
    get lastRun() {
      return captured.last;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('pet-inbox-server', () => {
  let server: TestServer;
  let dataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    // sessions.json を毎テスト分離するため DATA_DIR を tmpdir に向ける
    dataDir = mkdtempSync(join(tmpdir(), 'pet-inbox-test-'));
    process.env.DATA_DIR = dataDir;
    process.env.XANGI_INSTANCE_ID = 'xangi-test';
    delete process.env.XANGI_PET_INBOX_TOKEN;
    delete process.env.XANGI_PET_INBOX_ENABLED;
    delete process.env.XANGI_DEVICE_INBOX_ENABLED;
    delete process.env.XANGI_EVENTS_ENABLED;
    const { initSessions } = await import('../src/sessions.js');
    initSessions(dataDir);
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.DATA_DIR;
    delete process.env.XANGI_INSTANCE_ID;
    delete process.env.XANGI_PET_INBOX_TOKEN;
    delete process.env.XANGI_PET_INBOX_ENABLED;
    delete process.env.XANGI_DEVICE_INBOX_ENABLED;
    delete process.env.XANGI_EVENTS_ENABLED;
  });

  it('accepts loopback POST with text → 202 + invokes runner', async () => {
    const res = await postJson(`${server.url}/api/pet/inbox`, { text: 'hello pet' });
    expect(res.status).toBe(202);
    const body = res.body as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(body.instance_id).toBe('xangi-test');
    expect(typeof body.thread_id).toBe('string');
    expect(typeof body.turn_id).toBe('string');
    expect(typeof body.session_id).toBe('string');

    // fire-and-forget で runner.runStream が呼ばれる
    await new Promise((r) => setTimeout(r, 50));
    expect(server.lastRun).not.toBeNull();
    expect(server.lastRun!.prompt).toContain('hello pet');
    expect(server.lastRun!.prompt).toContain('[プラットフォーム: Web (Pet)]');
    expect(server.lastRun!.prompt).toContain('<xangi_reply_suggestions>');
  });

  it('accepts device inbox POST and returns a filtered events URL', async () => {
    const { createWebSession } = await import('../src/sessions.js');
    const appSessionId = createWebSession({
      title: 'Game session',
      workspaceId: 'game',
      workspacePath: '/workspace/game',
    });
    const res = await postJson(`${server.url}/api/device/inbox`, {
      text: 'hello glasses',
      source: 'g2',
      appSessionId,
    });
    expect(res.status).toBe(202);
    const body = res.body as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(String(body.events_url)).toContain('/api/events/stream?thread_id=');

    await new Promise((r) => setTimeout(r, 50));
    expect(server.lastRun).not.toBeNull();
    expect(server.lastRun!.prompt).toContain('hello glasses');
    expect(server.lastRun!.prompt).toContain('[プラットフォーム: Web (Device:g2)]');
    expect(server.lastRun!.prompt).toContain('<xangi_reply_suggestions>');
    expect(server.lastRun!.options).toMatchObject({
      appSessionId,
      channelId: `web-chat:${appSessionId}`,
      settingsChannelId: `web-chat:${appSessionId}`,
      workdir: '/workspace/game',
      platform: 'web',
    });
  });

  it('uses Web reply suggestion settings for terminal inbox', async () => {
    const res = await postJson(`${server.url}/api/terminal/inbox`, {
      text: 'hello terminal',
      source: 'even-g2',
    });
    expect(res.status).toBe(202);

    await new Promise((r) => setTimeout(r, 50));
    expect(server.lastRun).not.toBeNull();
    expect(server.lastRun!.prompt).toContain('[プラットフォーム: Web (Terminal:even-g2)]');
    expect(server.lastRun!.prompt).toContain('<xangi_reply_suggestions>');
  });

  it('does not request suggestions when Web reply suggestions are disabled', async () => {
    await server.close();
    server = await startTestServer({ replySuggestions: false, replySuggestionCount: 3 });

    const res = await postJson(`${server.url}/api/terminal/inbox`, {
      text: 'plain response',
      source: 'even-g2',
    });
    expect(res.status).toBe(202);

    await new Promise((r) => setTimeout(r, 50));
    expect(server.lastRun).not.toBeNull();
    expect(server.lastRun!.prompt).not.toContain('<xangi_reply_suggestions>');
  });

  it('returns 400 when text is missing or empty', async () => {
    const r1 = await postJson(`${server.url}/api/pet/inbox`, {});
    expect(r1.status).toBe(400);
    const r2 = await postJson(`${server.url}/api/pet/inbox`, { text: '   ' });
    expect(r2.status).toBe(400);
  });

  it('returns 400 when text exceeds max length', async () => {
    const longText = 'a'.repeat(9000);
    const res = await postJson(`${server.url}/api/pet/inbox`, { text: longText });
    expect(res.status).toBe(400);
    expect((res.body as Record<string, unknown>).error).toContain('too long');
  });

  it('returns 400 on invalid JSON body', async () => {
    const res = await postJson(`${server.url}/api/pet/inbox`, '{not-json');
    expect(res.status).toBe(400);
  });

  it('returns 401 when token is set but Authorization header missing', async () => {
    process.env.XANGI_PET_INBOX_TOKEN = 'secret123';
    const res = await postJson(`${server.url}/api/pet/inbox`, { text: 'hi' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is set but Authorization header wrong', async () => {
    process.env.XANGI_PET_INBOX_TOKEN = 'secret123';
    const res = await postJson(
      `${server.url}/api/pet/inbox`,
      { text: 'hi' },
      { Authorization: 'Bearer wrong' }
    );
    expect(res.status).toBe(401);
  });

  it('returns 202 when token is set and Authorization header matches', async () => {
    process.env.XANGI_PET_INBOX_TOKEN = 'secret123';
    const res = await postJson(
      `${server.url}/api/pet/inbox`,
      { text: 'authenticated' },
      { Authorization: 'Bearer secret123' }
    );
    expect(res.status).toBe(202);
  });

  it('returns 503 when XANGI_PET_INBOX_ENABLED=false', async () => {
    process.env.XANGI_PET_INBOX_ENABLED = 'false';
    const res = await postJson(`${server.url}/api/pet/inbox`, { text: 'hi' });
    expect(res.status).toBe(503);
  });

  it('isLocalOrPrivate accepts loopback / RFC1918 / CGNAT, rejects public IPs', async () => {
    const { isLocalOrPrivate } = await import('../src/pet-inbox-server.js');
    // Allowed
    expect(isLocalOrPrivate('127.0.0.1')).toBe(true);
    expect(isLocalOrPrivate('127.5.4.3')).toBe(true);
    expect(isLocalOrPrivate('::1')).toBe(true);
    expect(isLocalOrPrivate('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalOrPrivate('10.0.0.1')).toBe(true);
    expect(isLocalOrPrivate('192.168.1.42')).toBe(true);
    expect(isLocalOrPrivate('172.16.0.1')).toBe(true);
    expect(isLocalOrPrivate('172.31.255.255')).toBe(true);
    expect(isLocalOrPrivate('100.86.210.85')).toBe(true); // Tailscale CGNAT
    expect(isLocalOrPrivate('100.64.0.0')).toBe(true);
    expect(isLocalOrPrivate('100.127.255.255')).toBe(true);
    expect(isLocalOrPrivate('fe80::1')).toBe(true); // IPv6 link-local
    expect(isLocalOrPrivate('fd00::1')).toBe(true); // IPv6 ULA
    expect(isLocalOrPrivate('localhost')).toBe(true);
    // Rejected
    expect(isLocalOrPrivate('8.8.8.8')).toBe(false);
    expect(isLocalOrPrivate('1.1.1.1')).toBe(false);
    expect(isLocalOrPrivate('172.15.0.1')).toBe(false); // just outside RFC1918 172.16/12
    expect(isLocalOrPrivate('172.32.0.1')).toBe(false); // just outside RFC1918 172.16/12
    expect(isLocalOrPrivate('100.63.0.1')).toBe(false); // just below CGNAT 100.64/10
    expect(isLocalOrPrivate('100.128.0.1')).toBe(false); // just above CGNAT 100.64/10
    expect(isLocalOrPrivate('2001:db8::1')).toBe(false);
    expect(isLocalOrPrivate(undefined)).toBe(false);
    expect(isLocalOrPrivate('')).toBe(false);
    expect(isLocalOrPrivate('not-an-ip')).toBe(false);
  });

  it('returns false (does not handle) for non-matching URL or method', async () => {
    const { handlePetInboxRequest } = await import('../src/pet-inbox-server.js');
    const stub = makeStubRunner();
    const fakeRes = {} as never;
    expect(
      await handlePetInboxRequest(
        { url: '/something/else', method: 'POST' } as never,
        fakeRes,
        stub
      )
    ).toBe(false);
    expect(
      await handlePetInboxRequest(
        { url: '/api/pet/inbox', method: 'GET' } as never,
        fakeRes,
        stub
      )
    ).toBe(false);
    expect(
      await handlePetInboxRequest(
        { url: '/api/device/inbox', method: 'GET' } as never,
        fakeRes,
        stub
      )
    ).toBe(false);
  });

  it('publishes turn.started / turn.complete via events SSE broadcast', async () => {
    const { subscribeEvents } = await import('../src/events-emitter.js');
    const seen: string[] = [];
    const unsub = subscribeEvents((evt) => {
      seen.push(evt.type);
    });
    try {
      const res = await postJson(`${server.url}/api/pet/inbox`, { text: 'broadcast me' });
      expect(res.status).toBe(202);
      // fire-and-forget の agent 実行が完了するまで待つ
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toContain('turn.started');
      expect(seen).toContain('turn.complete');
    } finally {
      unsub();
    }
  });
});
