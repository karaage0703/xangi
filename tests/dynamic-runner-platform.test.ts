import { describe, expect, it, vi } from 'vitest';
import { BackendResolver } from '../src/backend-resolver.js';
import type { Config } from '../src/config.js';
import { DynamicRunnerManager } from '../src/dynamic-runner.js';

function makeConfig(platform: Config['agent']['platform']): Config {
  return {
    discord: { enabled: true, token: 'x' },
    slack: { enabled: false },
    line: { enabled: false },
    agent: {
      backend: 'local-llm',
      config: { model: 'test' },
      platform,
    },
    scheduler: { enabled: false, startupEnabled: false },
    claudeCode: {},
  } as Config;
}

describe('DynamicRunnerManager platform routing', () => {
  it('creates a platform-specific runner when a Web/Even turn uses a Discord default runner', () => {
    const config = makeConfig('discord');
    const manager = new DynamicRunnerManager(config, new BackendResolver(config));
    const resolved = new BackendResolver(config).resolve('web-chat:session-1');

    const runner = (
      manager as unknown as {
        getRunner(
          channelId: string,
          resolved: typeof resolved,
          platform?: Config['agent']['platform']
        ): unknown;
      }
    ).getRunner('web-chat:session-1', resolved, 'web');

    expect((runner as { platform?: string }).platform).toBe('web');
  });

  it('does not leak the default model into a backend-only channel override', () => {
    const originalOverrides = process.env.CHANNEL_OVERRIDES;
    process.env.CHANNEL_OVERRIDES = JSON.stringify({
      'discord-channel': { backend: 'cursor' },
    });

    try {
      const config = {
        ...makeConfig('discord'),
        agent: {
          backend: 'grok',
          config: { model: 'grok-build' },
          platform: 'discord',
        },
      } as Config;
      const resolver = new BackendResolver(config);
      const manager = new DynamicRunnerManager(config, resolver);
      const resolved = resolver.resolve('discord-channel');

      const runner = (
        manager as unknown as {
          getRunner(
            channelId: string,
            resolved: typeof resolved,
            platform?: Config['agent']['platform']
          ): unknown;
        }
      ).getRunner('discord-channel', resolved, 'discord');

      expect((runner as { model?: string }).model).toBeUndefined();
    } finally {
      if (originalOverrides === undefined) {
        delete process.env.CHANNEL_OVERRIDES;
      } else {
        process.env.CHANNEL_OVERRIDES = originalOverrides;
      }
    }
  });

  it('uses settingsChannelId for backend resolution while keeping channelId as the run key', async () => {
    const config = makeConfig('discord');
    const resolved = { backend: 'local-llm' as const, model: 'test' };
    const resolver = {
      resolve: vi.fn().mockReturnValue(resolved),
      getDefault: vi.fn().mockReturnValue(resolved),
    } as unknown as BackendResolver;
    const manager = new DynamicRunnerManager(config, resolver);
    const run = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 'session-1' });

    (
      manager as unknown as {
        defaultRunner: { run: typeof run };
      }
    ).defaultRunner = { run };

    await manager.run('prompt', {
      channelId: 'thread-456',
      settingsChannelId: 'parent-123',
    });

    expect(resolver.resolve).toHaveBeenCalledWith('parent-123', undefined);
    expect(run).toHaveBeenCalledWith(
      'prompt',
      expect.objectContaining({
        channelId: 'thread-456',
        settingsChannelId: 'parent-123',
      })
    );
  });

  it('passes a Project default backend, model, and effort to backend resolution', async () => {
    const config = makeConfig('web');
    const resolved = { backend: 'local-llm' as const, model: 'test' };
    const resolver = {
      resolve: vi.fn().mockReturnValue(resolved),
      getDefault: vi.fn().mockReturnValue({ backend: 'local-llm', model: 'test' }),
    } as unknown as BackendResolver;
    const manager = new DynamicRunnerManager(config, resolver);
    const run = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 'session-1' });

    (manager as unknown as { defaultRunner: { run: typeof run } }).defaultRunner = { run };

    await manager.run('prompt', {
      channelId: 'web-chat:session-1',
      defaultBackend: 'codex',
      defaultModel: 'gpt-5.6-sol',
      defaultEffort: 'high',
    });

    expect(resolver.resolve).toHaveBeenCalledWith('web-chat:session-1', {
      backend: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
  });

  it('passes the resolved effort to the selected runner', async () => {
    const config = makeConfig('discord');
    const resolved = { backend: 'codex' as const, model: 'gpt-5.6-sol', effort: 'max' as const };
    const resolver = {
      resolve: vi.fn().mockReturnValue(resolved),
      getDefault: vi.fn().mockReturnValue(resolved),
    } as unknown as BackendResolver;
    const manager = new DynamicRunnerManager(config, resolver);
    const run = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 'session-1' });

    (
      manager as unknown as {
        defaultRunner: { run: typeof run };
      }
    ).defaultRunner = { run };

    await manager.run('prompt');

    expect(run).toHaveBeenCalledWith('prompt', { effort: 'max' });
  });

  it('delegates hasRunner to a channel-specific runner', () => {
    const config = makeConfig('discord');
    const manager = new DynamicRunnerManager(config, new BackendResolver(config));
    const hasRunner = vi.fn().mockReturnValue(false);

    (
      manager as unknown as {
        channelRunners: Map<string, { runner: { hasRunner: typeof hasRunner }; key: string }>;
      }
    ).channelRunners.set('web-chat:session-1', {
      runner: { hasRunner },
      key: 'codex:test:web:',
    });

    expect(manager.hasRunner('web-chat:session-1')).toBe(false);
    expect(hasRunner).toHaveBeenCalledWith('web-chat:session-1');

    hasRunner.mockReturnValue(true);
    expect(manager.hasRunner('web-chat:session-1')).toBe(true);
  });
});
