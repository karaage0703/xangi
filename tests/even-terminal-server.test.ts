import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, request, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../src/agent-runner.js';

interface RecordedRun {
  prompt: string;
  callbacks: StreamCallbacks;
  options?: RunOptions;
  resolve: (result: RunResult) => void;
}

class FakeRunner implements AgentRunner {
  runs: RecordedRun[] = [];

  async run(): Promise<RunResult> {
    return { result: 'ok', sessionId: 'provider-session' };
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      this.runs.push({ prompt, callbacks, options, resolve });
    });
  }

  complete(text = 'hello from xangi'): void {
    const run = this.runs.shift();
    if (!run) throw new Error('no pending run');
    run.callbacks.onText?.(text, text);
    const result = { result: text, sessionId: 'provider-session' };
    run.callbacks.onComplete?.(result);
    run.resolve(result);
  }
}

interface TestServer {
  url: string;
  runner: FakeRunner;
  close(): Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const { handleEvenTerminalRequest } = await import('../src/even-terminal-server.js');
  const runner = new FakeRunner();
  const server: Server = createServer(async (req, res) => {
    const handled = await handleEvenTerminalRequest(req, res, runner);
    if (!handled) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    runner,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const u = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: parseInt(u.port, 10),
        path: u.pathname + u.search,
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
        res.on('data', (chunk) => {
          buf += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: JSON.parse(buf) });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

interface SseFrame {
  data?: string;
}

async function connectSse(url: string): Promise<{
  frames: SseFrame[];
  waitFor(predicate: (frames: SseFrame[]) => boolean): Promise<void>;
  close(): void;
  closed: Promise<void>;
}> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: parseInt(u.port, 10),
        path: u.pathname + u.search,
        method: 'GET',
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`unexpected status ${res.statusCode}`));
          return;
        }
        const frames: SseFrame[] = [];
        let buf = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (block.startsWith(':')) continue;
            const frame: SseFrame = {};
            for (const line of block.split('\n')) {
              if (line.startsWith('data: ')) frame.data = line.slice(6);
            }
            frames.push(frame);
          }
        });
        const closed = new Promise<void>((r) => res.on('close', r));
        resolve({
          frames,
          waitFor: async (predicate) => {
            const start = Date.now();
            while (Date.now() - start < 1500) {
              if (predicate(frames)) return;
              await new Promise((r) => setTimeout(r, 10));
            }
            throw new Error(`timed out: ${JSON.stringify(frames)}`);
          },
          close: () => req.destroy(),
          closed,
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 1500) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for condition');
}

describe('even-terminal compatibility API', () => {
  let dataDir: string;
  let server: TestServer;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = mkdtempSync(join(tmpdir(), 'even-terminal-test-'));
    process.env.DATA_DIR = dataDir;
    process.env.WORKSPACE_PATH = dataDir;
    process.env.XANGI_EVEN_TERMINAL_TOKEN = 'secret';
    process.env.AGENT_BACKEND = 'local-llm';
    process.env.LOCAL_LLM_MODEL = 'gemma-test';
    const { initSessions } = await import('../src/sessions.js');
    initSessions(dataDir);
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.DATA_DIR;
    delete process.env.WORKSPACE_PATH;
    delete process.env.XANGI_EVEN_TERMINAL_TOKEN;
    delete process.env.XANGI_EVEN_TERMINAL_BACKEND;
    delete process.env.XANGI_EVEN_TERMINAL_MODEL;
    delete process.env.XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE;
    delete process.env.AGENT_BACKEND;
    delete process.env.LOCAL_LLM_MODEL;
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not claim plain /api/sessions so Web Chat can keep its existing route', async () => {
    const res = await fetch(`${server.url}/api/sessions`);
    expect(res.status).toBe(404);
  });

  it('lists sessions with Even Terminal compatible timestamp and provider fields', async () => {
    const { createWebSession } = await import('../src/sessions.js');
    const sessionId = createWebSession({ title: 'G2 test session' });

    const res = await fetch(`${server.url}/api/sessions?provider=codex&token=secret`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    const session = body.sessions.find((s: Record<string, unknown>) => s.id === sessionId);
    expect(session).toMatchObject({
      id: sessionId,
      title: 'G2 test session',
      provider: 'codex',
      status: 'idle',
    });
    expect(typeof session.timestamp).toBe('string');
    expect(typeof session.cwd).toBe('string');
  });

  it('uses the requested provider label when listing existing sessions', async () => {
    const { createWebSession } = await import('../src/sessions.js');
    const sessionId = createWebSession({ title: 'Existing G2 session' });

    const codexRes = await fetch(`${server.url}/api/sessions?provider=codex&token=secret`);
    expect(codexRes.ok).toBe(true);
    const codexBody = await codexRes.json();
    const codexSession = codexBody.sessions.find(
      (s: Record<string, unknown>) => s.id === sessionId
    );
    expect(codexSession.provider).toBe('codex');

    const claudeRes = await fetch(`${server.url}/api/sessions?provider=claude&token=secret`);
    expect(claudeRes.ok).toBe(true);
    const claudeBody = await claudeRes.json();
    const claudeSession = claudeBody.sessions.find(
      (s: Record<string, unknown>) => s.id === sessionId
    );
    expect(claudeSession.provider).toBe('claude');
  });

  it('does not list legacy empty placeholder sessions', async () => {
    const { createWebSession } = await import('../src/sessions.js');
    const placeholderId = createWebSession({ title: 'Even Terminal New Session' });

    const res = await fetch(`${server.url}/api/sessions?provider=claude&token=secret`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.sessions.some((s: Record<string, unknown>) => s.id === placeholderId)).toBe(false);
    expect(
      body.sessions.some((s: Record<string, unknown>) => s.title === 'Even Terminal New Session')
    ).toBe(false);
  });

  it('requires the Even Terminal token when configured', async () => {
    const res = await fetch(`${server.url}/api/info`);
    expect(res.status).toBe(401);
  });

  it('accepts prompt and streams Even Terminal style events', async () => {
    const accepted = await postJson(
      `${server.url}/api/prompt`,
      { text: 'hello g2', provider: 'codex' },
      { Authorization: 'Bearer secret' }
    );
    expect(accepted.status).toBe(202);
    const sessionId = String(accepted.body.sessionId);
    expect(sessionId).toBeTruthy();

    const client = await connectSse(
      `${server.url}/api/events?sessionId=${encodeURIComponent(sessionId)}&token=secret`
    );
    try {
      await client.waitFor((frames) =>
        frames.some((f) => f.data && JSON.parse(f.data).type === 'user_prompt')
      );
      expect(server.runner.runs[0].prompt).toContain('[プラットフォーム: Web (Even Terminal)]');
      expect(server.runner.runs[0].prompt).toContain('hello g2');

      server.runner.complete('**answer** `code`\n\nnext');
      await client.waitFor((frames) =>
        frames.some((f) => f.data && JSON.parse(f.data).type === 'result')
      );
      const messages = client.frames
        .map((f) => (f.data ? JSON.parse(f.data) : null))
        .filter(Boolean);
      const typesAndStates = messages.map((m) =>
        m.type === 'status' ? `${m.type}:${m.state}` : m.type
      );
      expect(typesAndStates).toEqual([
        'status:busy',
        'user_prompt',
        'text_delta',
        'result',
        'status:idle',
      ]);
      expect(messages.some((m) => m.type === 'text_delta' && m.text === 'answer code / next')).toBe(
        true
      );
      const result = messages.find((m) => m.type === 'result');
      expect(result).toMatchObject({
        success: true,
        text: 'answer code / next',
      });
    } finally {
      client.close();
      await client.closed;
    }
  });

  it('renames a newly created Even Terminal session after the first prompt completes', async () => {
    const accepted = await postJson(
      `${server.url}/api/prompt`,
      { text: 'new session title', provider: 'codex' },
      { Authorization: 'Bearer secret' }
    );
    expect(accepted.status).toBe(202);
    const sessionId = String(accepted.body.sessionId);

    const client = await connectSse(
      `${server.url}/api/events?sessionId=${encodeURIComponent(sessionId)}&token=secret`
    );
    try {
      await waitUntil(() => server.runner.runs.length === 1);
      server.runner.complete('created session answer');
      await client.waitFor((frames) =>
        frames.some((f) => f.data && JSON.parse(f.data).type === 'result')
      );

      const res = await fetch(`${server.url}/api/sessions?provider=codex&token=secret`);
      expect(res.ok).toBe(true);
      const body = await res.json();
      const session = body.sessions.find((s: Record<string, unknown>) => s.id === sessionId);
      expect(session).toMatchObject({
        id: sessionId,
        title: 'new session title',
      });
    } finally {
      client.close();
      await client.closed;
    }
  });

  it('exposes completed new-session state through /api/sessions polling', async () => {
    const { createWebSession } = await import('../src/sessions.js');
    const sessionId = createWebSession({ title: 'Even Terminal New Session' });

    const accepted = await postJson(
      `${server.url}/api/prompt`,
      { text: 'poll only new session', provider: 'codex', sessionId },
      { Authorization: 'Bearer secret' }
    );
    expect(accepted.status).toBe(202);
    expect(accepted.body.sessionId).toBe(sessionId);

    await waitUntil(() => server.runner.runs.length === 1);

    const historyPromise = fetch(
      `${server.url}/api/sessions/${encodeURIComponent(sessionId)}/history?provider=codex&token=secret&limit=10`
    ).then((res) => res.json());

    await new Promise((r) => setTimeout(r, 100));
    server.runner.complete('poll only answer');
    await expect(historyPromise).resolves.toEqual({
      history: [
        { role: 'user', text: 'poll only new session' },
        { role: 'assistant', text: 'poll only answer' },
      ],
    });

    const sessionsRes = await fetch(`${server.url}/api/sessions?provider=codex&token=secret`);
    expect(sessionsRes.ok).toBe(true);
    const sessionsBody = await sessionsRes.json();
    const session = sessionsBody.sessions.find((s: Record<string, unknown>) => s.id === sessionId);
    expect(session).toMatchObject({
      id: sessionId,
      title: 'poll only new session',
      status: 'idle',
      messageCount: 2,
      lastMessage: 'poll only answer',
      lastRole: 'assistant',
    });
  });

  it('includes current activity fields in Even Terminal session polling', async () => {
    const { createWebSession } = await import('../src/sessions.js');
    const sessionId = createWebSession({ title: 'G2 monitor activity' });

    const accepted = await postJson(
      `${server.url}/api/prompt`,
      { text: 'watch this session', provider: 'codex', sessionId },
      { Authorization: 'Bearer secret' }
    );
    expect(accepted.status).toBe(202);

    await waitUntil(() => server.runner.runs.length === 1);
    const sessionsRes = await fetch(`${server.url}/api/sessions?provider=codex&token=secret`);
    expect(sessionsRes.ok).toBe(true);
    const sessionsBody = await sessionsRes.json();
    const session = sessionsBody.sessions.find((s: Record<string, unknown>) => s.id === sessionId);
    expect(session).toMatchObject({
      id: sessionId,
      status: 'thinking',
      activityState: 'thinking',
    });
    expect(String(session.activitySummary)).toContain('watch this session');

    server.runner.complete('watched');
  });

  it('passes Even Terminal specific backend defaults to the runner', async () => {
    process.env.XANGI_EVEN_TERMINAL_BACKEND = 'local-llm';
    process.env.XANGI_EVEN_TERMINAL_MODEL = 'gemma-4-26b-a4b';
    process.env.XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE = 'chat';
    const { createWebSession } = await import('../src/sessions.js');
    const sessionId = createWebSession({ title: 'Even Terminal options test' });

    const accepted = await postJson(
      `${server.url}/api/prompt`,
      { text: 'chat mode please', provider: 'codex', sessionId },
      { Authorization: 'Bearer secret' }
    );
    expect(accepted.status).toBe(202);

    await waitUntil(() => server.runner.runs.length > 0);
    expect(server.runner.runs[0].options).toMatchObject({
      platform: 'web',
      defaultBackend: 'local-llm',
      defaultModel: 'gemma-4-26b-a4b',
      defaultLocalLlmMode: 'chat',
    });

    server.runner.complete('ok');
  });

  it('reports xangi backend model through /api/info while keeping a claude/codex provider label', async () => {
    const res = await fetch(`${server.url}/api/info?provider=codex&token=secret`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.provider).toBe('codex');
    expect(body.model).toBe('gemma-test');
  });

  it('returns persisted transcript history for Even Terminal sessions', async () => {
    const { logPrompt, logResponse } = await import('../src/transcript-logger.js');
    const sessionId = 'terminal-history-session';
    logPrompt(
      dataDir,
      sessionId,
      '[runtime] cwd=/tmp repo=x@test\n\n[プラットフォーム: Web (Even Terminal)]\nprevious prompt'
    );
    logResponse(dataDir, sessionId, { result: 'previous answer', sessionId: 'provider-session' });

    const res = await fetch(
      `${server.url}/api/sessions/${encodeURIComponent(sessionId)}/history?provider=codex&token=secret&limit=10`
    );
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toEqual({
      history: [
        { role: 'user', text: 'previous prompt' },
        { role: 'assistant', text: 'previous answer' },
      ],
    });
  });

  it('waits for the first assistant text before returning active new-session history', async () => {
    const accepted = await postJson(
      `${server.url}/api/prompt`,
      { text: 'new session prompt', provider: 'codex' },
      { Authorization: 'Bearer secret' }
    );
    expect(accepted.status).toBe(202);
    const sessionId = String(accepted.body.sessionId);

    const client = await connectSse(
      `${server.url}/api/events?sessionId=${encodeURIComponent(sessionId)}&token=secret`
    );
    try {
      await waitUntil(() => server.runner.runs.length === 1);
      const historyPromise = fetch(
        `${server.url}/api/sessions/${encodeURIComponent(sessionId)}/history?provider=codex&token=secret&limit=10`
      ).then(async (res) => {
        expect(res.ok).toBe(true);
        return res.json();
      });

      await new Promise((r) => setTimeout(r, 100));
      server.runner.complete('active answer');

      await expect(historyPromise).resolves.toEqual({
        history: [
          { role: 'user', text: 'new session prompt' },
          { role: 'assistant', text: 'active answer' },
        ],
      });
    } finally {
      client.close();
      await client.closed;
    }
  });

  it('falls back to persisted history when /api/messages has no in-memory buffer', async () => {
    const { logPrompt, logResponse } = await import('../src/transcript-logger.js');
    const sessionId = 'terminal-messages-history-session';
    logPrompt(
      dataDir,
      sessionId,
      '[runtime] cwd=/tmp repo=x@test\n\n[プラットフォーム: Web (Even Terminal)]\nold prompt'
    );
    logResponse(dataDir, sessionId, { result: 'old answer', sessionId: 'provider-session' });

    const res = await fetch(
      `${server.url}/api/messages?sessionId=${encodeURIComponent(sessionId)}&provider=claude&token=secret&after=0`
    );
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.messages).toEqual([
      { id: 1, role: 'user', text: 'old prompt' },
      { id: 2, role: 'assistant', text: 'old answer' },
    ]);
    expect(body.state).toBe('idle');
    expect(body.provider).toBe('claude');
  });
});
