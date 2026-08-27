import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { BackendResolver } from '../src/backend-resolver.js';
import type { Config } from '../src/config.js';
import { DynamicRunnerManager } from '../src/dynamic-runner.js';
import {
  createSession,
  getSessionEntry,
  initSessions,
  setProviderSessionId,
} from '../src/sessions.js';

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
  it('records timing-safe CLI trajectory metadata without wrapping Local LLM', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'dynamic-runner-trajectory-'));
    const previous = process.env.XANGI_TOOL_TRAJECTORY_LOG;
    process.env.XANGI_TOOL_TRAJECTORY_LOG = 'true';
    try {
      const config = makeConfig('web');
      config.agent.backend = 'codex';
      config.agent.config.workdir = workdir;
      const resolved = { backend: 'codex' as const, model: 'gpt-test' };
      const resolver = {
        resolve: vi.fn().mockReturnValue(resolved),
        getDefault: vi.fn().mockReturnValue(resolved),
      } as unknown as BackendResolver;
      const manager = new DynamicRunnerManager(config, resolver);
      const runStream = vi.fn().mockImplementation(async (_prompt, callbacks) => {
        callbacks.onTraceEvent?.({
          type: 'tool_started',
          toolId: 'tool-1',
          toolName: 'Bash',
        });
        callbacks.onTraceEvent?.({
          type: 'tool_completed',
          toolId: 'tool-1',
          toolName: 'Bash',
          exitCode: 0,
          outputBytes: 999,
        });
        return { result: 'ok', sessionId: 'provider-1' };
      });
      (
        manager as unknown as {
          defaultRunner: { runStream: typeof runStream };
        }
      ).defaultRunner = { runStream };

      await manager.runStream('prompt containing TOKEN=secret', {}, {
        channelId: 'web-chat:session-1',
        appSessionId: 'app-session-1',
        platform: 'web',
        workdir,
      });

      const path = join(workdir, 'logs', 'tool-trajectory', 'app-session-1.jsonl');
      const contents = readFileSync(path, 'utf8');
      expect(contents).toContain('"tool_name":"Bash"');
      expect(contents).not.toContain('TOKEN=secret');
      const entries = contents
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const toolCall = entries.find((entry) => entry.kind === 'tool_call');
      expect(toolCall).toBeDefined();
      expect(toolCall).not.toHaveProperty('output_bytes');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env.XANGI_TOOL_TRAJECTORY_LOG;
      else process.env.XANGI_TOOL_TRAJECTORY_LOG = previous;
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('creates a dedicated runner keyed by a non-default canonical workdir', () => {
    const defaultWorkdir = mkdtempSync(join(tmpdir(), 'dynamic-runner-default-'));
    const alternateWorkdir = mkdtempSync(join(tmpdir(), 'dynamic-runner-alternate-'));
    try {
      const config = makeConfig('discord');
      config.agent.config.workdir = defaultWorkdir;
      const resolver = new BackendResolver(config);
      const manager = new DynamicRunnerManager(config, resolver);
      const resolved = resolver.resolve('channel-1');

      const runner = (
        manager as unknown as {
          getRunner(
            channelId: string,
            resolved: typeof resolved,
            platform: Config['agent']['platform'],
            workdir: string
          ): unknown;
        }
      ).getRunner('channel-1', resolved, 'discord', alternateWorkdir);

      expect((runner as { workdir?: string }).workdir).toBe(alternateWorkdir);
    } finally {
      rmSync(defaultWorkdir, { recursive: true, force: true });
      rmSync(alternateWorkdir, { recursive: true, force: true });
    }
  });

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

  it('runs UserPromptSubmit before both run paths and passes enriched prompt to every backend', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'dynamic-runner-hook-'));
    try {
      mkdirSync(join(workdir, 'hooks'));
      const hookScript = `
        let raw = '';
        process.stdin.on('data', (chunk) => (raw += chunk));
        process.stdin.on('end', () => {
          const input = JSON.parse(raw);
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { additionalContext: 'prefetched:' + input.prompt }
          }));
        });
      `;
      writeFileSync(
        join(workdir, 'hooks', 'hooks.json'),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { id: 'prefetch', exec: { file: process.execPath, args: ['-e', hookScript] } },
            ],
          },
        })
      );
      const config = makeConfig('discord');
      config.agent.config.workdir = workdir;
      const resolved = { backend: 'local-llm' as const, model: 'test' };
      const resolver = {
        resolve: vi.fn().mockReturnValue(resolved),
        getDefault: vi.fn().mockReturnValue(resolved),
      } as unknown as BackendResolver;
      const manager = new DynamicRunnerManager(config, resolver);
      const run = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 'session-1' });
      const runStream = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 'session-1' });
      (
        manager as unknown as {
          defaultRunner: { run: typeof run; runStream: typeof runStream };
        }
      ).defaultRunner = { run, runStream };

      const options = {
        channelId: 'thread-456',
        appSessionId: 'app-session-1',
        platform: 'discord' as const,
        userText: 'raw user query',
      };
      await manager.run('composed prompt', options);
      await manager.runStream('stream prompt', {}, options);

      expect(run.mock.calls[0]?.[0]).toContain('prefetched:raw user query');
      expect(runStream.mock.calls[0]?.[0]).toContain('prefetched:raw user query');
      expect(run.mock.calls[0]?.[0]).toContain('[USER PROMPT HOOK CONTEXT: prefetch]');

      writeFileSync(
        join(workdir, 'hooks', 'hooks.json'),
        JSON.stringify({ hooks: { UserPromptSubmit: [] } })
      );
      await manager.run('prompt after hook removal', options);
      expect(run.mock.calls[1]?.[0]).toBe('prompt after hook removal');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('does not run UserPromptSubmit without unexpanded userText', async () => {
    const config = makeConfig('discord');
    const resolved = { backend: 'local-llm' as const, model: 'test' };
    const resolver = {
      resolve: vi.fn().mockReturnValue(resolved),
      getDefault: vi.fn().mockReturnValue(resolved),
    } as unknown as BackendResolver;
    const manager = new DynamicRunnerManager(config, resolver);
    const run = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 'session-1' });
    (manager as unknown as { defaultRunner: { run: typeof run } }).defaultRunner = { run };

    await manager.run('prompt without raw input');

    expect(run).toHaveBeenCalledWith('prompt without raw input', undefined);
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

  it('passes the resolved Local LLM reasoning effort to the selected runner', async () => {
    const config = makeConfig('discord');
    const resolved = {
      backend: 'local-llm' as const,
      model: 'qwen3.8-27b',
      localLlmReasoningEffort: 'low' as const,
    };
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

    expect(run).toHaveBeenCalledWith('prompt', { localLlmReasoningEffort: 'low' });
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

  it('records stateless provider metadata returned by a backend', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dynamic-runner-stateless-'));
    try {
      initSessions(tempDir);
      const appSessionId = createSession('discord-channel', { platform: 'discord' });
      const config = makeConfig('discord');
      const manager = new DynamicRunnerManager(config, new BackendResolver(config));
      const run = vi.fn().mockResolvedValue({
        result: 'result',
        sessionId: 'search:discord-channel',
        sessionMode: 'stateless' as const,
      });
      (
        manager as unknown as {
          defaultRunner: { run: typeof run };
        }
      ).defaultRunner = { run };

      await manager.run('prompt', {
        channelId: 'discord-channel',
        appSessionId,
      });

      expect(getSessionEntry(appSessionId)?.agent?.sessionMode).toBe('stateless');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records stateless mode before a backend request can fail', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dynamic-runner-stateless-error-'));
    try {
      initSessions(tempDir);
      const appSessionId = createSession('discord-channel', { platform: 'discord' });
      const config = makeConfig('discord');
      const resolved = {
        backend: 'local-llm' as const,
        model: 'test',
        sessionMode: 'stateless' as const,
      };
      const resolver = {
        resolve: vi.fn().mockReturnValue(resolved),
        getDefault: vi.fn().mockReturnValue(resolved),
      } as unknown as BackendResolver;
      const manager = new DynamicRunnerManager(config, resolver);
      const run = vi.fn().mockRejectedValue(new Error('search failed'));
      (
        manager as unknown as {
          defaultRunner: { run: typeof run };
        }
      ).defaultRunner = { run };

      await expect(
        manager.run('prompt', {
          channelId: 'discord-channel',
          appSessionId,
        })
      ).rejects.toThrow('search failed');

      expect(getSessionEntry(appSessionId)?.agent?.sessionMode).toBe('stateless');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('drops a provider session when the resolved model or effort changed', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dynamic-runner-session-'));
    try {
      initSessions(tempDir);
      const appSessionId = createSession('discord-channel', { platform: 'discord' });
      setProviderSessionId(appSessionId, 'provider-old', 'codex', 'gpt-old', 'low');

      const config = {
        ...makeConfig('discord'),
        agent: {
          backend: 'codex',
          config: { model: 'gpt-new' },
          platform: 'discord',
        },
      } as Config;
      const manager = new DynamicRunnerManager(config, new BackendResolver(config));
      const result = (
        manager as unknown as {
          dropMismatchedProviderSession(
            options: {
              channelId: string;
              appSessionId: string;
              sessionId: string;
            },
            resolved: { backend: 'codex'; model: string; effort: 'high' }
          ): { sessionId?: string };
        }
      ).dropMismatchedProviderSession(
        {
          channelId: 'discord-channel',
          appSessionId,
          sessionId: 'provider-old',
        },
        { backend: 'codex', model: 'gpt-new', effort: 'high' }
      );

      expect(result.sessionId).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
