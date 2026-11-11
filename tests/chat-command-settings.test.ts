import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeChatSettings } from '../src/chat-command-settings.js';
import { initSettings, clearSettingsCache, loadSettings } from '../src/settings.js';
import type { Config } from '../src/config.js';
import type { BackendResolver } from '../src/backend-resolver.js';

describe('consolidated chat settings', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'chat-settings-'));
    initSettings(directory);
  });
  afterEach(() => {
    clearSettingsCache();
    rmSync(directory, { recursive: true, force: true });
  });
  const config = { features: {}, discord: {}, web: {}, slack: {} } as Config;

  it('moves notification changes under settings while preserving channel scope', async () => {
    const dependencies = { config, resolver: {} as BackendResolver };
    const context = { platform: 'discord' as const, channelId: 'parent-channel' };
    await executeChatSettings('notify', 'mention', context, dependencies);
    expect(loadSettings().discordCompletionNotifyChannels).toEqual({ 'parent-channel': 'mention' });
    expect(await executeChatSettings('notify', undefined, context, dependencies)).toContain(
      'mention'
    );
    await executeChatSettings('notify', 'default', context, dependencies);
    expect(loadSettings().discordCompletionNotifyChannels?.['parent-channel']).toBeUndefined();
    await expect(
      executeChatSettings(
        'notify',
        'mention',
        { platform: 'web', channelId: 'web-chat:one' },
        dependencies
      )
    ).rejects.toThrow();
  });

  it('keeps Web session mode and Local LLM effort accessible after standalone command removal', async () => {
    const setChannelLocalLlmMode = vi.fn();
    const setChannelOverride = vi.fn();
    const resolver = {
      resolve: () => ({
        backend: 'local-llm',
        model: 'test-model',
        localLlmMode: 'agent',
        localLlmReasoningEffort: 'high',
      }),
      isBackendSelectable: () => true,
      getChannelOverride: () => ({
        backend: 'local-llm',
        model: 'test-model',
        localLlmMode: 'agent',
        localLlmReasoningEffort: 'high',
      }),
      setChannelLocalLlmMode,
      setChannelOverride,
    } as unknown as BackendResolver;
    const dependencies = { config, resolver };
    const context = { platform: 'web' as const, channelId: 'web-chat:one' };
    await executeChatSettings('llmmode', 'chat', context, dependencies);
    expect(setChannelLocalLlmMode).toHaveBeenCalledWith('web-chat:one', 'chat');
    await executeChatSettings('llmeffort', 'low', context, dependencies);
    expect(setChannelOverride).toHaveBeenLastCalledWith(
      'web-chat:one',
      expect.objectContaining({ model: 'test-model', localLlmReasoningEffort: 'low' })
    );
    await executeChatSettings('llmeffort', 'default', context, dependencies);
    expect(setChannelOverride).toHaveBeenLastCalledWith(
      'web-chat:one',
      expect.objectContaining({ localLlmReasoningEffort: undefined })
    );
    await expect(
      executeChatSettings('llmeffort', 'invalid', context, dependencies)
    ).rejects.toThrow();
  });
});
