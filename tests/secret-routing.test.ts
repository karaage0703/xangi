import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DynamicRunnerManager } from '../src/dynamic-runner.js';
import { BUILTIN_AGENT_BACKENDS, type Config } from '../src/config.js';
import type { AgentRunner, RunOptions, StreamCallbacks } from '../src/agent-runner.js';
import type { BackendResolver, ResolvedBackend } from '../src/backend-resolver.js';
import { clearSessions, createSession, initSessions } from '../src/sessions.js';
import {
  initTranscriptStorage,
  logPrompt,
  logResponse,
  readSessionMessages,
  resetTranscriptStorageForTests,
} from '../src/transcript-logger.js';
import type { ChatPlatform } from '../src/prompts/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secret-routing-'));
  clearSessions();
  initSessions(dir);
  initTranscriptStorage(dir, dir);
});
afterEach(() => {
  clearSessions();
  resetTranscriptStorageForTests();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
function managerFor(backend: string, platform: ChatPlatform) {
  const config = {
    agent: { backend: 'codex', platform, config: { workdir: dir, persistent: true } },
    claudeCode: {},
  } as Config;
  const resolver = {
    resolve: () => ({ backend }),
    getDefault: () => ({ backend: 'codex' }),
  } as unknown as BackendResolver;
  return new DynamicRunnerManager(config, resolver);
}
const cases = (['discord', 'slack', 'telegram', 'line', 'web'] as ChatPlatform[]).flatMap(
  (platform) =>
    [...BUILTIN_AGENT_BACKENDS, 'extension-test'].map((backend) => [platform, backend] as const)
);
describe('all platform/backend secret routing', () => {
  it.each(cases)(
    '%s / %s uses fresh nonpersistent runners and bounded in-memory history',
    async (platform, backend) => {
      const manager = managerFor(backend, platform);
      const id = createSession('chat', { platform, secret: true, workspacePath: dir });
      const calls: Array<{ prompt: string; options?: RunOptions }> = [];
      const internal = manager as unknown as {
        createRunnerFor: (
          resolved: ResolvedBackend,
          platform?: ChatPlatform,
          workdir?: string,
          secret?: boolean
        ) => AgentRunner;
      };
      Object.defineProperty(manager, 'userPromptSubmitHooks', {
        value: {
          run: vi
            .fn()
            .mockResolvedValue([
              { id: 'user-hook', text: 'USER-CONFIGURED-CONTEXT', truncated: false },
            ]),
        },
      });
      const factory = vi.spyOn(internal, 'createRunnerFor').mockImplementation(() => {
        async function run(prompt: string, options?: RunOptions) {
          calls.push({ prompt, options });
          logPrompt(dir, options!.appSessionId!, prompt);
          logResponse(dir, options!.appSessionId!, { result: 'PRIVATE-RESPONSE' });
          return { result: 'PRIVATE-RESPONSE', sessionId: 'provider-private', model: 'test-model' };
        }
        return {
          run,
          runStream: async (prompt: string, callbacks: StreamCallbacks, options?: RunOptions) => {
            const result = await run(prompt, options);
            callbacks.onComplete?.(result);
            return result;
          },
          destroy: vi.fn(),
        };
      });
      try {
        const opts = {
          appSessionId: id,
          channelId: 'chat',
          platform,
          workdir: dir,
          sessionId: 'ordinary-provider',
          userText: 'PRIVATE-INPUT',
        };
        await manager.run('first expanded prompt', opts);
        await manager.runStream('second expanded prompt', {}, { ...opts, userText: 'FOLLOW-UP' });
        expect(factory).toHaveBeenCalledTimes(2);
        for (const call of factory.mock.calls) expect(call[3]).toBe(true);
        for (const { options } of calls)
          expect(options).toMatchObject({
            secret: true,
            sessionId: undefined,
            codexLineTransport: 'exec',
          });
        expect(calls[1].prompt).toContain('PRIVATE-INPUT');
        expect(calls[1].prompt).toContain('USER-CONFIGURED-CONTEXT');
        expect(calls[1].prompt).not.toContain('Do not record this conversation');
        expect(calls[1].prompt).toContain('PRIVATE-RESPONSE');
        expect(calls[1].prompt).not.toContain('first expanded prompt');
        expect(
          readSessionMessages(dir, id)
            .filter((e) => e.role === 'user')
            .map((e) => e.content)
        ).toEqual(['PRIVATE-INPUT', 'FOLLOW-UP']);
        expect(readFileSync(join(dir, 'sessions.json'), 'utf8')).not.toContain('PRIVATE');
        expect(readdirSync(dir)).toEqual(['sessions.json']);
      } finally {
        manager.shutdown();
      }
    }
  );

  it('redacts failure details before platform adapters log them', async () => {
    const manager = managerFor('codex', 'web');
    const id = createSession('chat', { platform: 'web', secret: true, workspacePath: dir });
    const internal = manager as unknown as { createRunnerFor: () => AgentRunner };
    vi.spyOn(internal, 'createRunnerFor').mockReturnValue({
      run: async () => {
        throw new Error('PRIVATE-STDERR');
      },
      runStream: async (_p, callbacks) => {
        const error = new Error('PRIVATE-STDERR');
        callbacks.onError?.(error);
        throw error;
      },
    });
    const onError = vi.fn();
    const opts = { appSessionId: id, channelId: 'chat', workdir: dir, userText: 'PRIVATE-INPUT' };
    try {
      await expect(manager.runStream('prompt', { onError }, opts)).rejects.toThrow(
        '詳細は保存しません'
      );
      expect(onError.mock.calls[0][0].message).not.toContain('PRIVATE');
      await expect(manager.run('prompt', opts)).rejects.toThrow('詳細は保存しません');
    } finally {
      manager.shutdown();
    }
  });
});
