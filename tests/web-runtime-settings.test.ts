import { parse } from 'dotenv';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from '../src/agent-runner.js';
import { BackendResolver } from '../src/backend-resolver.js';
import type { AgentBackend, Config, EffortLevel } from '../src/config.js';
import { clearSettingsCache, initSettings, loadSettings } from '../src/settings.js';
import {
  updateWebRuntimeSetting,
  webChannelRuntimeSettingsSnapshot,
  webRuntimeSettingsSnapshot,
} from '../src/web-runtime-settings.js';

describe('Web runtime settings', () => {
  let tempDir: string;
  let config: Config;
  let resolver: BackendResolver;
  let current: { backend: AgentBackend; model?: string; effort?: EffortLevel };
  const switchDefaultBackend = vi.fn();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'web-runtime-settings-'));
    initSettings(tempDir);
    process.env.XANGI_ENV_PATH = join(tempDir, '.env');
    writeFileSync(
      process.env.XANGI_ENV_PATH,
      'AGENT_BACKEND=codex\nRESPOND_TO_BOTS_ENABLED=false\n'
    );
    current = { backend: 'codex' };
    resolver = {
      getDefault: () => current,
      getSelectableBackends: () => ['codex', 'claude-code'],
      isBackendSelectable: (backend: AgentBackend) => ['codex', 'claude-code'].includes(backend),
      setDefault: (backend: AgentBackend, model?: string, effort?: EffortLevel) => {
        current = { backend, model, effort };
      },
    } as unknown as BackendResolver;
    config = {
      features: { backendSwitching: true, runtimeSettings: true },
      agent: {},
      discord: {
        replySuggestions: true,
        respondToBotsEnabled: false,
        allowRespondToBotsCommand: true,
      },
      slack: { replySuggestions: false },
      web: { replySuggestions: true, replySuggestionCount: 3 },
    } as Config;
    switchDefaultBackend.mockReset();
  });

  afterEach(() => {
    delete process.env.XANGI_ENV_PATH;
    clearSettingsCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes values with explicit apply timing', () => {
    expect(webRuntimeSettingsSnapshot(config, resolver)).toEqual({
      backend: {
        enabled: true,
        value: { backend: 'codex' },
        options: ['codex', 'claude-code'],
        applyMode: 'next-turn',
      },
      replySuggestions: {
        enabled: true,
        value: 'inherit',
        effective: { discord: true, slack: false, web: true },
        applyMode: 'immediate',
      },
      respondToBots: { enabled: true, value: false, applyMode: 'immediate' },
    });
  });

  it('uses the shared dispatcher for immediate settings', async () => {
    const message = await updateWebRuntimeSetting(
      { name: 'replysuggestions', action: 'set', value: 'off' },
      {
        config,
        resolver,
        agentRunner: { switchDefaultBackend } as unknown as AgentRunner,
      }
    );

    expect(message).toContain('即時反映済み');
    expect(loadSettings().replySuggestionsEnabled).toBe(false);
  });

  it('exposes every shared runtime setting and keeps explicit scope', async () => {
    await updateWebRuntimeSetting(
      {
        name: 'autoreply',
        action: 'set',
        value: 'on',
        platform: 'discord',
        channelId: '123',
      },
      {
        config,
        resolver,
        agentRunner: { switchDefaultBackend } as unknown as AgentRunner,
      }
    );
    expect(loadSettings().discordAutoReplyChannels).toEqual({ '123': true });

    await expect(
      updateWebRuntimeSetting(
        { name: 'unknown', action: 'set', value: 'on' },
        {
          config,
          resolver,
          agentRunner: { switchDefaultBackend } as unknown as AgentRunner,
        }
      )
    ).rejects.toThrow('Web設定から変更できない項目です');

    await updateWebRuntimeSetting(
      { name: 'backend', action: 'set', backend: 'claude-code' },
      {
        config,
        resolver,
        agentRunner: { switchDefaultBackend } as unknown as AgentRunner,
      }
    );
    expect(current.backend).toBe('claude-code');
    expect(switchDefaultBackend).toHaveBeenCalledOnce();
  });

  it('exposes saved channel overrides and their effective values', async () => {
    resolver = {
      getDefault: () => ({ backend: 'codex' }),
      getChannelOverride: () => ({ backend: 'claude-code', localLlmMode: 'chat' }),
      resolve: () => ({
        backend: 'claude-code',
        model: 'sonnet',
        effort: 'high',
        localLlmMode: 'chat',
      }),
    } as unknown as BackendResolver;
    await updateWebRuntimeSetting(
      { name: 'autoreply', action: 'set', value: 'off', platform: 'discord', channelId: '123' },
      { config, resolver, agentRunner: {} as AgentRunner }
    );

    expect(webChannelRuntimeSettingsSnapshot('discord', '123', config, resolver)).toEqual({
      agent: null,
      team: null,
      backend: {
        value: 'claude-code',
        effective: { backend: 'claude-code', model: 'sonnet', effort: 'high' },
      },
      llmMode: { value: 'chat', effective: 'chat' },
      autoReply: { value: 'off', effective: 'off' },
      notify: { value: 'inherit', effective: 'message' },
      threadMode: { value: 'inherit', effective: 'off' },
    });
  });
  it('persists channel model, reasoning and mode through the Web API dispatcher and resolver reload', async () => {
    const old = process.env.CHANNEL_OVERRIDES;
    delete process.env.CHANNEL_OVERRIDES;
    try {
      config.agent = {
        ...config.agent,
        config: {},
        backend: 'codex',
        allowedBackends: ['codex', 'openrouter'],
      };
      const real = new BackendResolver(config);
      const deps = {
        config,
        resolver: real,
        agentRunner: {} as AgentRunner,
        modelDiscovery: async () => ({
          backend: 'openrouter' as const,
          source: 'test',
          status: 'available' as const,
          models: [{ id: 'vendor/model', supportedEfforts: ['low', 'high'] }],
        }),
      };
      const input = {
        name: 'backend',
        action: 'set',
        scope: 'channel',
        channelId: 'C1',
        platform: 'slack',
        backend: 'openrouter',
        model: 'vendor/model',
        localLlmReasoningEffort: 'high',
        localLlmMode: 'chat',
      };
      await updateWebRuntimeSetting(input, deps);
      process.env.CHANNEL_OVERRIDES = parse(
        readFileSync(process.env.XANGI_ENV_PATH!)
      ).CHANNEL_OVERRIDES;
      const reloaded = new BackendResolver(config);
      expect(reloaded.resolve('C1')).toMatchObject({
        backend: 'openrouter',
        model: 'vendor/model',
        localLlmReasoningEffort: 'high',
        localLlmMode: 'chat',
      });
      expect(reloaded.resolve('C2').backend).toBe('codex');
      expect(
        webChannelRuntimeSettingsSnapshot('slack', 'C1', config, reloaded).backend
      ).toMatchObject({ model: 'vendor/model', localLlmReasoningEffort: 'high' });
      await expect(
        updateWebRuntimeSetting({ ...input, localLlmReasoningEffort: 'medium' }, deps)
      ).rejects.toThrow();
      expect(real.resolve('C1').localLlmReasoningEffort).toBe('high');
      await updateWebRuntimeSetting({ ...input, action: 'reset' }, deps);
      delete process.env.CHANNEL_OVERRIDES;
      expect(parse(readFileSync(process.env.XANGI_ENV_PATH!)).CHANNEL_OVERRIDES).toBeUndefined();
      expect(new BackendResolver(config).resolve('C1').backend).toBe('codex');
    } finally {
      if (old === undefined) delete process.env.CHANNEL_OVERRIDES;
      else process.env.CHANNEL_OVERRIDES = old;
    }
  });
});
