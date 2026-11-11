import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { handleInterChatRequest } from '../src/inter-instance-chat/web-server.js';
import { interChatToolCmd } from '../src/cli/inter-chat-cmd.js';
import type { AgentRunner } from '../src/agent-runner.js';
import {
  askAgent,
  processDirectedHttpRequest,
  exchangeAgentRequest,
} from '../src/inter-instance-chat/directed-request.js';
import {
  _resetInterChatConfigForTest,
  getInterChatConfig,
} from '../src/inter-instance-chat/index.js';
import { clearSessions, getSessionEntry, initSessions } from '../src/sessions.js';

describe('authenticated inter-instance HTTP requests', () => {
  let dataDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'xangi-inter-chat-test-'));
    process.env.DATA_DIR = dataDir;
    process.env.INTER_INSTANCE_CHAT_ALLOWED_PEERS = '*';
    process.env.INTER_INSTANCE_CHAT_ENABLED = 'true';
    process.env.INTER_INSTANCE_CHAT_TOKEN = 'shared-secret';
    process.env.INTER_INSTANCE_CHAT_PEERS = JSON.stringify({
      'instance-b': 'http://100.64.0.2:18888/',
    });
    process.env.XANGI_INSTANCE_ID = 'borot';
    _resetInterChatConfigForTest();
    clearSessions();
    initSessions(dataDir);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
    _resetInterChatConfigForTest();
    clearSessions();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const auth = 'Bearer shared-secret';
  const request = (text = 'question') => ({
    from: 'instance-b',
    to: 'borot',
    request_id: randomUUID(),
    text,
  });
  const status = (body: ReturnType<typeof request>, runner: AgentRunner) =>
    processDirectedHttpRequest(body, auth, runner, dataDir, 'status');

  it('returns receipts while queued, saves results, and never runs duplicate IDs twice', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const runner = {
      runStream: vi.fn(async () => {
        calls++;
        if (calls === 1) await gate;
        return { result: `answer ${calls}`, sessionId: 'provider-session' };
      }),
    } as unknown as AgentRunner;
    const first = request();
    const second = request('second');
    expect((await processDirectedHttpRequest(first, auth, runner, dataDir, 'submit')).status).toBe(
      202
    );
    await vi.waitFor(() => expect(runner.runStream).toHaveBeenCalledTimes(1));
    expect((await status(first, runner)).body.status).toBe('running');
    expect(
      (await processDirectedHttpRequest(second, auth, runner, dataDir, 'submit')).body.status
    ).toBe('queued');
    await processDirectedHttpRequest(first, auth, runner, dataDir, 'submit');
    await processDirectedHttpRequest(
      { ...first, request_id: first.request_id.toUpperCase() },
      auth,
      runner,
      dataDir,
      'submit'
    );
    expect(
      (
        await processDirectedHttpRequest(
          { ...first, text: 'changed' },
          auth,
          runner,
          dataDir,
          'submit'
        )
      ).status
    ).toBe(409);
    expect(
      (
        await processDirectedHttpRequest(
          { ...first, from: 'other-peer' },
          auth,
          runner,
          dataDir,
          'status'
        )
      ).status
    ).toBe(404);
    expect(
      (await processDirectedHttpRequest(first, 'Bearer wrong', runner, dataDir, 'status')).status
    ).toBe(401);
    finish();
    await vi.waitFor(async () =>
      expect((await status(second, runner)).body.status).toBe('completed')
    );
    const saved = await status(first, runner);
    expect(saved.body.text).toBe('answer 1');
    expect((await processDirectedHttpRequest(first, auth, runner, dataDir)).body).toEqual(
      saved.body
    );
    expect(runner.runStream).toHaveBeenCalledTimes(2);
  });

  it('persists execution errors and marks interrupted records without retrying', async () => {
    const runner = {
      runStream: vi.fn(async () => {
        throw new Error('runner failed');
      }),
    } as unknown as AgentRunner;
    const body = request();
    expect((await processDirectedHttpRequest(body, auth, runner, dataDir)).body).toMatchObject({
      ok: false,
      status: 'failed',
      error: 'runner failed',
    });
    expect((await status(body, runner)).body.status).toBe('failed');
    writeFileSync(
      join(dataDir, 'inter-chat-requests', `${body.request_id}.json`),
      JSON.stringify({
        taskHash: '',
        response: {
          ok: true,
          request_id: body.request_id,
          from: 'borot',
          to: 'instance-b',
          status: 'running',
        },
      })
    );
    expect((await status(body, runner)).body).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('interrupted'),
    });
    expect(runner.runStream).toHaveBeenCalledTimes(1);
    expect((await status(request(), runner)).status).toBe(404);
  });

  it('recovers the result over real HTTP after CLI waiting expires', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner = {
      runStream: vi.fn(async () => {
        await gate;
        return { result: 'late answer', sessionId: 'provider-session' };
      }),
    } as unknown as AgentRunner;
    const server: Server = createServer((req, res) => {
      void handleInterChatRequest(req, res, runner, dataDir);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    process.env.INTER_INSTANCE_CHAT_PEERS = JSON.stringify({
      'instance-b': `http://127.0.0.1:${address.port}`,
    });
    // This loopback fixture represents both identities in one process.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const response = await realFetch(url, {
        ...init,
        body: JSON.stringify({ ...body, from: 'instance-b', to: 'borot' }),
      });
      const result = await response.json();
      return new Response(JSON.stringify({ ...result, from: 'instance-b', to: 'borot' }), {
        status: response.status,
      });
    });
    _resetInterChatConfigForTest();
    try {
      const pending = JSON.parse(
        await interChatToolCmd('inter_chat_ask', {
          to: 'instance-b',
          text: 'slow task',
          timeout: '1',
        })
      );
      expect(pending).toMatchObject({
        wait_timed_out: true,
        status: expect.stringMatching(/queued|running/),
      });
      finish();
      await vi.waitFor(async () => {
        const result = JSON.parse(
          await interChatToolCmd('inter_chat_status', { to: 'instance-b', id: pending.request_id })
        );
        expect(result).toMatchObject({ status: 'completed', text: 'late answer' });
      });
      const duplicate = JSON.parse(
        await interChatToolCmd('inter_chat_ask', {
          to: 'instance-b',
          text: 'slow task',
          id: pending.request_id,
          async: 'true',
        })
      );
      expect(duplicate.status).toBe('completed');
      expect(runner.runStream).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns an async receipt and keeps accepted IDs when later polling fails', async () => {
    const id = randomUUID();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            request_id: id,
            from: 'instance-b',
            to: 'borot',
            status: 'queued',
          }),
          { status: 202 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    const receipt = JSON.parse(
      await interChatToolCmd('inter_chat_ask', {
        to: 'instance-b',
        text: 'task',
        id,
        async: 'true',
      })
    );
    expect(receipt).toMatchObject({ request_id: id, status: 'queued' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify(receipt), { status: 202 })
    );
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    const unconfirmed = JSON.parse(
      await interChatToolCmd('inter_chat_ask', { to: 'instance-b', text: 'task', id, timeout: '2' })
    );
    expect(unconfirmed).toMatchObject({
      request_id: id,
      status: 'queued',
      result_unconfirmed: true,
    });
    expect(unconfirmed.retrieval_error).toContain('offline');
  });

  it('includes the original ID on uncertain submission and rejects mismatched replies', async () => {
    const id = randomUUID();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection lost');
      })
    );
    await expect(exchangeAgentRequest('instance-b', id, 'task')).rejects.toThrow(
      `request_id=${id}`
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              status: 'queued',
              request_id: id,
              from: 'wrong',
              to: 'borot',
            })
          )
      )
    );
    await expect(exchangeAgentRequest('instance-b', id, 'task')).rejects.toThrow('mismatched');
  });

  it('sends a directed request to the configured peer with bearer authentication', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, string>;
      return new Response(
        JSON.stringify({
          ok: true,
          request_id: request.request_id,
          from: 'instance-b',
          to: 'borot',
          text: 'HTTP response',
          session_id: 'remote-session',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(askAgent('instance-b', 'report status', 2_000)).resolves.toMatchObject({
      from: 'instance-b',
      text: 'HTTP response',
      kind: 'response',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://100.64.0.2:18888/api/inter-chat/ask',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer shared-secret' }),
      })
    );
  });

  it('rejects a request with a mismatched bearer token before running the agent', async () => {
    const runner = { runStream: vi.fn() } as unknown as AgentRunner;
    const result = await processDirectedHttpRequest(
      {
        from: 'instance-b',
        to: 'borot',
        request_id: '123e4567-e89b-42d3-a456-426614174000',
        text: 'run this',
      },
      'Bearer wrong-secret',
      runner,
      dataDir
    );
    expect(result.status).toBe(401);
    expect(runner.runStream).not.toHaveBeenCalled();
  });

  it('reuses one regular Web session per peer to preserve conversation context', async () => {
    let turn = 0;
    const runner = {
      runStream: vi.fn(async (_prompt, callbacks, options) => {
        turn += 1;
        if (turn === 1) expect(options?.sessionId).toBeUndefined();
        if (turn === 2) expect(options?.sessionId).toBe('provider-session-1');
        const result = { result: `answer ${turn}`, sessionId: `provider-session-${turn}` };
        callbacks.onComplete?.(result);
        return result;
      }),
    } as unknown as AgentRunner;
    const request = (suffix: string) => ({
      from: 'instance-b',
      to: 'borot',
      request_id: `123e4567-e89b-42d3-a456-42661417400${suffix}`,
      text: `question ${suffix}`,
    });

    const first = await processDirectedHttpRequest(
      request('0'),
      'Bearer shared-secret',
      runner,
      dataDir
    );
    const second = await processDirectedHttpRequest(
      request('1'),
      'Bearer shared-secret',
      runner,
      dataDir
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.session_id).toBe(second.body.session_id);
    expect(getSessionEntry(first.body.session_id!)?.scope).toBe('interactive');
    expect(getSessionEntry(first.body.session_id!)?.messageCount).toBe(2);
  });
});

describe('inter-instance HTTP configuration', () => {
  afterEach(() => {
    delete process.env.INTER_INSTANCE_CHAT_ENABLED;
    delete process.env.INTER_INSTANCE_CHAT_TOKEN;
    delete process.env.INTER_INSTANCE_CHAT_PEERS;
    delete process.env.INTER_INSTANCE_CHAT_ALLOWED_PEERS;
    delete process.env.INTER_INSTANCE_CHAT_TRANSPORT;
    delete process.env.XANGI_INSTANCE_ID;
    delete process.env.XANGI_INSTANCE_LABEL;
    _resetInterChatConfigForTest();
  });

  it('defaults to disabled with no peers or token', () => {
    _resetInterChatConfigForTest();
    const config = getInterChatConfig();
    expect(config.enabled).toBe(false);
    expect(config.peers).toEqual({});
    expect(config.token).toBe('');
    expect(config.allowedPeers).toBeNull();
  });

  it('normalizes peer origins and inbound allowlists', () => {
    process.env.INTER_INSTANCE_CHAT_ENABLED = 'true';
    process.env.XANGI_INSTANCE_ID = 'borot-test';
    process.env.XANGI_INSTANCE_LABEL = 'borot';
    process.env.INTER_INSTANCE_CHAT_TOKEN = 'test-secret';
    process.env.INTER_INSTANCE_CHAT_PEERS = JSON.stringify({
      'instance-a': 'http://100.64.0.1:18888/',
      invalid: 'http://100.64.0.2:18888/path',
    });
    process.env.INTER_INSTANCE_CHAT_ALLOWED_PEERS = ' instance-a, instance-b,instance-b ';
    _resetInterChatConfigForTest();

    const config = getInterChatConfig();
    expect(config.selfInstanceId).toBe('borot-test');
    expect(config.selfLabel).toBe('borot');
    expect(config.peers).toEqual({ 'instance-a': 'http://100.64.0.1:18888' });
    expect(config.allowedPeers).toEqual(['instance-a', 'instance-b']);
  });

  it('warns when the removed JSONL transport remains configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.INTER_INSTANCE_CHAT_TRANSPORT = 'jsonl';
    _resetInterChatConfigForTest();

    getInterChatConfig();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('jsonl is no longer supported'));
    warn.mockRestore();
  });
});
