import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendResolver, ChannelOverride } from '../src/backend-resolver.js';
import type { AgentBackend, Config } from '../src/config.js';
import { clearSettingsCache, initSettings, loadSettings } from '../src/settings.js';
import { executeRuntimeSettingsCommand } from '../src/runtime-settings-command.js';

describe('runtime_settings', () => {
  let tempDir: string;
  let overrides: Map<string, ChannelOverride>;
  let resolver: BackendResolver;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'runtime-settings-'));
    initSettings(tempDir);
    writeFileSync(join(tempDir, '.env'), 'RESPOND_TO_BOTS_ENABLED=false\n');
    process.env.XANGI_ENV_PATH = join(tempDir, '.env');
    overrides = new Map();
    resolver = {
      getAllowedBackends: () => ['codex', 'local-llm', 'workspace-search'] as AgentBackend[],
      getSelectableBackends: () => ['codex', 'local-llm', 'workspace-search'] as AgentBackend[],
      getAllowedModels: () => undefined,
      isBackendAllowed: (backend: AgentBackend) =>
        ['codex', 'local-llm', 'workspace-search'].includes(backend),
      isBackendSelectable: (backend: AgentBackend) =>
        ['codex', 'local-llm', 'workspace-search'].includes(backend),
      isModelAllowed: () => true,
      getDefault: () => ({ backend: 'codex' as AgentBackend }),
      getChannelOverride: (channelId: string) => overrides.get(channelId),
      resolve: (channelId?: string) => ({
        backend: overrides.get(channelId ?? '')?.backend ?? ('codex' as AgentBackend),
        model: overrides.get(channelId ?? '')?.model,
        effort: overrides.get(channelId ?? '')?.effort,
        localLlmMode: overrides.get(channelId ?? '')?.localLlmMode,
      }),
      setChannelOverride: vi.fn((channelId: string, override: ChannelOverride) => {
        overrides.set(channelId, override);
      }),
      deleteChannelOverride: vi.fn((channelId: string) => overrides.delete(channelId)),
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
    rmSync(tempDir, { recursive: true, force: true });
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
      executeRuntimeSettingsCommand(
        { ...threadRequest, action: 'show' },
        { config, resolver }
      )
    ).resolves.toContain('autoreply: on');

    await executeRuntimeSettingsCommand(
      { ...threadRequest, action: 'set', value: 'off' },
      { config, resolver }
    );
    await expect(
      executeRuntimeSettingsCommand(
        { ...threadRequest, action: 'show' },
        { config, resolver }
      )
    ).resolves.toContain('autoreply: off');

    await expect(
      executeRuntimeSettingsCommand(
        { ...threadRequest, action: 'reset' },
        { config, resolver }
      )
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
