import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunner } from '../src/agent-runner.js';
import {
  askAgent,
  processDirectedHttpRequest,
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
