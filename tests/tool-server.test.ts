import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startToolServer, stopToolServer } from '../src/tool-server.js';
import type { BackendResolver } from '../src/backend-resolver.js';
import type { AgentBackend, Config } from '../src/config.js';

/**
 * tool-server のステータスコード退行検出テスト。
 *
 * 過去にバリデーションエラー（クライアント入力ミス）も内部例外も
 * 一律 HTTP 500 で返していた。今は ValidationError → 400、
 * その他 → 500 の区別がある。これが退行しないことを保証する。
 */
describe('tool-server HTTP status codes', () => {
  let serverUrl: string;
  const overrides = new Map<string, { backend: AgentBackend; model?: string }>();
  const resolver = {
    getAllowedBackends: () => ['codex', 'claude-code', 'workspace-search'] as AgentBackend[],
    getAllowedModels: () => undefined,
    isBackendAllowed: (backend: AgentBackend) =>
      backend === 'codex' || backend === 'claude-code' || backend === 'workspace-search',
    isModelAllowed: () => true,
    setChannelOverride: (channelId: string, override: { backend: AgentBackend; model?: string }) =>
      overrides.set(channelId, override),
    deleteChannelOverride: (channelId: string) => overrides.delete(channelId),
    getChannelOverride: (channelId: string) => overrides.get(channelId),
    getDefault: () => ({ backend: 'codex' as AgentBackend }),
    resolve: (channelId?: string) => overrides.get(channelId ?? '') ?? { backend: 'codex' as AgentBackend },
  } as BackendResolver;
  const config = {
    discord: { completionNotifyMode: 'message', replyInThread: false },
    slack: { autoReplyChannels: [] },
    web: { replySuggestions: false, replySuggestionCount: 3 },
  } as Config;

  beforeAll(() => {
    // 親シェルから引き継いだ XANGI_TOOL_SERVER を捨てる（実機xangiのURLを誤って叩かないため）
    delete process.env.XANGI_TOOL_SERVER;
    startToolServer({
      backendResolver: resolver,
      config,
      modelDiscovery: async (backend) =>
        backend === 'codex'
          ? {
              backend,
              source: 'test source',
              status: 'available',
              models: [{ id: 'gpt-test', supportedEfforts: ['high'] }],
            }
          : {
              backend,
              source: 'test source',
              status: 'unsupported',
              models: [],
              message: '取得非対応',
            },
      webStatusCommand: async () =>
        JSON.stringify({ enabled: true, chatUrls: ['http://localhost:18888'] }),
    });
    // listen() コールバック内で XANGI_TOOL_SERVER が再設定される。それを待つ
    return new Promise<void>((resolve) => {
      const wait = () => {
        if (process.env.XANGI_TOOL_SERVER) {
          serverUrl = process.env.XANGI_TOOL_SERVER;
          resolve();
        } else {
          setTimeout(wait, 10);
        }
      };
      wait();
    });
  });

  afterAll(() => {
    stopToolServer();
  });

  it('returns 400 for ValidationError (channel未指定 in discord_history)', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'discord_history',
        flags: { count: '3' },
        context: {}, // channelId 未指定
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('channel が未指定');
  });

  it('returns 400 for unknown command', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'discord_nonexistent',
        flags: {},
        context: {},
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toContain('Unknown discord command');
  });

  it('returns 400 for missing required flag (discord_send without --message)', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'discord_send',
        flags: { channel: '12345' }, // message 欠如
        context: {},
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toContain('--message is required');
  });

  it('returns 400 for missing required flag (slack_send without --message)', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'slack_send',
        flags: { channel: 'C12345' }, // message 欠如
        context: {},
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toContain('--message is required');
  });

  it('returns 400 when command is missing', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flags: {}, context: {} }),
    });

    expect(res.status).toBe(400);
  });

  it('returns command-specific help without backend state', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'help', flags: { topic: 'schedule_add' }, context: {} }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(body.ok).toBe(true);
    expect(body.result).toContain('Usage: xangi tool schedule_add');
  });

  it('returns the running instance Web UI status', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'web_status', flags: {}, context: {} }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(body.ok).toBe(true);
    expect(JSON.parse(body.result)).toEqual({
      enabled: true,
      chatUrls: ['http://localhost:18888'],
    });
  });

  it('returns 400 for unknown help topic', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'help', flags: { topic: 'missing' }, context: {} }),
    });

    expect(res.status).toBe(400);
  });

  it('lists every allowed backend when models has no backend', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'models', flags: {}, context: {} }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string };
    expect(body.result).toContain('gpt-test');
    expect(body.result).toContain('取得非対応');
  });

  it('changes a model-less backend through the shared runtime settings endpoint', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'runtime_settings',
        flags: { name: 'backend', action: 'set', backend: 'workspace-search' },
        context: { channelId: 'C123', platform: 'slack' },
      }),
    });

    expect(res.status).toBe(200);
    expect(overrides.get('C123')).toEqual({
      backend: 'workspace-search',
      model: undefined,
      effort: undefined,
    });
  });

  it('reports unsupported backend model discovery without hard-coded models', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'models',
        flags: { backend: 'claude-code' },
        context: {},
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(body.ok).toBe(true);
    expect(body.result).toContain('取得非対応');
    expect(body.result).not.toMatch(/sonnet|opus/i);
  });

  it('selects a discovered model for the next turn', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'models',
        flags: { backend: 'codex', use: 'gpt-test', effort: 'high' },
        context: { channelId: 'web-chat:test' },
      }),
    });

    expect(res.status).toBe(200);
    expect(overrides.get('web-chat:test')).toEqual({
      backend: 'codex',
      model: 'gpt-test',
      effort: 'high',
    });
  });

  it('does not accept the removed backend_models command', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'backend_models', flags: {}, context: {} }),
    });

    expect(res.status).toBe(400);
  });
});
