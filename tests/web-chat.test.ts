import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import { startWebChat } from '../src/web-chat.js';
import {
  initSessions,
  clearSessions,
  listAllSessions,
  getSessionEntry,
  createSession,
  WEB_CHAT_CONTEXT_PREFIX,
} from '../src/sessions.js';
import type {
  AgentRunner,
  RunOptions,
  RunResult,
  StreamCallbacks,
} from '../src/agent-runner.js';

/**
 * 任意のタイミングで完了させられる Fake AgentRunner。
 * runStream() を呼ぶと promise を保留し、release(channelId) で解放できる。
 */
class FakeRunner implements AgentRunner {
  destroyed = new Set<string>();
  pending = new Map<string, () => void>();
  callOrder: string[] = [];

  async run(): Promise<RunResult> {
    return { result: 'fake', sessionId: 'fake-sess' };
  }

  async runStream(
    _prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const channelId = options?.channelId || 'default';
    this.callOrder.push(channelId);
    return new Promise<RunResult>((resolve) => {
      this.pending.set(channelId, () => {
        const result: RunResult = { result: 'ok', sessionId: `provider-${channelId}` };
        callbacks.onComplete?.(result);
        resolve(result);
      });
    });
  }

  release(channelId: string): boolean {
    const fn = this.pending.get(channelId);
    if (!fn) return false;
    this.pending.delete(channelId);
    fn();
    return true;
  }

  cancel(): boolean {
    return false;
  }

  destroy(channelId: string): boolean {
    this.destroyed.add(channelId);
    return true;
  }

  hasRunner(channelId: string): boolean {
    return this.callOrder.includes(channelId) && !this.destroyed.has(channelId);
  }
}

/**
 * SSE 応答から `event: done` の data を取り出す簡易パーサ。
 * 取得できなければ undefined。
 */
async function readSSEUntilDone(
  body: ReadableStream<Uint8Array> | null
): Promise<{ events: { event: string; data: any }[] }> {
  const events: { event: string; data: any }[] = [];
  if (!body) return { events };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const segments = buf.split('\n\n');
    buf = segments.pop() || '';
    for (const seg of segments) {
      const lines = seg.split('\n');
      let event = '';
      let data: unknown;
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) {
          try {
            data = JSON.parse(line.slice(6));
          } catch {
            data = line.slice(6);
          }
        }
      }
      if (event) events.push({ event, data });
      if (event === 'done' || event === 'error') return { events };
    }
  }
  return { events };
}

async function freePort(): Promise<number> {
  // 0 を listen させて確保したポートを返す
  const { createServer } = await import('http');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('failed to allocate port')));
      }
    });
  });
}

describe('web-chat HTTP API', () => {
  let testDir: string;
  let server: Server | null = null;
  let baseUrl = '';
  let runner: FakeRunner;
  const prevWorkspace = process.env.WORKSPACE_PATH;

  beforeEach(async () => {
    clearSessions();
    testDir = mkdtempSync(join(tmpdir(), 'web-chat-test-'));
    process.env.WORKSPACE_PATH = testDir;
    initSessions(testDir);

    runner = new FakeRunner();
    const port = await freePort();
    // startWebChat は server を返さないので、内部で動作する http サーバの listen を待つために
    // setTimeout で次のティックを待ち、URL を保持する。
    startWebChat({ agentRunner: runner, port });
    baseUrl = `http://127.0.0.1:${port}`;

    // 起動完了を待つ（health チェック）
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) {
          server = (await import('http')).Server.prototype as unknown as Server;
          break;
        }
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterEach(() => {
    // 既存テストの後始末: 注意:startWebChat は server を返さないが、各テストごとに別 port を使うので
    // この test ではプロセス終了で OS が掃除する前提。プロセスを汚さないよう pending を解放する。
    for (const ch of Array.from(runner?.pending.keys() ?? [])) {
      runner.release(ch);
    }
    clearSessions();
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    if (prevWorkspace == null) delete process.env.WORKSPACE_PATH;
    else process.env.WORKSPACE_PATH = prevWorkspace;
  });

  it('POST /api/sessions creates a fresh web session without destroying others', async () => {
    const r1 = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const j1 = await r1.json();
    const r2 = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const j2 = await r2.json();

    expect(j1.sessionId).toBeTruthy();
    expect(j2.sessionId).toBeTruthy();
    expect(j1.sessionId).not.toBe(j2.sessionId);

    const sessions = listAllSessions().filter((s) => s.platform === 'web');
    expect(sessions.map((s) => s.id).sort()).toEqual([j1.sessionId, j2.sessionId].sort());

    // contextKey が web-chat:<appId> 形式で別々
    const e1 = getSessionEntry(j1.sessionId)!;
    const e2 = getSessionEntry(j2.sessionId)!;
    expect(e1.contextKey).toBe(`${WEB_CHAT_CONTEXT_PREFIX}${j1.sessionId}`);
    expect(e2.contextKey).toBe(`${WEB_CHAT_CONTEXT_PREFIX}${j2.sessionId}`);

    // Runner は destroy されていない（旧実装のように web-chat ランナーを毎回破棄しない）
    expect(runner.destroyed.size).toBe(0);
  });

  it('POST /api/chat enforces a busy lock per appSessionId (returns 409 on concurrent send to same session)', async () => {
    const created = await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json();
    const id = created.sessionId;

    // 1 本目（pending のままにする）
    const first = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'first' }),
    });

    // first がランナーに到達するまで小待機
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runner.pending.size).toBe(1);

    // 同じセッションに 2 本目 → 409
    const concurrent = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'second' }),
    });
    expect(concurrent.status).toBe(409);

    // 1 本目を解放して、後始末
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${id}`);
    const r1 = await first;
    await readSSEUntilDone(r1.body);
  });

  it('POST /api/chat allows two different sessions to stream concurrently', async () => {
    const a = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const b = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;

    const sendA = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: a, message: 'hello A' }),
    });
    const sendB = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: b, message: 'hello B' }),
    });

    // 両方が runner に到達するまで待つ
    for (let i = 0; i < 50 && runner.pending.size < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runner.pending.size).toBe(2);
    expect([...runner.pending.keys()].sort()).toEqual(
      [`${WEB_CHAT_CONTEXT_PREFIX}${a}`, `${WEB_CHAT_CONTEXT_PREFIX}${b}`].sort()
    );

    // 両方解放
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${a}`);
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${b}`);

    const [resA, resB] = await Promise.all([sendA, sendB]);
    const evA = await readSSEUntilDone(resA.body);
    const evB = await readSSEUntilDone(resB.body);
    expect(evA.events.find((e) => e.event === 'done')).toBeTruthy();
    expect(evB.events.find((e) => e.event === 'done')).toBeTruthy();
  });

  it('POST /api/sessions/:id/stop destroys the runner but keeps the session', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const ctx = `${WEB_CHAT_CONTEXT_PREFIX}${id}`;

    // 1 回 runStream を回して runner を pool に入れる
    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'hi' }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.release(ctx);
    const r1 = await send;
    await readSSEUntilDone(r1.body);

    // この時点で hasRunner=true
    expect(runner.hasRunner(ctx)).toBe(true);

    // /stop で destroy
    const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    });
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.stopped).toBe(true);

    // runner は破棄、セッション自体は残る
    expect(runner.destroyed.has(ctx)).toBe(true);
    expect(runner.hasRunner(ctx)).toBe(false);
    expect(getSessionEntry(id)).toBeDefined();
  });

  it('GET /api/sessions reflects hasRunner in isActive (web sessions)', async () => {
    const a = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const b = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;

    // a だけ runStream を呼ぶ → pool に入る
    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: a, message: 'hi' }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${a}`);
    await readSSEUntilDone((await send).body);

    const list = await (await fetch(`${baseUrl}/api/sessions`)).json();
    const sa = list.sessions.find((s: { id: string }) => s.id === a);
    const sb = list.sessions.find((s: { id: string }) => s.id === b);
    expect(sa.isActive).toBe(true);
    expect(sb.isActive).toBe(false);
  });

  it('GET /api/sessions includes Discord sessions (channelId-based contextKey) as managed', async () => {
    // Discord セッション: title 空 + contextKey が 10桁以上の数字 channel ID。
    // 旧フィルターはこれを除外していたが、修正後は managed として出るべき。
    const channelId = '1469726038291386523';
    const discordAppId = createSession(channelId, { platform: 'discord' });

    // ログファイルから title が導出されるパスを検証するためログを書き込む
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, `${discordAppId}.jsonl`);
    const userMessage =
      '[プラットフォーム: Discord]\n' +
      `[チャンネル: #dev_xangi (ID: ${channelId})]\n` +
      '[発言者: からあげ (ID: 1)]\n' +
      '[現在時刻: 2026/5/5 10:00:00(火)]\n' +
      '最初のメッセージです';
    writeFileSync(
      logPath,
      JSON.stringify({
        id: 'm1',
        role: 'user',
        content: userMessage,
        createdAt: '2026-05-05T01:00:00Z',
      }) + '\n'
    );

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{
        id: string;
        title: string;
        platform: string;
        contextKey: string;
      }>;
    };
    const found = list.sessions.find((s) => s.id === discordAppId);
    expect(found).toBeDefined();
    expect(found?.platform).toBe('discord');
    // managed なので contextKey はチャンネル ID（unmanaged だと '' になっていた）
    expect(found?.contextKey).toBe(channelId);
    // タイトルは最初の user メッセージから導出されるので「最初のメッセージです」
    expect(found?.title).toBe('最初のメッセージです');
  });

  it('GET /api/sessions falls back to contextKey when no title and no log can be derived', async () => {
    const channelId = '1500000000000000001';
    const id = createSession(channelId, { platform: 'discord' });
    // ログ無し → タイトル導出不可。フォールバックで contextKey が返る
    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string; title: string; contextKey: string }>;
    };
    const found = list.sessions.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.title).toBe(channelId);
    expect(found?.contextKey).toBe(channelId);
  });

  it('DELETE /api/sessions/:id destroys the corresponding runner', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const ctx = `${WEB_CHAT_CONTEXT_PREFIX}${id}`;

    const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    expect(res.ok).toBe(true);
    expect(runner.destroyed.has(ctx)).toBe(true);
    expect(getSessionEntry(id)).toBeUndefined();
  });
});
