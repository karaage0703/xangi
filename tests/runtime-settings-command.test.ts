import { initSessions, clearSessions, createSession, getSessionEntry } from '../src/sessions.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendResolver, ChannelOverride } from '../src/backend-resolver.js';
import type { AgentBackend, Config, EffortLevel } from '../src/config.js';
import { clearSettingsCache, initSettings, loadSettings } from '../src/settings.js';
import { executeRuntimeSettingsCommand } from '../src/runtime-settings-command.js';

describe('runtime_settings', () => {
  let tempDir: string;
  let overrides: Map<string, ChannelOverride>;
  let resolver: BackendResolver;
  let config: Config;
  let defaultBackend: AgentBackend;
  let defaultModel: string | undefined;
  let defaultEffort: EffortLevel | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'runtime-settings-'));
    initSettings(tempDir);
    initSessions(tempDir);
    writeFileSync(join(tempDir, '.env'), 'RESPOND_TO_BOTS_ENABLED=false\n');
    process.env.XANGI_ENV_PATH = join(tempDir, '.env');
    overrides = new Map();
    defaultBackend = 'codex';
    defaultModel = undefined;
    defaultEffort = undefined;
    resolver = {
      getAllowedBackends: () => ['codex', 'local-llm', 'workspace-search'] as AgentBackend[],
      getSelectableBackends: () => ['codex', 'local-llm', 'workspace-search'] as AgentBackend[],
      isBackendAllowed: (backend: AgentBackend) =>
        ['codex', 'local-llm', 'workspace-search'].includes(backend),
      isBackendSelectable: (backend: AgentBackend) =>
        ['codex', 'local-llm', 'workspace-search'].includes(backend),
      getDefault: () => ({ backend: defaultBackend, model: defaultModel, effort: defaultEffort }),
      getChannelOverride: (channelId: string) => overrides.get(channelId),
      resolve: (channelId?: string) => ({
        backend: overrides.get(channelId ?? '')?.backend ?? defaultBackend,
        model: overrides.get(channelId ?? '')?.model ?? defaultModel,
        effort: overrides.get(channelId ?? '')?.effort,
        localLlmMode: overrides.get(channelId ?? '')?.localLlmMode,
      }),
      setChannelOverride: vi.fn((channelId: string, override: ChannelOverride) => {
        overrides.set(channelId, override);
      }),
      deleteChannelOverride: vi.fn((channelId: string) => overrides.delete(channelId)),
      setDefault: vi.fn((backend: AgentBackend, model?: string, effort?: EffortLevel) => {
        defaultBackend = backend;
        defaultModel = model;
        defaultEffort = effort;
      }),
      setChannelLocalLlmMode: vi.fn((channelId: string, mode: 'agent' | 'chat' | null) => {
        const current = { ...(overrides.get(channelId) ?? {}) };
        if (mode === null) delete current.localLlmMode;
        else current.localLlmMode = mode;
        overrides.set(channelId, current);
      }),
    } as unknown as BackendResolver;
    config = {
      agent: {},
      discord: {
        completionNotifyMode: 'message',
        replyInThread: false,
        replySuggestions: false,
        respondToBotsEnabled: false,
      },
      slack: { autoReplyChannels: ['CDEFAULT'], replySuggestions: false },
      web: { replySuggestions: false, replySuggestionCount: 3 },
    } as Config;
  });

  afterEach(() => {
    delete process.env.XANGI_ENV_PATH;
    clearSettingsCache();
    clearSessions();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads exact thread evidence independently of parent settings and recovered snapshots', async () => {
    const parent = createSession('parent', { platform: 'discord' });
    const thread = createSession('thread', { platform: 'discord' });
    getSessionEntry(parent)!.agent = { backend: 'codex', model: 'unrelated-parent-model' };
    getSessionEntry(thread)!.modelHistory = [
      {
        turnId: 'old-turn',
        backend: 'codex',
        observedModels: ['historical-model'],
        effectiveModel: 'historical-model',
        effectiveEffort: 'medium',
        effortSource: 'provider',
        source: 'provider',
        startedAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:01Z',
        status: 'completed',
      },
    ];
    const result = await executeRuntimeSettingsCommand(
      {
        name: 'backend',
        action: 'show',
        channelId: 'parent',
        contextKey: 'thread',
        platform: 'discord',
      },
      { config, resolver }
    );
    expect(result).toContain('historical-model');
    expect(result).toContain('effort=medium');
    expect(result).not.toContain('unrelated-parent-model');
    const unspecified = await executeRuntimeSettingsCommand(
      { name: 'backend', action: 'show', channelId: 'parent', platform: 'discord' },
      { config, resolver }
    );
    expect(unspecified).toContain('記録なし');
    expect(unspecified).toContain('effort (設定): default（バックエンドに委任）');
    expect(unspecified).not.toContain('unrelated-parent-model');
  });

  it('always shows the resolved effort setting', async () => {
    overrides.set('C123', { backend: 'codex', model: 'gpt-5.6-sol', effort: 'medium' });

    const result = await executeRuntimeSettingsCommand(
      { name: 'backend', action: 'show', channelId: 'C123', platform: 'discord' },
      { config, resolver }
    );

    expect(result).toContain('effort (設定): medium');
  });

  it('switches to a model-less backend for the next turn', async () => {
    const result = await executeRuntimeSettingsCommand(
      {
        name: 'backend',
        action: 'set',
        backend: 'workspace-search',
        channelId: 'C123',
        platform: 'slack',
      },
      { config, resolver }
    );

    expect(resolver.setChannelOverride).toHaveBeenCalledWith('C123', {
      backend: 'workspace-search',
      model: undefined,
      effort: undefined,
    });
    expect(result).toContain('次のturnから適用');
  });

  it('updates the global default without requiring a channel and preserves overrides', async () => {
    overrides.set('C123', { backend: 'local-llm', model: 'local-model' });
    const switchDefaultBackend = vi.fn();
    const modelDiscovery = vi.fn().mockResolvedValue({
      backend: 'codex',
      source: 'test source',
      status: 'available',
      models: [
        {
          id: 'gpt-new',
          isDefault: true,
          supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
        },
      ],
    });

    const result = await executeRuntimeSettingsCommand(
      {
        name: 'backend',
        action: 'set',
        backend: 'codex',
        model: 'gpt-new',
        effort: 'medium',
        scope: 'global',
        platform: 'discord',
      },
      { resolver, modelDiscovery, agentRunner: { switchDefaultBackend } as never }
    );

    expect(resolver.setDefault).toHaveBeenCalledWith('codex', 'gpt-new', 'medium');
    expect(switchDefaultBackend).toHaveBeenCalledOnce();
    expect(overrides.get('C123')).toEqual({ backend: 'local-llm', model: 'local-model' });
    expect(result).toContain('次のturnから適用');
    expect(result).toContain('effort: medium');
    expect(result).toContain('channel override: 維持');
  });

  it('shows the global default without a channel or runner', async () => {
    defaultModel = 'gpt-global';
    defaultEffort = 'high';
    await expect(
      executeRuntimeSettingsCommand(
        { name: 'backend', action: 'show', scope: 'global' },
        { resolver }
      )
    ).resolves.toContain('effort: high');
  });

  it('uses the selected model effort capabilities when saving a backend override', async () => {
    const modelDiscovery = vi.fn().mockResolvedValue({
      backend: 'codex',
      source: 'test source',
      status: 'available',
      models: [
        {
          id: 'gpt-frontier',
          isDefault: true,
          supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        },
        { id: 'gpt-compact', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
      ],
    });

    await executeRuntimeSettingsCommand(
      {
        name: 'backend',
        action: 'set',
        backend: 'codex',
        model: 'gpt-frontier',
        effort: 'ultra',
        channelId: 'C123',
        platform: 'discord',
      },
      { config, resolver, modelDiscovery }
    );
    expect(resolver.setChannelOverride).toHaveBeenCalledWith('C123', {
      backend: 'codex',
      model: 'gpt-frontier',
      effort: 'ultra',
    });

    await executeRuntimeSettingsCommand(
      {
        name: 'backend',
        action: 'set',
        backend: 'codex',
        effort: 'xhigh',
        channelId: 'C123',
        platform: 'discord',
      },
      { config, resolver, modelDiscovery }
    );
    expect(resolver.setChannelOverride).toHaveBeenLastCalledWith('C123', {
      backend: 'codex',
      model: undefined,
      effort: 'xhigh',
    });

    await expect(
      executeRuntimeSettingsCommand(
        {
          name: 'backend',
          action: 'set',
          backend: 'codex',
          model: 'gpt-compact',
          effort: 'max',
          channelId: 'C123',
          platform: 'discord',
        },
        { config, resolver, modelDiscovery }
      )
    ).rejects.toThrow("model 'gpt-compact' supports effort: low, medium, high, xhigh");
  });

  it('rejects an effort unsupported by the selected global model', async () => {
    const modelDiscovery = vi.fn().mockResolvedValue({
      backend: 'codex',
      source: 'test source',
      status: 'available',
      models: [{ id: 'gpt-compact', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] }],
    });

    await expect(
      executeRuntimeSettingsCommand(
        {
          name: 'backend',
          action: 'set',
          backend: 'codex',
          model: 'gpt-compact',
          effort: 'max',
          scope: 'global',
        },
        { resolver, modelDiscovery, agentRunner: { switchDefaultBackend: vi.fn() } as never }
      )
    ).rejects.toThrow("model 'gpt-compact' supports effort: low, medium, high, xhigh");
    expect(resolver.setDefault).not.toHaveBeenCalled();
  });

  it('changes Slack autoreply immediately and persists a channel override', async () => {
    await executeRuntimeSettingsCommand(
      {
        name: 'autoreply',
        action: 'set',
        value: 'on',
        channelId: 'C123',
        platform: 'slack',
      },
      { config, resolver }
    );

    expect(loadSettings().slackAutoReplyChannels).toEqual({ C123: true });
  });

  it('shows and restores the inherited parent autoreply value for a Discord thread', async () => {
    await executeRuntimeSettingsCommand(
      {
        name: 'autoreply',
        action: 'set',
        value: 'on',
        channelId: 'parent-123',
        platform: 'discord',
      },
      { config, resolver }
    );

    const threadRequest = {
      name: 'autoreply',
      channelId: 'thread-456',
      parentChannelId: 'parent-123',
      platform: 'discord',
    };
    await expect(
      executeRuntimeSettingsCommand({ ...threadRequest, action: 'show' }, { config, resolver })
    ).resolves.toContain('autoreply: on');

    await executeRuntimeSettingsCommand(
      { ...threadRequest, action: 'set', value: 'off' },
      { config, resolver }
    );
    await expect(
      executeRuntimeSettingsCommand({ ...threadRequest, action: 'show' }, { config, resolver })
    ).resolves.toContain('autoreply: off');

    await expect(
      executeRuntimeSettingsCommand({ ...threadRequest, action: 'reset' }, { config, resolver })
    ).resolves.toContain('autoreplyをonに設定しました');
    expect(loadSettings().discordAutoReplyChannels).toEqual({ 'parent-123': true });
  });

  it('supports every existing runtime mode with explicit, idempotent actions', async () => {
    const requests = [
      { name: 'llmmode', value: 'agent', platform: 'slack' },
      { name: 'autoreply', value: 'on', platform: 'discord' },
      { name: 'notify', value: 'mention', platform: 'discord' },
      { name: 'threadmode', value: 'on', platform: 'discord' },
      { name: 'replysuggestions', value: 'on', platform: 'slack' },
      { name: 'respondtobots', value: 'on', platform: 'discord' },
    ];
    for (const request of requests) {
      await executeRuntimeSettingsCommand(
        { ...request, action: 'set', channelId: '123' },
        { config, resolver }
      );
    }

    const settings = loadSettings();
    expect(settings.discordAutoReplyChannels?.['123']).toBe(true);
    expect(settings.discordCompletionNotifyChannels?.['123']).toBe('mention');
    expect(settings.discordThreadModeChannels?.['123']).toBe(true);
    expect(settings.replySuggestionsEnabled).toBe(true);
    expect(config.discord.respondToBotsEnabled).toBe(true);
    expect(overrides.get('123')?.localLlmMode).toBe('agent');
  });

  it('rejects Discord-only settings on Slack', async () => {
    await expect(
      executeRuntimeSettingsCommand(
        {
          name: 'threadmode',
          action: 'set',
          value: 'on',
          channelId: 'C123',
          platform: 'slack',
        },
        { config, resolver }
      )
    ).rejects.toThrow('slack is not supported');
  });

  it('rejects the removed lite Local LLM mode', async () => {
    await expect(
      executeRuntimeSettingsCommand(
        {
          name: 'llmmode',
          action: 'set',
          value: 'lite',
          channelId: '123',
          platform: 'slack',
        },
        { config, resolver }
      )
    ).rejects.toThrow('must be one of: agent, chat');
  });

  it('honors the Discord llmmode command permission', async () => {
    config.discord.allowLlmModeCommand = false;

    await expect(
      executeRuntimeSettingsCommand(
        {
          name: 'llmmode',
          action: 'set',
          value: 'chat',
          channelId: '123',
          platform: 'discord',
        },
        { config, resolver }
      )
    ).rejects.toThrow('this command is disabled');
  });
});
