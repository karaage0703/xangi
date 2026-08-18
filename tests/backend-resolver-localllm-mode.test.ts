import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BackendResolver } from '../src/backend-resolver.js';
import type { Config } from '../src/config.js';
import { installExtensionBackendFixture } from './helpers/extension-backend.js';

const originalExtensionsFile = process.env.XANGI_EXTENSIONS_FILE;

function makeConfig(): Config {
  return {
    discord: {
      enabled: false,
      replyInThread: false,
      streaming: false,
      showThinking: false,
      tagOnlyAutoReply: false,
      autoReplyOverrides: new Map(),
      bridge: { enabled: false },
      respondToBots: [],
      respondToBotsEnabled: false,
      respondToBotsMaxConsecutive: 3,
      allowRespondToBotsCommand: true,
      allowLlmModeCommand: true,
    },
    slack: {
      enabled: false,
      autoReplyChannels: [],
      replyInThread: false,
      streaming: false,
      showThinking: false,
      tagOnlyAutoReply: false,
      autoReplyOverrides: new Map(),
    },
    web: { enabled: false, port: 0 },
    persistent: false,
    transcriptDir: '/tmp',
    sessionsPath: '/tmp/sessions.json',
    schedulerPath: '/tmp/schedules.json',
    scheduler: { enabled: false, intervalMs: 60_000 },
    workdir: '/tmp',
    skipPermissions: false,
    agent: {
      backend: 'local-llm',
      config: {},
      allowedBackends: ['local-llm', 'claude-code', 'workspace-search'],
    },
  } as unknown as Config;
}

describe('BackendResolver localLlmMode', () => {
  let tmpDir: string;
  let envFile: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'br-test-'));
    envFile = join(tmpDir, '.env');
    writeFileSync(envFile, '# test env\n');
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CHANNEL_OVERRIDES;
    delete process.env.WORKSPACE_SEARCH_RAG_URL;
    delete process.env.ALLOWED_BACKENDS;
    if (originalExtensionsFile === undefined) delete process.env.XANGI_EXTENSIONS_FILE;
    else process.env.XANGI_EXTENSIONS_FILE = originalExtensionsFile;
  });

  it('利用できない extension backend を選択候補から除外する', () => {
    process.env.ALLOWED_BACKENDS = 'local-llm,claude-code,workspace-search';
    const resolver = new BackendResolver(makeConfig(), {
      backendAvailable: (backend) => backend !== 'workspace-search',
    });

    expect(resolver.getAllowedBackends()).toContain('workspace-search');
    expect(resolver.getSelectableBackends()).not.toContain('workspace-search');
    expect(resolver.isBackendSelectable('workspace-search')).toBe(false);
  });

  it('extension backend が利用可能になれば動的に選択候補へ追加する', () => {
    process.env.ALLOWED_BACKENDS = 'local-llm,claude-code,workspace-search';
    let available = false;
    const resolver = new BackendResolver(makeConfig(), {
      backendAvailable: (backend) => backend !== 'workspace-search' || available,
    });

    expect(resolver.getSelectableBackends()).not.toContain('workspace-search');
    available = true;
    expect(resolver.getSelectableBackends()).toContain('workspace-search');
  });

  it('許可一覧が未指定ならlink後のextension backendを再起動なしで追加する', async () => {
    const resolver = new BackendResolver(makeConfig());
    expect(resolver.getSelectableBackends()).not.toContain('new-extension-backend');

    await installExtensionBackendFixture('new-extension-backend', 'New extension');

    expect(resolver.getAllowedBackends()).toContain('new-extension-backend');
    expect(resolver.getSelectableBackends()).toContain('new-extension-backend');
    resolver.setChannelOverride('extension-channel', { backend: 'new-extension-backend' });
    expect(resolver.resolve('extension-channel').sessionMode).toBe('stateless');
  });

  it('CHANNEL_OVERRIDES から localLlmMode を読み込める', () => {
    process.env.CHANNEL_OVERRIDES = JSON.stringify({
      ch1: { backend: 'local-llm', localLlmMode: 'agent' },
      ch2: { backend: 'local-llm', localLlmMode: 'chat' },
    });
    const resolver = new BackendResolver(makeConfig());

    expect(resolver.resolve('ch1').localLlmMode).toBe('agent');
    expect(resolver.resolve('ch2').localLlmMode).toBe('chat');
    expect(resolver.resolve('ch_unknown').localLlmMode).toBeUndefined();
  });

  it('setChannelLocalLlmMode で個別に設定できる', () => {
    const resolver = new BackendResolver(makeConfig());
    resolver.setChannelLocalLlmMode('ch1', 'agent');
    expect(resolver.resolve('ch1').localLlmMode).toBe('agent');

    // 上書き
    resolver.setChannelLocalLlmMode('ch1', 'chat');
    expect(resolver.resolve('ch1').localLlmMode).toBe('chat');
  });

  it('setChannelLocalLlmMode(null) で削除できる', () => {
    const resolver = new BackendResolver(makeConfig());
    resolver.setChannelLocalLlmMode('ch1', 'agent');
    resolver.setChannelLocalLlmMode('ch1', null);
    expect(resolver.resolve('ch1').localLlmMode).toBeUndefined();
  });

  it('既存の backend/model がある時、localLlmMode のみ更新できる', () => {
    process.env.CHANNEL_OVERRIDES = JSON.stringify({
      ch1: { backend: 'local-llm', model: 'gemma4', localLlmMode: 'agent' },
    });
    const resolver = new BackendResolver(makeConfig());

    resolver.setChannelLocalLlmMode('ch1', 'chat');
    const r = resolver.resolve('ch1');
    expect(r.localLlmMode).toBe('chat');
    expect(r.backend).toBe('local-llm');
    expect(r.model).toBe('gemma4');
  });

  it('localLlmMode のみのエントリで mode を null にすると entry 自体が削除される', () => {
    const resolver = new BackendResolver(makeConfig());
    resolver.setChannelLocalLlmMode('ch1', 'agent');
    resolver.setChannelLocalLlmMode('ch1', null);
    expect(resolver.getChannelOverride('ch1')).toBeUndefined();
  });

  it('setChannelLocalLlmMode は .env に永続化する', () => {
    const resolver = new BackendResolver(makeConfig());
    resolver.setChannelLocalLlmMode('ch1', 'agent');

    const envContent = readFileSync(envFile, 'utf-8');
    expect(envContent).toContain('CHANNEL_OVERRIDES=');
    expect(envContent).toContain('"localLlmMode":"agent"');
  });

  it('resolve() の戻り値に localLlmMode が含まれる', () => {
    process.env.CHANNEL_OVERRIDES = JSON.stringify({
      ch1: { localLlmMode: 'chat' },
    });
    const resolver = new BackendResolver(makeConfig());
    const r = resolver.resolve('ch1');
    expect(r.localLlmMode).toBe('chat');
  });

  it('default backend が非対応なら effort のみの環境設定を読み込まない', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CHANNEL_OVERRIDES = JSON.stringify({
      ch1: { effort: 'high' },
    });

    const resolver = new BackendResolver(makeConfig());

    expect(resolver.getChannelOverride('ch1')).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('effort'));
    errorSpy.mockRestore();
  });

  it('非対応backendのeffortをsetChannelOverrideで保存しない', () => {
    const resolver = new BackendResolver(makeConfig());

    expect(() =>
      resolver.setChannelOverride('ch1', { backend: 'local-llm', effort: 'high' })
    ).toThrow(/does not support effort/);
    expect(resolver.getChannelOverride('ch1')).toBeUndefined();
  });

  it('Cursor effort は明示モデルなしでは保存しない', () => {
    const resolver = new BackendResolver(makeConfig());

    expect(() => resolver.setChannelOverride('ch1', { backend: 'cursor', effort: 'high' })).toThrow(
      /requires an explicit model/
    );
    expect(resolver.getChannelOverride('ch1')).toBeUndefined();

    expect(() =>
      resolver.setChannelOverride('ch1', {
        backend: 'cursor',
        model: 'claude-opus-4-8',
        effort: 'high',
      })
    ).not.toThrow();
  });

  it('request default を CHANNEL_OVERRIDES より低い優先度で適用できる', () => {
    process.env.CHANNEL_OVERRIDES = JSON.stringify({
      ch1: { backend: 'claude-code', localLlmMode: 'agent' },
      ch2: { localLlmMode: 'agent' },
    });
    const resolver = new BackendResolver(makeConfig());

    const fallback = {
      backend: 'local-llm' as const,
      model: 'gemma-4-26b-a4b',
      localLlmMode: 'chat' as const,
    };

    expect(resolver.resolve('new-even-session', fallback)).toMatchObject({
      backend: 'local-llm',
      model: 'gemma-4-26b-a4b',
      localLlmMode: 'chat',
    });
    expect(resolver.resolve('ch1', fallback)).toMatchObject({
      backend: 'claude-code',
      localLlmMode: 'agent',
    });
    expect(resolver.resolve('ch2', fallback)).toMatchObject({
      backend: 'local-llm',
      model: 'gemma-4-26b-a4b',
      localLlmMode: 'agent',
    });
  });
});
