import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
vi.mock('../src/backend-auth-status.js', () => ({ backendAuthenticationSnapshot: async () => [] }));
import { startWebChat } from '../src/web-chat.js';
import { LocalLlmRunner } from '../src/local-llm/runner.js';
import { DynamicRunnerManager } from '../src/dynamic-runner.js';
import type { BackendResolver } from '../src/backend-resolver.js';
import type { Config } from '../src/config.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import {
  clearSessions,
  createSession,
  createWebSession,
  getSessionEntry,
  getActiveSessionId,
  initSessions,
} from '../src/sessions.js';
import { clearActivities } from '../src/activity-store.js';
import {
  initTranscriptStorage,
  readSessionMessages,
  resetTranscriptStorageForTests,
} from '../src/transcript-logger.js';
import { webSessionTurns } from '../src/web-session-turns.js';

const httpFetch = globalThis.fetch;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('legacy Web chat force close with a real local LLM runner', () => {
  let workspace: string;
  let server: ReturnType<typeof startWebChat>;
  let runner: LocalLlmRunner;
  let manager: DynamicRunnerManager;
  let registry: WorkspaceRegistry;
  let base: string;
  let modelFetch: ReturnType<typeof vi.fn>;
  let mode: 'agent' | 'chat';
  const signals: AbortSignal[] = [];
  const releases: Array<() => void> = [];
  const responses: Array<Promise<Response>> = [];

  beforeEach(async () => {
    mode = 'agent';
    workspace = mkdtempSync(join(tmpdir(), 'web-force-close-'));
    vi.stubEnv('WORKSPACE_PATH', workspace);
    vi.stubEnv('DATA_DIR', join(workspace, '.xangi'));
    vi.stubEnv('XANGI_EXTENSIONS_FILE', join(workspace, 'extensions.json'));
    vi.stubEnv('LOCAL_LLM_BASE_URL', 'http://model.invalid/v1');
    vi.stubEnv('LOCAL_LLM_MODE', 'agent');
    clearSessions();
    initSessions(workspace);
    initTranscriptStorage(process.env.DATA_DIR!, workspace);
    registry = await WorkspaceRegistry.open({
      dataDir: process.env.DATA_DIR!,
      defaultWorkspacePath: workspace,
    });
    runner = new LocalLlmRunner({ workdir: workspace, model: 'test' });
    const config = {
      agent: {
        backend: 'local-llm',
        platform: 'web',
        config: { workdir: workspace, model: 'test' },
      },
      features: {},
      sessionTitle: {},
      claudeCode: {},
    } as Config;
    const resolved = { backend: 'local-llm', model: 'test' } as const;
    const resolver = {
      getDefault: () => resolved,
      resolve: () => ({ ...resolved, localLlmMode: mode }),
    } as unknown as BackendResolver;
    manager = new DynamicRunnerManager(config, resolver);
    // Keep DynamicRunner's real asynchronous preparation and dispatch; only select the fixture runner.
    vi.spyOn(
      manager as unknown as { getRunner: () => LocalLlmRunner },
      'getRunner'
    ).mockReturnValue(runner);
    modelFetch = vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          signals.push(init.signal!);
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          releases.push(() =>
            resolve(
              new Response(
                JSON.stringify({
                  choices: [
                    {
                      message: {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                          {
                            id: 'late',
                            type: 'function',
                            function: {
                              name: 'write',
                              arguments: JSON.stringify({
                                path: 'late.txt',
                                content: 'should not run',
                              }),
                            },
                          },
                        ],
                      },
                      finish_reason: 'tool_calls',
                    },
                  ],
                }),
                { headers: { 'Content-Type': 'application/json' } }
              )
            )
          );
        })
    );
    vi.stubGlobal('fetch', modelFetch);
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    server = startWebChat({ agentRunner: manager, port, workspaceRegistry: registry });
    if (!server.listening) await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    runner?.cancel();
    for (const release of releases.splice(0)) release();
    await Promise.allSettled(responses.splice(0).map(async (r) => (await r).text()));
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    manager?.shutdown();
    clearActivities();
    clearSessions();
    webSessionTurns.clear();
    resetTranscriptStorageForTests();
    signals.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
  });

  const post = (path: string, body = {}) =>
    httpFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  function send(id: string) {
    const response = post('/api/chat', {
      appSessionId: id,
      message: 'synthetic cancellation test',
    });
    responses.push(response);
    return response;
  }
  const close = (id: string) => post(`/api/sessions/${id}/close`, { force: true });
  const sessions = () => (runner as unknown as { sessions: Map<string, unknown> }).sessions;

  it.each(['agent', 'chat'] as const)(
    'aborts only the closed session %s fetch, with no later model/tool call or normal response',
    async (callMode) => {
      mode = callMode;
      const first = createWebSession();
      const second = createWebSession();
      const cancel = vi.spyOn(manager, 'cancel');
      const destroy = vi.spyOn(manager, 'destroy');
      const firstResponse = send(first);
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      const firstSignal = signals[0];
      expect(JSON.parse(modelFetch.mock.calls[0][1].body as string).stream === true).toBe(
        callMode === 'chat'
      );
      const secondResponse = send(second);
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      expect(sessions().size).toBe(2);
      expect((await close(first)).status).toBe(200);
      expect(cancel).toHaveBeenCalledWith(`web-chat:${first}`);
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]);
      expect(firstSignal.aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
      expect(sessions().size).toBe(1);
      releases[0]();
      expect(await (await firstResponse).text()).not.toContain('event: done');
      expect(readSessionMessages(workspace, first).filter((m) => m.role === 'assistant')).toEqual(
        []
      );
      expect(getSessionEntry(first)?.agent?.providerSessionId).toBeUndefined();
      expect(existsSync(join(workspace, 'late.txt'))).toBe(false);
      expect(modelFetch).toHaveBeenCalledTimes(2);
      await close(second);
      await (await secondResponse).text();
    }
  );

  it('does not cancel or destroy a newer current session when closing an old session', async () => {
    const old = createSession('shared-context', { platform: 'discord' });
    const current = createSession('shared-context', { platform: 'discord' });
    const cancel = vi.spyOn(manager, 'cancel');
    const destroy = vi.spyOn(manager, 'destroy');
    const pending = runner.runStream(
      'synthetic current turn',
      {},
      { channelId: 'shared-context', appSessionId: current }
    );
    const assertion = expect(pending).rejects.toThrow('Request cancelled by user');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect((await close(old)).status).toBe(200);
    expect(getActiveSessionId('shared-context')).toBe(current);
    expect(signals[0].aborted).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    runner.cancel('shared-context');
    await assertion;
  });

  it.each(['workspace', 'backend'] as const)(
    'does not start after close/reopen during %s preparation',
    async (phase) => {
      const snapshot = await registry.resolve('web', 'fixture');
      const id = createWebSession({ workspaceId: snapshot.id, workspacePath: snapshot.path });
      const entered = deferred();
      const release = deferred();
      if (phase === 'workspace') {
        const resolve = registry.resolveSnapshot.bind(registry);
        vi.spyOn(registry, 'resolveSnapshot').mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return resolve(...args);
        });
      } else {
        vi.spyOn(
          manager as unknown as { applyUserPromptSubmitHooks: (prompt: string) => Promise<string> },
          'applyUserPromptSubmitHooks'
        ).mockImplementationOnce(async (prompt) => {
          entered.resolve();
          await release.promise;
          return prompt;
        });
      }
      const response = send(id);
      await entered.promise;
      try {
        expect((await close(id)).status).toBe(200);
        expect((await post(`/api/sessions/${id}/reopen`)).status).toBe(200);
        expect((await post('/api/chat', { appSessionId: id, message: 'overlap' })).status).toBe(
          409
        );
        expect(webSessionTurns.has(id)).toBe(true);
      } finally {
        release.resolve();
      }
      const result = await response;
      expect(await result.text()).not.toContain('event: done');
      await vi.waitFor(() => expect(webSessionTurns.has(id)).toBe(false));
      expect(modelFetch).not.toHaveBeenCalled();
      expect(getSessionEntry(id)?.agent?.providerSessionId).toBeUndefined();
      // Reopen may accept a new turn once the cancelled preparation has actually unwound.
      const next = send(id);
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      await close(id);
      await (await next).text();
    }
  );
});
