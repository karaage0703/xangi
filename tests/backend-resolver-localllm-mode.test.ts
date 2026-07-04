import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BackendResolver } from '../src/backend-resolver.js';
import type { Config } from '../src/config.js';

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
      allowedBackends: ['local-llm', 'claude-code'],
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
  });

  it('CHANNEL_OVERRIDES から localLlmMode を読み込める', () => {
    process.env.CHANNEL_OVERRIDES = JSON.stringify({
      ch1: { backend: 'local-llm', localLlmMode: 'agent' },
      ch2: { backend: 'local-llm', localLlmMode: 'lite' },
    });
    const resolver = new BackendResolver(makeConfig());

    expect(resolver.resolve('ch1').localLlmMode).toBe('agent');
    expect(resolver.resolve('ch2').localLlmMode).toBe('lite');
    expect(resolver.resolve('ch_unknown').localLlmMode).toBeUndefined();
  });

  it('setChannelLocalLlmMode で個別に設定できる', () => {
    const resolver = new BackendResolver(makeConfig());
    resolver.setChannelLocalLlmMode('ch1', 'lite');
    expect(resolver.resolve('ch1').localLlmMode).toBe('lite');

    // 上書き
    resolver.setChannelLocalLlmMode('ch1', 'chat');
    expect(resolver.resolve('ch1').localLlmMode).toBe('chat');
  });

  it('setChannelLocalLlmMode(null) で削除できる', () => {
    const resolver = new BackendResolver(makeConfig());
    resolver.setChannelLocalLlmMode('ch1', 'lite');
    resolver.setChannelLocalLlmMode('ch1', null);
    expect(resolver.resolve('ch1').localLlmMode).toBeUndefined();
  });

  it('既存の backend/model がある時、localLlmMode のみ更新できる', () => {
    process.env.CHANNEL_OVERRIDES = JSON.stringify({
      ch1: { backend: 'local-llm', model: 'gemma4', localLlmMode: 'agent' },
    });
    const resolver = new BackendResolver(makeConfig());

    resolver.setChannelLocalLlmMode('ch1', 'lite');
    const r = resolver.resolve('ch1');
    expect(r.localLlmMode).toBe('lite');
    expect(r.backend).toBe('local-llm');
    expect(r.model).toBe('gemma4');
  });

  it('localLlmMode のみのエントリで mode を null にすると entry 自体が削除される', () => {
    const resolver = new BackendResolver(makeConfig());
    resolver.setChannelLocalLlmMode('ch1', 'lite');
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
      ch1: { localLlmMode: 'lite' },
    });
    const resolver = new BackendResolver(makeConfig());
    const r = resolver.resolve('ch1');
    expect(r.localLlmMode).toBe('lite');
  });

  it('request default を CHANNEL_OVERRIDES より低い優先度で適用できる', () => {
    process.env.CHANNEL_OVERRIDES = JSON.stringify({
      ch1: { backend: 'claude-code', localLlmMode: 'agent' },
      ch2: { localLlmMode: 'lite' },
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
      localLlmMode: 'lite',
    });
  });
});
