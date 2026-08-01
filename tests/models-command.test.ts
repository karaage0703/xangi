import { describe, expect, it, vi } from 'vitest';
import type { BackendResolver } from '../src/backend-resolver.js';
import type { AgentBackend } from '../src/config.js';
import type { BackendModelDiscovery } from '../src/backend-models.js';
import {
  executeModelsCommand,
  parseModelsCommand,
  selectModelForNextTurn,
} from '../src/models-command.js';

function createResolver(
  allowedBackends: AgentBackend[] = ['codex', 'cursor'],
  allowedModels?: string[]
): BackendResolver {
  return {
    getAllowedBackends: () => allowedBackends,
    getAllowedModels: () => allowedModels,
    isBackendAllowed: (backend: AgentBackend) => allowedBackends.includes(backend),
    isModelAllowed: (model: string) => !allowedModels || allowedModels.includes(model),
    setChannelOverride: vi.fn(),
  } as BackendResolver;
}

describe('/models common command', () => {
  it('parses the shared command with an optional backend and Telegram bot mention', () => {
    expect(parseModelsCommand('/models')).toBeUndefined();
    expect(parseModelsCommand('/models codex')).toBe('codex');
    expect(parseModelsCommand('/models@xangi_bot Cursor')).toBe('cursor');
    expect(parseModelsCommand('/model codex')).toBeNull();
  });

  it('discovers every allowed backend when no backend is specified', async () => {
    const discover = vi.fn(async (backend: AgentBackend): Promise<BackendModelDiscovery> => ({
      backend,
      source: `${backend} test source`,
      status: 'available',
      models: [{ id: `${backend}-model` }],
    }));

    const result = await executeModelsCommand(undefined, createResolver(), discover);

    expect(discover.mock.calls.map(([backend]) => backend)).toEqual(['codex', 'cursor']);
    expect(result).toContain('## 利用可能なモデル');
    expect(result).toContain('`codex-model`');
    expect(result).toContain('`cursor-model`');
  });

  it('supports one allowed backend and applies ALLOWED_MODELS filtering', async () => {
    const discover = vi.fn(async (backend: AgentBackend): Promise<BackendModelDiscovery> => ({
      backend,
      source: 'test source',
      status: 'available',
      models: [{ id: 'gpt-visible' }, { id: 'gpt-hidden' }],
    }));

    const result = await executeModelsCommand(
      'codex',
      createResolver(['codex', 'cursor'], ['gpt-visible']),
      discover
    );

    expect(discover).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledWith('codex');
    expect(result).toContain('`gpt-visible`');
    expect(result).not.toContain('gpt-hidden');
  });

  it('rejects a backend outside ALLOWED_BACKENDS before discovery', async () => {
    const discover = vi.fn();

    await expect(executeModelsCommand('grok', createResolver(), discover)).rejects.toThrow(
      '利用可能なバックエンドを指定してください: codex, cursor'
    );
    expect(discover).not.toHaveBeenCalled();
  });

  it('selects an exact discovered model for the next turn', async () => {
    const resolver = createResolver(['codex']);
    const discover = vi.fn(async (): Promise<BackendModelDiscovery> => ({
      backend: 'codex',
      source: 'test source',
      status: 'available',
      models: [{ id: 'gpt-5.4', supportedEfforts: ['medium', 'high'] }],
    }));

    const result = await selectModelForNextTurn(
      { backend: 'codex', model: 'gpt-5.4', effort: 'high', channelId: 'channel-1' },
      resolver,
      discover
    );

    expect(resolver.setChannelOverride).toHaveBeenCalledWith('channel-1', {
      backend: 'codex',
      model: 'gpt-5.4',
      effort: 'high',
    });
    expect(result).toContain('次のturnから適用');
  });

  it('rejects a model that is not in the dynamic discovery result', async () => {
    const resolver = createResolver(['codex']);
    const discover = vi.fn(async (): Promise<BackendModelDiscovery> => ({
      backend: 'codex',
      source: 'test source',
      status: 'available',
      models: [{ id: 'gpt-5.4' }],
    }));

    await expect(
      selectModelForNextTurn(
        { backend: 'codex', model: 'invented-model', channelId: 'channel-1' },
        resolver,
        discover
      )
    ).rejects.toThrow("model 'invented-model' was not found");
    expect(resolver.setChannelOverride).not.toHaveBeenCalled();
  });

  it('rejects a discovered model excluded by ALLOWED_MODELS', async () => {
    const resolver = createResolver(['codex'], ['gpt-allowed']);
    const discover = vi.fn(async (): Promise<BackendModelDiscovery> => ({
      backend: 'codex',
      source: 'test source',
      status: 'available',
      models: [{ id: 'gpt-blocked' }],
    }));

    await expect(
      selectModelForNextTurn(
        { backend: 'codex', model: 'gpt-blocked', channelId: 'channel-1' },
        resolver,
        discover
      )
    ).rejects.toThrow('not allowed by ALLOWED_MODELS');
    expect(discover).not.toHaveBeenCalled();
  });

  it('rejects effort not supported by the selected model', async () => {
    const resolver = createResolver(['codex']);
    const discover = vi.fn(async (): Promise<BackendModelDiscovery> => ({
      backend: 'codex',
      source: 'test source',
      status: 'available',
      models: [{ id: 'gpt-5.4', supportedEfforts: ['medium'] }],
    }));

    await expect(
      selectModelForNextTurn(
        { backend: 'codex', model: 'gpt-5.4', effort: 'high', channelId: 'channel-1' },
        resolver,
        discover
      )
    ).rejects.toThrow("model 'gpt-5.4' supports effort: medium");
  });
});
