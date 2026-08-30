import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import {
  appendFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  utimesSync,
  realpathSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, type Server } from 'http';
import { startWebChat } from '../src/web-chat.js';
import {
  initSessions,
  clearSessions,
  listAllSessions,
  getSessionEntry,
  getActiveSessionId,
  createSession,
  createWebSession,
  setProviderSessionId,
  WEB_CHAT_CONTEXT_PREFIX,
} from '../src/sessions.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../src/agent-runner.js';
import {
  clearActivities,
  completeActivity,
  startActivity,
  updateActivityText,
  updateActivityTool,
} from '../src/activity-store.js';
import { events } from '../src/events-emitter.js';
import type { DiscordRemoteInputBridge } from '../src/discord/message-handler.js';
import { logError, logPrompt, logResponse, readSessionMessages } from '../src/transcript-logger.js';
import { finalizeActiveStreams } from '../src/stream-finalizer.js';
import { Scheduler } from '../src/scheduler.js';
import { EventTrigger } from '../src/event-trigger.js';
import type { BackendResolver, ChannelOverride } from '../src/backend-resolver.js';
import type { AgentBackend } from '../src/config.js';
import type { BackendModelDiscovery } from '../src/backend-models.js';
import {
  canComposeInSession,
  resolveDisplayedSessionTitle,
  shouldShowContinuationActions,
} from '../web-ui/src/Chat.js';
import { stopManagedExtensions } from '../src/extensions.js';
import { installExtensionBackendFixture } from './helpers/extension-backend.js';

describe('Web Chat continuation actions', () => {
  it('keeps Closed Discord sessions continuable from the original Discord conversation', () => {
    const detail = { lifecycle: 'closed' as const, platform: 'discord' };
    expect(shouldShowContinuationActions(detail)).toBe(true);
    expect(canComposeInSession(detail, false)).toBe(false);
    expect(canComposeInSession(detail, true)).toBe(true);
  });

  it('offers a Web fork for Closed sessions without reopening them for direct Web input', () => {
    const detail = { lifecycle: 'closed' as const, platform: 'web' };
    expect(shouldShowContinuationActions(detail)).toBe(true);
    expect(canComposeInSession(detail, false)).toBe(false);
  });

  it('does not add continuation actions to an open Web session', () => {
    const detail = { lifecycle: 'open' as const, platform: 'web' };
    expect(shouldShowContinuationActions(detail)).toBe(false);
    expect(canComposeInSession(detail, false)).toBe(true);
  });
});

describe('Web Chat live session titles', () => {
  it('prefers the SSE session summary over stale pane detail', () => {
    expect(resolveDisplayedSessionTitle('AIによる新タイトル', '送信前のタイトル')).toBe(
      'AIによる新タイトル'
    );
    expect(resolveDisplayedSessionTitle(undefined, '保存済みタイトル')).toBe('保存済みタイトル');
    expect(resolveDisplayedSessionTitle()).toBeUndefined();
  });
});

describe('Web Chat session list actions', () => {
  it('keeps completion separate from closing a pane and destructive deletion', () => {
    const source = readFileSync(join(process.cwd(), 'web-ui', 'src', 'Chat.tsx'), 'utf8');
    expect(source).toContain('完了して閉じる');
    expect(source).toContain('aria-label="完了にする"');
    expect(source).toContain('aria-label="ペインを閉じる"');
    expect(source).toContain('aria-label="削除"');
    expect(source).toContain("['open', '未完了']");
  });
});

/**
 * 任意のタイミングで完了させられる Fake AgentRunner。
 * runStream() を呼ぶと promise を保留し、release(channelId) で解放できる。
 */
class FakeRunner implements AgentRunner {
  destroyed = new Set<string>();
  pending = new Map<string, () => void>();
  callbacks = new Map<string, StreamCallbacks>();
  callOrder: string[] = [];
  prompts: string[] = [];
  options: RunOptions[] = [];
  nextResult = 'ok';
  nextError?: Error;
  persistResults = false;

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const channelId = options?.channelId || 'default';
    this.callOrder.push(channelId);
    this.prompts.push(prompt);
    this.options.push(options ?? {});
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = undefined;
      if (this.persistResults && options?.appSessionId && process.env.WORKSPACE_PATH) {
        logPrompt(process.env.WORKSPACE_PATH, options.appSessionId, prompt);
        logError(process.env.WORKSPACE_PATH, options.appSessionId, error.message);
      }
      throw error;
    }
    const result = { result: this.nextResult, sessionId: `provider-${channelId}` };
    if (this.persistResults && options?.appSessionId && process.env.WORKSPACE_PATH) {
      const logsDir = join(process.env.WORKSPACE_PATH, 'logs', 'sessions');
      mkdirSync(logsDir, { recursive: true });
      const createdAt = new Date().toISOString();
      appendFileSync(
        join(logsDir, `${options.appSessionId}.jsonl`),
        [
          JSON.stringify({ role: 'user', content: prompt, createdAt }),
          JSON.stringify({ role: 'assistant', content: result.result, createdAt }),
        ].join('\n') + '\n'
      );
    }
    return result;
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const channelId = options?.channelId || 'default';
    this.callOrder.push(channelId);
    this.prompts.push(prompt);
    this.options.push(options ?? {});
    this.callbacks.set(channelId, callbacks);
    return new Promise<RunResult>((resolve) => {
      this.pending.set(channelId, () => {
        this.callbacks.delete(channelId);
        callbacks.onText?.(this.nextResult, this.nextResult);
        const result: RunResult = {
          result: this.nextResult,
          sessionId: `provider-${channelId}`,
        };
        if (this.persistResults && options?.appSessionId && process.env.WORKSPACE_PATH) {
          const logsDir = join(process.env.WORKSPACE_PATH, 'logs', 'sessions');
          mkdirSync(logsDir, { recursive: true });
          const createdAt = new Date().toISOString();
          appendFileSync(
            join(logsDir, `${options.appSessionId}.jsonl`),
            [
              JSON.stringify({ role: 'user', content: prompt, createdAt }),
              JSON.stringify({ role: 'assistant', content: result, createdAt }),
            ].join('\n') + '\n'
          );
        }
        callbacks.onComplete?.(result);
        resolve(result);
      });
    });
  }

  emitText(channelId: string, fullText: string): boolean {
    const callbacks = this.callbacks.get(channelId);
    if (!callbacks) return false;
    callbacks.onText?.(fullText, fullText);
    return true;
  }

  release(channelId: string): boolean {
    const fn = this.pending.get(channelId);
    if (!fn) return false;
    this.pending.delete(channelId);
    fn();
    return true;
  }

  cancel(): boolean {
    return false;
  }

  destroy(channelId: string): boolean {
    this.destroyed.add(channelId);
    return true;
  }

  hasRunner(channelId: string): boolean {
    return this.callOrder.includes(channelId) && !this.destroyed.has(channelId);
  }
}

/**
 * SSE 応答から `event: done` の data を取り出す簡易パーサ。
 * 取得できなければ undefined。
 */
async function readSSEUntilDone(
  body: ReadableStream<Uint8Array> | null
): Promise<{ events: { event: string; data: any }[] }> {
  const events: { event: string; data: any }[] = [];
  if (!body) return { events };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const segments = buf.split('\n\n');
    buf = segments.pop() || '';
    for (const seg of segments) {
      const lines = seg.split('\n');
      let event = '';
      let data: unknown;
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) {
          try {
            data = JSON.parse(line.slice(6));
          } catch {
            data = line.slice(6);
          }
        }
      }
      if (event) events.push({ event, data });
      if (event === 'done' || event === 'error') return { events };
    }
  }
  return { events };
}

async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for SSE event')), 2_000)
      ),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    if (predicate(text)) return text;
  }
  throw new Error(`SSE predicate not reached: ${text}`);
}

async function freePort(): Promise<number> {
  // 0 を listen させて確保したポートを返す
  const { createServer } = await import('http');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('failed to allocate port')));
      }
    });
  });
}

describe('web-chat HTTP API', () => {
  let testDir: string;
  let server: Server | null = null;
  let baseUrl = '';
  let runner: FakeRunner;
  let discordRemoteInputRef: { current?: DiscordRemoteInputBridge };
  let destinationLabelResolverRef: {
    current?: (
      platform: 'discord' | 'slack' | 'telegram' | 'web',
      destinationId: string
    ) => string | undefined;
  };
  let scheduler: Scheduler;
  let resolver: BackendResolver;
  const prevWorkspace = process.env.WORKSPACE_PATH;
  const prevDataDir = process.env.DATA_DIR;
  const prevExtensionManifests = process.env.XANGI_EXTENSION_DEV_MANIFESTS;
  const prevExtensionsFile = process.env.XANGI_EXTENSIONS_FILE;

  beforeEach(async () => {
    clearSessions();
    testDir = mkdtempSync(join(tmpdir(), 'web-chat-test-'));
    process.env.WORKSPACE_PATH = testDir;
    process.env.DATA_DIR = join(testDir, '.xangi');
    delete process.env.XANGI_EXTENSION_DEV_MANIFESTS;
    process.env.XANGI_EXTENSIONS_FILE = join(testDir, '.xangi', 'extensions.json');
    initSessions(testDir);

    runner = new FakeRunner();
    const overrides = new Map<string, ChannelOverride>();
    resolver = {
      resolve: (channelId?: string, requestDefault?: ChannelOverride) =>
        (channelId ? overrides.get(channelId) : undefined) ??
        requestDefault ?? { backend: 'claude-code' },
      getDefault: () => ({ backend: 'claude-code' }),
      getChannelOverride: (channelId: string) => overrides.get(channelId),
      getAllowedBackends: () => ['claude-code', 'codex'] as AgentBackend[],
      getSelectableBackends: () => ['claude-code', 'codex'] as AgentBackend[],
      isBackendAllowed: (backend: AgentBackend) => ['claude-code', 'codex'].includes(backend),
      isBackendSelectable: (backend: AgentBackend) => ['claude-code', 'codex'].includes(backend),
      setChannelOverride: (channelId: string, override: ChannelOverride) => {
        overrides.set(channelId, override);
      },
      clearChannelOverride: (channelId: string) => {
        overrides.delete(channelId);
      },
      setChannelLocalLlmMode: () => {},
    } as unknown as BackendResolver;
    scheduler = new Scheduler(process.env.DATA_DIR, { quiet: true });
    const workspaceRegistry = await WorkspaceRegistry.open({
      dataDir: process.env.DATA_DIR,
      defaultWorkspacePath: testDir,
    });
    discordRemoteInputRef = {};
    destinationLabelResolverRef = {};
    const port = await freePort();
    // startWebChat は server を返さないので、内部で動作する http サーバの listen を待つために
    // setTimeout で次のティックを待ち、URL を保持する。
    startWebChat({
      agentRunner: runner,
      port,
      replySuggestions: { replySuggestions: true, replySuggestionCount: 3 },
      discordRemoteInputRef,
      destinationLabelResolverRef,
      scheduler,
      resolver,
      workspaceRegistry,
      discoverModels: async (backend): Promise<BackendModelDiscovery> => ({
        backend,
        source: 'web-chat test discovery',
        status: 'available',
        models: [{ id: 'gpt-test', displayName: 'GPT Test', supportedEfforts: ['high'] }],
      }),
      extensionUpdateRequest: async (id) => ({
        id,
        displayName: 'Demo Extension',
        prompt: `Update ${id} with xangi tool extension_update --id ${id} --to ${'b'.repeat(40)}`,
        displayMessage: 'Demo Extension の更新を確認します。',
        info: {
          id,
          displayName: 'Demo Extension',
          currentVersion: '1.0.0',
          currentCommitSha: 'a'.repeat(40),
          targetCommitSha: 'b'.repeat(40),
          repositoryUrl: 'https://github.com/example/demo-extension',
          updateAvailable: true,
        },
      }),
    });
    baseUrl = `http://127.0.0.1:${port}`;

    // 起動完了を待つ（health チェック）
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) {
          server = (await import('http')).Server.prototype as unknown as Server;
          break;
        }
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterEach(async () => {
    await stopManagedExtensions();
    // 既存テストの後始末: 注意:startWebChat は server を返さないが、各テストごとに別 port を使うので
    // この test ではプロセス終了で OS が掃除する前提。プロセスを汚さないよう pending を解放する。
    for (const ch of Array.from(runner?.pending.keys() ?? [])) {
      runner.release(ch);
    }
    scheduler?.stopAll();
    clearSessions();
    clearActivities();
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    if (prevWorkspace == null) delete process.env.WORKSPACE_PATH;
    else process.env.WORKSPACE_PATH = prevWorkspace;
    if (prevDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    if (prevExtensionManifests == null) delete process.env.XANGI_EXTENSION_DEV_MANIFESTS;
    else process.env.XANGI_EXTENSION_DEV_MANIFESTS = prevExtensionManifests;
    if (prevExtensionsFile == null) delete process.env.XANGI_EXTENSIONS_FILE;
    else process.env.XANGI_EXTENSIONS_FILE = prevExtensionsFile;
  });

  it('POST /api/sessions creates a fresh web session without destroying others', async () => {
    const r1 = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const j1 = await r1.json();
    const r2 = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const j2 = await r2.json();

    expect(j1.sessionId).toBeTruthy();
    expect(j2.sessionId).toBeTruthy();
    expect(j1.sessionId).not.toBe(j2.sessionId);

    const sessions = listAllSessions().filter((s) => s.platform === 'web');
    expect(sessions.map((s) => s.id).sort()).toEqual([j1.sessionId, j2.sessionId].sort());

    // contextKey が web-chat:<appId> 形式で別々
    const e1 = getSessionEntry(j1.sessionId)!;
    const e2 = getSessionEntry(j2.sessionId)!;
    expect(e1.contextKey).toBe(`${WEB_CHAT_CONTEXT_PREFIX}${j1.sessionId}`);
    expect(e2.contextKey).toBe(`${WEB_CHAT_CONTEXT_PREFIX}${j2.sessionId}`);

    // Runner は destroy されていない（旧実装のように web-chat ランナーを毎回破棄しない）
    expect(runner.destroyed.size).toBe(0);
  });

  it('creates an Agent Run with an isolated session and persists its result manifest', async () => {
    const response = await fetch(`${baseUrl}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Implement a bounded change',
        backend: 'codex',
        model: 'gpt-test',
        effort: 'high',
      }),
    });
    const created = (await response.json()) as {
      run: { id: string; appSessionId: string; taskHash: string; status: string };
    };

    expect(response.status).toBe(202);
    expect(created.run.status).toBe('queued');
    expect(created.run.taskHash).toMatch(/^[a-f0-9]{64}$/);

    const contextKey = `${WEB_CHAT_CONTEXT_PREFIX}${created.run.appSessionId}`;
    for (let attempt = 0; attempt < 30 && !runner.release(contextKey); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    let detail: { run: Record<string, unknown> } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      detail = (await (
        await fetch(`${baseUrl}/api/agent-runs/${encodeURIComponent(created.run.id)}`)
      ).json()) as { run: Record<string, unknown> };
      if (detail.run.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(detail?.run).toMatchObject({
      id: created.run.id,
      status: 'succeeded',
      backend: 'codex',
      model: 'gpt-test',
      effort: 'high',
      result: 'ok',
      providerSessionId: `provider-${contextKey}`,
    });
    expect(runner.options.at(-1)).toMatchObject({
      appSessionId: created.run.appSessionId,
      defaultBackend: 'codex',
      defaultModel: 'gpt-test',
      defaultEffort: 'high',
      workdir: realpathSync(testDir),
    });
    expect(existsSync(join(testDir, '.xangi', 'agent-runs.json'))).toBe(true);
  });

  it('serves the Web app route used by message permalinks', async () => {
    const sessionId = createWebSession({ title: 'permalink test' });
    const response = await fetch(`${baseUrl}/chat/${sessionId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="root"></div>');
  });

  it('adds a triggered turn to the same Web session', async () => {
    const created = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json()) as {
      sessionId: string;
    };
    runner.persistResults = true;
    const trigger = new EventTrigger({ enabled: true, minIntervalMs: 0 }, scheduler);

    const result = await trigger.handleLocal({
      channel: `${WEB_CHAT_CONTEXT_PREFIX}${created.sessionId}`,
      message: '保存済みの処理結果を確認して',
      source: 'web-test',
      platform: 'web',
    });
    for (let attempt = 0; attempt < 50 && runner.callOrder.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(result.status).toBe(202);
    expect(runner.callOrder).toContain(`${WEB_CHAT_CONTEXT_PREFIX}${created.sessionId}`);
    expect(readSessionMessages(testDir, created.sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('保存済みの処理結果を確認して'),
        }),
        expect.objectContaining({ role: 'assistant', content: 'ok' }),
      ])
    );
  });

  it('creates and edits schedules for Web and chat platforms', async () => {
    const page = await fetch(`${baseUrl}/schedules`);
    expect(page.status).toBe(200);

    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '定期レポート', prompt: '簡潔にまとめて' }),
    });
    const { project } = (await projectResponse.json()) as {
      project: { id: string };
    };
    const addedResponse = await fetch(`${baseUrl}/api/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'web',
        projectId: project.id,
        type: 'cron',
        expression: '0 9 * * *',
        message: '朝の予定を確認して',
        label: '朝の確認',
      }),
    });
    const added = (await addedResponse.json()) as { schedule: { id: string } };
    expect(addedResponse.status).toBe(201);

    const listed = (await (await fetch(`${baseUrl}/api/schedules`)).json()) as {
      schedules: Array<{ id: string; platform: string; channelId: string; enabled: boolean }>;
    };
    expect(listed.schedules).toEqual([
      expect.objectContaining({
        id: added.schedule.id,
        platform: 'web',
        channelId: '__new__',
        projectId: project.id,
        enabled: true,
      }),
    ]);

    const sessionsBeforeRun = listAllSessions().length;
    runner.persistResults = true;
    const onDelivery = vi.fn();
    await scheduler.getAgentRunner('web')?.(
      '朝の予定を確認して',
      '__new__',
      scheduler.get(added.schedule.id),
      { onDelivery }
    );
    const newSession = listAllSessions().find(
      (session) => session.platform === 'web' && session.projectId === project.id
    );
    expect(listAllSessions()).toHaveLength(sessionsBeforeRun + 1);
    expect(newSession).toBeDefined();
    expect(onDelivery).toHaveBeenCalledWith({
      platform: 'web',
      destinationId: newSession!.id,
      sessionId: expect.any(String),
    });
    const sessionDetail = (await (
      await fetch(`${baseUrl}/api/sessions/${newSession!.id}`)
    ).json()) as {
      messages: Array<{ role: string; content: string; usage?: { duration_ms?: number } }>;
    };
    expect(sessionDetail.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'ok',
          usage: expect.objectContaining({ duration_ms: expect.any(Number) }),
        }),
      ])
    );

    const updated = await fetch(`${baseUrl}/api/schedules/${added.schedule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'discord',
        channelId: 'thread-456',
        type: 'once',
        runAt: new Date(Date.now() + 60_000).toISOString(),
        message: '更新後の予定',
        label: '編集済み',
      }),
    });
    expect(updated.status).toBe(200);
    expect(scheduler.get(added.schedule.id)).toEqual(
      expect.objectContaining({
        platform: 'discord',
        channelId: 'thread-456',
        type: 'once',
        message: '更新後の予定',
        label: '編集済み',
        enabled: true,
      })
    );

    const toggled = await fetch(`${baseUrl}/api/schedules/${added.schedule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggled.status).toBe(200);
    expect(scheduler.get(added.schedule.id)?.enabled).toBe(false);

    const removed = await fetch(`${baseUrl}/api/schedules/${added.schedule.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(scheduler.get(added.schedule.id)).toBeUndefined();
  });

  it('adds cached destination labels to schedule responses without replacing IDs', async () => {
    scheduler.add({
      type: 'cron',
      expression: '0 9 * * *',
      message: 'Discordへ送る',
      platform: 'discord',
      channelId: 'discord-channel-1',
    });
    destinationLabelResolverRef.current = (platform, destinationId) =>
      platform === 'discord' && destinationId === 'discord-channel-1'
        ? '#dev_xangi / 予定の表示改善'
        : undefined;

    const response = await fetch(`${baseUrl}/api/schedules`);
    const body = (await response.json()) as {
      schedules: Array<{ channelId: string; destinationLabel?: string }>;
    };

    expect(body.schedules[0]).toMatchObject({
      channelId: 'discord-channel-1',
      destinationLabel: '#dev_xangi / 予定の表示改善',
    });

    const createResponse = await fetch(`${baseUrl}/api/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'cron',
        expression: '0 10 * * *',
        message: 'もう一件送る',
        platform: 'discord',
        channelId: 'discord-channel-1',
      }),
    });
    const created = (await createResponse.json()) as {
      schedule: { channelId: string; destinationLabel?: string };
    };
    expect(created.schedule).toMatchObject({
      channelId: 'discord-channel-1',
      destinationLabel: '#dev_xangi / 予定の表示改善',
    });
  });

  it('stores elapsed time on failed Web schedule results', async () => {
    runner.persistResults = true;
    runner.nextError = new Error('scheduled failure');
    const sessionsBeforeRun = listAllSessions().length;

    await expect(
      scheduler.getAgentRunner('web')?.('失敗する予定', '__new__', {
        id: 'web-failure',
        type: 'cron',
        expression: '0 9 * * *',
        message: '失敗する予定',
        channelId: '__new__',
        platform: 'web',
        createdAt: new Date().toISOString(),
        enabled: true,
      })
    ).rejects.toThrow('scheduled failure');

    const failedSession = listAllSessions().find(
      (session) => session.platform === 'web' && !session.projectId
    );
    expect(listAllSessions()).toHaveLength(sessionsBeforeRun + 1);
    expect(failedSession).toBeDefined();
    const detail = (await (await fetch(`${baseUrl}/api/sessions/${failedSession!.id}`)).json()) as {
      messages: Array<{ role: string; content: string; usage?: { duration_ms?: number } }>;
    };
    expect(detail.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'error',
          content: 'scheduled failure',
          usage: expect.objectContaining({ duration_ms: expect.any(Number) }),
        }),
      ])
    );
  });

  it('creates logical Projects without directories and injects their prompt into Web turns', async () => {
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '調査',
        prompt: '一次情報を優先して回答してください',
      }),
    });
    const { project } = (await projectResponse.json()) as {
      project: { id: string; name: string; prompt: string };
    };
    expect(projectResponse.status).toBe(201);
    expect(project.name).toBe('調査');
    expect(existsSync(join(testDir, 'projects'))).toBe(false);

    const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    });
    const { sessionId } = (await sessionResponse.json()) as { sessionId: string };
    expect(getSessionEntry(sessionId)?.projectId).toBe(project.id);

    const filteredResponse = await fetch(
      `${baseUrl}/api/sessions?projectId=${encodeURIComponent(project.id)}`
    );
    const filtered = (await filteredResponse.json()) as {
      sessions: Array<{ id: string; projectId?: string }>;
    };
    expect(filtered.sessions).toEqual([
      expect.objectContaining({ id: sessionId, projectId: project.id }),
    ]);

    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: sessionId, message: '調べて' }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runner.prompts.at(-1)).toContain('一次情報を優先して回答してください');
    expect(runner.prompts.at(-1)).toContain('調べて');
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${sessionId}`);
    await readSSEUntilDone((await send).body);
  });

  it('deletes a Project while keeping its conversations as ungrouped sessions', async () => {
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '削除対象' }),
    });
    const { project } = (await projectResponse.json()) as { project: { id: string } };
    const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    });
    const { sessionId } = (await sessionResponse.json()) as { sessionId: string };

    const removed = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ movedSessionCount: 1 });
    expect(getSessionEntry(sessionId)?.projectId).toBeUndefined();

    const projects = (await (await fetch(`${baseUrl}/api/projects`)).json()) as {
      projects: Array<{ id: string }>;
    };
    expect(projects.projects.some((candidate) => candidate.id === project.id)).toBe(false);
  });

  it('refuses to delete a Project used by a schedule', async () => {
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '予定あり' }),
    });
    const { project } = (await projectResponse.json()) as { project: { id: string } };
    scheduler.add({
      platform: 'web',
      projectId: project.id,
      channelId: '__new__',
      type: 'cron',
      expression: '0 9 * * *',
      message: '確認',
    });

    const removed = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(409);
    expect(await removed.json()).toEqual({ error: 'Projectはスケジュールで使用中です' });
  });

  it('moves an existing Web conversation and inherits the Project backend settings', async () => {
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '実装',
        backend: 'codex',
        model: 'gpt-test',
        effort: 'high',
      }),
    });
    const { project } = (await projectResponse.json()) as {
      project: { id: string; backend: string; model: string; effort: string };
    };
    expect(projectResponse.status).toBe(201);
    expect(project).toMatchObject({ backend: 'codex', model: 'gpt-test', effort: 'high' });

    const created = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json()) as {
      sessionId: string;
    };
    setProviderSessionId(created.sessionId, 'provider-old', 'claude-code');
    logPrompt(testDir, created.sessionId, '以前の相談');
    logResponse(testDir, created.sessionId, { result: '以前の回答' });
    const moved = await fetch(`${baseUrl}/api/sessions/${created.sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(moved.status).toBe(200);
    expect(getSessionEntry(created.sessionId)?.projectId).toBe(project.id);

    const listed = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{
        id: string;
        backend?: { backend: string; model?: string; effort?: string; source: string };
      }>;
    };
    expect(listed.sessions.find((session) => session.id === created.sessionId)?.backend).toEqual({
      backend: 'codex',
      model: 'gpt-test',
      effort: 'high',
      source: 'project',
    });

    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: created.sessionId, message: '実装して' }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runner.options.at(-1)).toMatchObject({
      defaultBackend: 'codex',
      defaultModel: 'gpt-test',
      defaultEffort: 'high',
    });
    expect(runner.prompts.at(-1)).toContain('以前の相談');
    expect(runner.prompts.at(-1)).toContain('以前の回答');
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${created.sessionId}`);
    await readSSEUntilDone((await send).body);

    const cleared = await fetch(`${baseUrl}/api/sessions/${created.sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: null }),
    });
    expect(cleared.status).toBe(200);
    expect(getSessionEntry(created.sessionId)?.projectId).toBeUndefined();
  });

  it('serves the workspace app route and browses workspace-relative files', async () => {
    mkdirSync(join(testDir, 'notes'));
    writeFileSync(join(testDir, 'notes', 'hello.md'), '# Hello\n');
    writeFileSync(join(testDir, '.env'), 'SECRET=value\n');

    const page = await fetch(`${baseUrl}/workspace`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root"></div>');

    const root = (await (await fetch(`${baseUrl}/api/workspace/entries?path=`)).json()) as {
      entries: Array<{ name: string; type: string }>;
    };
    expect(root.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'notes', type: 'directory' })])
    );
    expect(root.entries.some((entry) => entry.name === '.env')).toBe(false);

    const file = (await (
      await fetch(`${baseUrl}/api/workspace/file?path=notes%2Fhello.md`)
    ).json()) as { content: string; version: string };
    expect(file.content).toBe('# Hello\n');
    expect(file.version).toMatch(/^[a-f0-9]{64}$/);
  });

  it('registers a workspace and snapshots it for Project sessions and editor requests', async () => {
    const alternate = join(testDir, 'alternate-workspace');
    mkdirSync(alternate);
    writeFileSync(join(alternate, 'only-here.md'), '# Alternate\n');

    const registeredResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alternate', path: alternate }),
    });
    expect(registeredResponse.status).toBe(201);
    const registered = (await registeredResponse.json()) as {
      workspace: { id: string; path: string };
    };

    const entries = (await (
      await fetch(
        `${baseUrl}/api/workspace/entries?path=&workspaceId=${encodeURIComponent(registered.workspace.id)}`
      )
    ).json()) as { entries: Array<{ name: string }> };
    expect(entries.entries.map((entry) => entry.name)).toContain('only-here.md');

    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alternate Project', workspaceId: registered.workspace.id }),
    });
    const project = (await projectResponse.json()) as { project: { id: string } };
    const created = (await (
      await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.project.id }),
      })
    ).json()) as { sessionId: string };

    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: created.sessionId, message: 'work here' }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runner.options.at(-1)?.workdir).toBe(realpathSync(alternate));
    expect(getSessionEntry(created.sessionId)).toMatchObject({
      workspaceId: registered.workspace.id,
      workspacePath: realpathSync(alternate),
    });
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${created.sessionId}`);
    await readSSEUntilDone((await send).body);
  });

  it('unregisters only unused workspaces and keeps their files', async () => {
    const unusedPath = join(testDir, 'unused-workspace');
    const projectPath = join(testDir, 'project-workspace');
    mkdirSync(unusedPath);
    mkdirSync(projectPath);
    writeFileSync(join(unusedPath, 'keep.txt'), 'keep');

    const register = async (name: string, path: string) => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { workspace: { id: string } };
    };
    const unused = await register('unused', unusedPath);
    const used = await register('used', projectPath);

    const defaultResponse = await fetch(`${baseUrl}/api/workspaces/default`, {
      method: 'DELETE',
    });
    expect(defaultResponse.status).toBe(409);

    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Uses Workspace', workspaceId: used.workspace.id }),
    });
    expect(projectResponse.status).toBe(201);
    const usedResponse = await fetch(`${baseUrl}/api/workspaces/${used.workspace.id}`, {
      method: 'DELETE',
    });
    expect(usedResponse.status).toBe(409);
    expect(await usedResponse.json()).toEqual({
      error: 'WorkspaceはProject「Uses Workspace」で使用中です',
    });

    const removedResponse = await fetch(`${baseUrl}/api/workspaces/${unused.workspace.id}`, {
      method: 'DELETE',
    });
    expect(removedResponse.status).toBe(200);
    expect(readFileSync(join(unusedPath, 'keep.txt'), 'utf8')).toBe('keep');
    const listed = (await (await fetch(`${baseUrl}/api/workspaces`)).json()) as {
      workspaces: Array<{ id: string }>;
    };
    expect(listed.workspaces.some((workspace) => workspace.id === unused.workspace.id)).toBe(false);
  });

  it('rejects unregistering a workspace referenced by an existing session', async () => {
    const sessionPath = join(testDir, 'session-workspace');
    mkdirSync(sessionPath);
    const registeredResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'session-used', path: sessionPath }),
    });
    const registered = (await registeredResponse.json()) as { workspace: { id: string } };
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Session Project', workspaceId: registered.workspace.id }),
    });
    const project = (await projectResponse.json()) as { project: { id: string } };
    const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.project.id }),
    });
    expect(sessionResponse.status).toBe(200);
    const moveProject = await fetch(`${baseUrl}/api/projects/${project.project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default' }),
    });
    expect(moveProject.status).toBe(200);

    const response = await fetch(`${baseUrl}/api/workspaces/${registered.workspace.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Workspaceは既存の会話で使用中です' });
  });

  it('serves the Extensions app route with the official catalog in fresh state', async () => {
    const page = await fetch(`${baseUrl}/extensions`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root"></div>');

    const response = await fetch(`${baseUrl}/api/extensions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      degraded: boolean;
      extensions: Array<Record<string, unknown>>;
      issues: unknown[];
    };
    expect(body).toEqual({
      degraded: false,
      extensions: [
        expect.objectContaining({
          id: 'xangi-search',
          displayName: 'xangi-search',
          installed: false,
          setupRepositoryUrl: 'https://github.com/karaage0703/xangi-search',
        }),
      ],
      issues: [],
    });
    expect(body.extensions[0]).not.toHaveProperty('version');
  });

  it('completes the Extensions API response when one repository manifest is unsupported', async () => {
    const sourceRoot = join(
      process.env.DATA_DIR!,
      'extensions',
      'sources',
      'example--old-extension'
    );
    mkdirSync(sourceRoot, { recursive: true });
    const manifestPath = join(sourceRoot, 'xangi-extension.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, id: 'old-extension', version: '1.0.0' })
    );
    writeFileSync(
      join(process.env.DATA_DIR!, 'extension-sources.json'),
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            repository: 'example/old-extension',
            repositoryUrl: 'https://github.com/example/old-extension',
            commitSha: 'a'.repeat(40),
            manifestPath,
            assetSha256: 'b'.repeat(64),
            addedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      })
    );

    const response = await fetch(`${baseUrl}/api/extensions`, {
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      degraded: true,
      extensions: [expect.objectContaining({ id: 'xangi-search' })],
      issues: [expect.objectContaining({ code: 'manifest-invalid' })],
    });
  });

  it('rejects unsafe extension repository URLs and cross-origin repository additions', async () => {
    const blocked = await fetch(`${baseUrl}/api/extensions/repositories`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/example/demo' }),
    });
    expect(blocked.status).toBe(403);

    const invalid = await fetch(`${baseUrl}/api/extensions/repositories`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/example/demo' }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: 'Use a public https://github.com/owner/repository URL',
    });
  });

  it('opens a dedicated update conversation from the Extensions app', async () => {
    const blocked = await fetch(`${baseUrl}/api/extensions/demo-extension/update`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
    });
    expect(blocked.status).toBe(403);

    const response = await fetch(`${baseUrl}/api/extensions/demo-extension/update`, {
      method: 'POST',
      headers: { Origin: baseUrl },
    });
    expect(response.status).toBe(200);
    const update = (await response.json()) as {
      sessionId: string;
      prompt: string;
      displayMessage: string;
    };
    expect(update.prompt).toContain('xangi tool extension_update');
    expect(update.displayMessage).toBe('Demo Extension の更新を確認します。');
    expect(getSessionEntry(update.sessionId)).toMatchObject({
      platform: 'web',
      title: 'Update: Demo Extension',
    });
  });

  it('installs only configured extensions and rejects cross-origin mutations', async () => {
    const extensionDir = join(testDir, 'demo-extension');
    const executable = join(extensionDir, 'extension-cli');
    const manifestPath = join(extensionDir, 'xangi-extension.json');
    mkdirSync(extensionDir);
    writeFileSync(
      executable,
      `#!/usr/bin/env node
import http from 'node:http';
const workspace = process.argv[process.argv.indexOf('--workspace') + 1];
const token = process.env.XANGI_EXTENSION_AUTH_TOKEN;
const server = http.createServer((request, response) => {
  response.writeHead(request.headers.authorization === \`Bearer \${token}\` ? 200 : 401, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ service: 'demo-extension' }));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ schemaVersion: 2, event: 'ready', id: 'demo-extension', baseUrl: \`http://127.0.0.1:\${address.port}\`, workspace }));
});
process.stdin.resume();
process.stdin.on('end', () => server.close());
`
    );
    writeFileSync(join(extensionDir, 'XANGI_SETUP.md'), '# Setup\n');
    writeFileSync(join(extensionDir, 'README.md'), '# Demo Extension\n\nExample workflows.\n');
    chmodSync(executable, 0o755);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        id: 'demo-extension',
        displayName: 'Demo Extension',
        version: '1.0.0',
        entrypoint: 'extension-cli',
        runtime: { kind: 'managed-http' },
        capabilities: [],
      })
    );
    process.env.XANGI_EXTENSION_DEV_MANIFESTS = JSON.stringify([manifestPath]);

    const blocked = await fetch(`${baseUrl}/api/extensions/demo-extension/install`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
    });
    expect(blocked.status).toBe(403);

    const installed = await fetch(`${baseUrl}/api/extensions/demo-extension/install`, {
      method: 'POST',
      headers: { Origin: baseUrl },
    });
    expect(installed.status).toBe(200);
    expect(await installed.json()).toEqual({
      extension: expect.objectContaining({ id: 'demo-extension', installed: true, healthy: true }),
    });

    const setupResponse = await fetch(`${baseUrl}/api/extensions/demo-extension/setup`, {
      method: 'POST',
      headers: { Origin: baseUrl },
    });
    expect(setupResponse.status).toBe(200);
    const setup = (await setupResponse.json()) as {
      sessionId: string;
      prompt: string;
      displayMessage: string;
    };
    expect(setup.prompt).toContain(join(extensionDir, 'XANGI_SETUP.md'));
    expect(setup.prompt).toContain(join(extensionDir, 'README.md'));
    expect(setup.prompt).toContain('その利用者向けの活用提案まで続けてください');
    expect(setup.prompt).toContain('未決のまま「セットアップ完了」と報告しない');
    expect(setup.displayMessage).toBe('Demo Extension のセットアップを開始します。');
    expect(getSessionEntry(setup.sessionId)).toMatchObject({
      platform: 'web',
      title: 'Setup: Demo Extension',
    });

    const blockedUninstall = await fetch(
      `${baseUrl}/api/extensions/demo-extension/uninstall`,
      {
        method: 'POST',
        headers: { Origin: 'https://attacker.example' },
      }
    );
    expect(blockedUninstall.status).toBe(403);

    const uninstallResponse = await fetch(
      `${baseUrl}/api/extensions/demo-extension/uninstall`,
      {
        method: 'POST',
        headers: { Origin: baseUrl },
      }
    );
    expect(uninstallResponse.status).toBe(200);
    const uninstall = (await uninstallResponse.json()) as {
      sessionId: string;
      prompt: string;
      displayMessage: string;
    };
    expect(uninstall.prompt).toContain(join(extensionDir, 'XANGI_SETUP.md'));
    expect(uninstall.prompt).toContain('利用者が選択する前にworkspaceを変更せず');
    expect(uninstall.prompt).toContain('hook、skills、AGENTS.md');
    expect(uninstall.prompt).toContain('xangi tool extension_uninstall --id demo-extension');
    expect(uninstall.displayMessage).toBe('Demo Extension の削除準備を開始します。');
    expect(getSessionEntry(uninstall.sessionId)).toMatchObject({
      platform: 'web',
      title: 'Remove: Demo Extension',
    });

    const catalogAfterConversation = (await (
      await fetch(`${baseUrl}/api/extensions`)
    ).json()) as { extensions: Array<{ id: string; installed: boolean }> };
    expect(catalogAfterConversation.extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'demo-extension', installed: true }),
      ])
    );
  });

  it('proxies a declared extension UI and its same-origin service requests', async () => {
    const upstream = createServer(async (request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ service: 'ui-extension' }));
        return;
      }
      if (request.url === '/ui') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<h1>xangi search</h1>');
        return;
      }
      if (request.url === '/settings' && request.method === 'PUT') {
        let body = '';
        for await (const chunk of request) body += chunk;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(body);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('upstream did not listen');

    const extensionDir = join(testDir, 'ui-extension');
    const executable = join(extensionDir, 'extension-cli');
    const manifestPath = join(extensionDir, 'xangi-extension.json');
    mkdirSync(extensionDir);
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const workspace = process.argv[process.argv.indexOf('--workspace') + 1];
console.log(JSON.stringify({ schemaVersion: 2, event: 'ready', id: 'ui-extension', baseUrl: 'http://127.0.0.1:${address.port}', workspace }));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`
    );
    chmodSync(executable, 0o755);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        id: 'ui-extension',
        displayName: 'UI Extension',
        version: '1.0.0',
        entrypoint: 'extension-cli',
        runtime: { kind: 'managed-http' },
        ui: { capability: 'workspace.search', path: '/ui' },
        capabilities: [
          {
            id: 'workspace.search',
            protocol: 'http',
            healthPath: '/health',
          },
        ],
      })
    );
    process.env.XANGI_EXTENSION_DEV_MANIFESTS = JSON.stringify([manifestPath]);
    try {
      const installed = await fetch(`${baseUrl}/api/extensions/ui-extension/install`, {
        method: 'POST',
        headers: { Origin: baseUrl },
      });
      expect(installed.status).toBe(200);

      const page = await fetch(`${baseUrl}/api/extensions/ui-extension/ui`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(page.headers.get('content-security-policy')).toContain("form-action 'self'");
      expect(page.headers.get('content-security-policy')).toContain("base-uri 'self'");
      expect(await page.text()).toContain('<base href="./service/">');

      const blocked = await fetch(`${baseUrl}/api/extensions/ui-extension/service/settings`, {
        method: 'PUT',
        headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: '{"mode":"keyword"}',
      });
      expect(blocked.status).toBe(403);

      const saved = await fetch(`${baseUrl}/api/extensions/ui-extension/service/settings`, {
        method: 'PUT',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: '{"mode":"keyword"}',
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ mode: 'keyword' });
    } finally {
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('saves workspace files and returns 409 for a stale editor version', async () => {
    writeFileSync(join(testDir, 'memo.md'), 'before\n');
    const opened = (await (await fetch(`${baseUrl}/api/workspace/file?path=memo.md`)).json()) as {
      version: string;
    };

    const saved = await fetch(`${baseUrl}/api/workspace/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'memo.md',
        content: 'after\n',
        version: opened.version,
      }),
    });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(testDir, 'memo.md'), 'utf8')).toBe('after\n');

    const stale = await fetch(`${baseUrl}/api/workspace/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'memo.md',
        content: 'stale\n',
        version: opened.version,
      }),
    });
    expect(stale.status).toBe(409);
    expect(readFileSync(join(testDir, 'memo.md'), 'utf8')).toBe('after\n');
  });

  it('rejects workspace paths outside the configured workspace', async () => {
    const traversal = await fetch(
      `${baseUrl}/api/workspace/file?path=${encodeURIComponent('../secret.md')}`
    );
    expect(traversal.status).toBe(400);

    const absolute = await fetch(
      `${baseUrl}/api/workspace/file?path=${encodeURIComponent('/etc/hosts')}`
    );
    expect(absolute.status).toBe(400);
  });

  it('POST /api/sessions/:id/discord-continue forwards input to the Discord bridge', async () => {
    const id = createSession('discord-thread-123', { platform: 'discord' });
    const continueSession = vi.fn().mockResolvedValue({ response: 'Discord response' });
    discordRemoteInputRef.current = { continueSession };

    const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/discord-continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '同じ会話で続けて' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, response: 'Discord response' });
    expect(continueSession).toHaveBeenCalledWith({
      appSessionId: id,
      message: '同じ会話で続けて',
    });
  });

  it('POST /api/sessions/:id/discord-continue rejects non-Discord sessions', async () => {
    const id = createSession('web-chat:test', { platform: 'web' });
    const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/discord-continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '送信' }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Discordセッションが見つかりません' });
  });

  it('POST /api/sessions/:id/discord-continue reports unavailable Discord bridge', async () => {
    const id = createSession('discord-thread-456', { platform: 'discord' });
    const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/discord-continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '送信' }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Discordが起動していません' });
  });

  it('POST /api/sessions/:id/resume injects the source session history into the first Web turn', async () => {
    const sourceId = createSession('discord-thread-1', {
      platform: 'discord',
      title: 'Discord source',
    });
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(
      join(logsDir, `${sourceId}.jsonl`),
      [
        JSON.stringify({
          id: 'source-user',
          role: 'user',
          content: '元のDiscordで話した質問',
          createdAt: '2026-07-30T00:00:00.000Z',
        }),
        JSON.stringify({
          id: 'source-assistant',
          role: 'assistant',
          content: { result: '元のDiscordで返した回答' },
          createdAt: '2026-07-30T00:01:00.000Z',
        }),
      ].join('\n') + '\n'
    );

    const resumeResponse = await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(sourceId)}/resume`,
      { method: 'POST' }
    );
    const resumed = (await resumeResponse.json()) as { sessionId: string; sourceId: string };
    expect(resumeResponse.status).toBe(200);
    expect(resumed.sourceId).toBe(sourceId);
    expect(getSessionEntry(resumed.sessionId)?.resumedFromSessionId).toBe(sourceId);

    // クリック後、初回送信前にxangiが再起動しても引継ぎ元を失わない。
    initSessions(testDir);
    expect(getSessionEntry(resumed.sessionId)?.resumedFromSessionId).toBe(sourceId);

    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appSessionId: resumed.sessionId,
        message: '前の話を覚えてる？',
      }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(runner.prompts[0]).toContain('<prefetched-history platform="Discord">');
    expect(runner.prompts[0]).toContain('元のDiscordで話した質問');
    expect(runner.prompts[0]).toContain('元のDiscordで返した回答');
    expect(runner.prompts[0]).toContain('前の話を覚えてる？');
    expect(getSessionEntry(resumed.sessionId)?.resumedFromSessionId).toBe(sourceId);

    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${resumed.sessionId}`);
    await readSSEUntilDone((await send).body);
    expect(getSessionEntry(resumed.sessionId)?.resumedFromSessionId).toBeUndefined();
  });

  it('GET /api/web-commands exposes command metadata for the browser palette', async () => {
    const res = await fetch(`${baseUrl}/api/web-commands`);
    const data = (await res.json()) as {
      commands: Array<{
        name: string;
        usage: string;
        description: string;
        options?: Array<{ name: string; choices?: Array<{ value: string }> }>;
      }>;
    };

    expect(res.status).toBe(200);
    expect(data.commands.find((command) => command.name === 'help')?.usage).toBe('/help');
    expect(data.commands.find((command) => command.name === 'models')?.usage).toBe(
      '/models [backend]'
    );
    expect(data.commands.find((command) => command.name === 'skill')?.description).toContain(
      'スキル'
    );
    expect(
      data.commands
        .find((command) => command.name === 'llmmode')
        ?.options?.[0].choices?.map((choice) => choice.value)
    ).toEqual(['show', 'agent', 'chat', 'default']);

    const dynamicRes = await fetch(`${baseUrl}/api/web-commands?backend=codex&model=gpt-test`);
    const dynamicData = (await dynamicRes.json()) as typeof data;
    const backendSet = dynamicData.commands
      .find((command) => command.name === 'backend')
      ?.options?.find((option) => option.name === 'set');
    expect(backendSet?.options?.[1].choices?.map((choice) => choice.value)).toEqual([
      '--model=default',
      '--model=gpt-test',
    ]);
    expect(backendSet?.options?.[2].choices?.map((choice) => choice.value)).toEqual([
      '--effort=default',
      '--effort=high',
    ]);
  });

  it('POST /api/web-commands returns inline help without starting the agent', async () => {
    const res = await fetch(`${baseUrl}/api/web-commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '/help' }),
    });
    const data = (await res.json()) as { kind: string; message: string };

    expect(res.status).toBe(200);
    expect(data.kind).toBe('message');
    expect(data.message).toContain('/skill [name] [args]');
    expect(runner.prompts).toEqual([]);
  });

  it('POST /api/web-commands retitles the current Web conversation with AI', async () => {
    const id = createWebSession({ title: '古いタイトル' });
    logPrompt(testDir, id, '<system-context>内部</system-context>Web会話のタイトルを直す');
    runner.nextResult = '「Web会話タイトルの再生成。」';

    const res = await fetch(`${baseUrl}/api/web-commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, input: '/retitle' }),
    });
    const data = (await res.json()) as { kind: string; message: string };

    expect(res.status).toBe(200);
    expect(data).toEqual({
      kind: 'message',
      message: '会話タイトルを「Web会話タイトルの再生成」へ変更しました。',
    });
    expect(getSessionEntry(id)?.title).toBe('Web会話タイトルの再生成');
    expect(runner.prompts.at(-1)).toContain('Web会話のタイトルを直す');
    expect(runner.options.at(-1)).toEqual(
      expect.objectContaining({ internalTask: true, platform: 'web' })
    );
  });

  it('POST /api/web-commands retitle rejects a non-Web session', async () => {
    const id = createSession('discord-thread-retitle', { platform: 'discord' });
    const res = await fetch(`${baseUrl}/api/web-commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, input: '/retitle' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Web会話を開いてから実行してください' });
  });

  it('POST /api/web-commands lists skills and converts a selected skill into a validated chat prompt', async () => {
    const skillDir = join(testDir, 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo from Web UI\n---\n'
    );

    const listRes = await fetch(`${baseUrl}/api/web-commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '/skill' }),
    });
    const list = (await listRes.json()) as {
      kind: string;
      skills: Array<{ name: string; description: string }>;
    };
    expect(list.kind).toBe('skills');
    expect(list.skills).toContainEqual({
      name: 'demo-skill',
      description: 'Demo from Web UI',
    });

    const runRes = await fetch(`${baseUrl}/api/web-commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '/skill demo-skill target-file.md' }),
    });
    const run = (await runRes.json()) as {
      kind: string;
      displayMessage: string;
      message: string;
    };
    expect(run.kind).toBe('chat');
    expect(run.displayMessage).toBe('/skill demo-skill target-file.md');
    expect(run.message).toContain('スキル「demo-skill」');
    expect(run.message).toContain('引数: target-file.md');
  });

  it('POST /api/web-commands returns a visible error for unknown commands', async () => {
    const res = await fetch(`${baseUrl}/api/web-commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '/does-not-exist' }),
    });
    const data = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(data.error).toBe('Unknown command: /does-not-exist');
  });

  it('POST /api/chat enforces a busy lock per appSessionId (returns 409 on concurrent send to same session)', async () => {
    const created = await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json();
    const id = created.sessionId;

    // 1 本目（pending のままにする）
    const first = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'first' }),
    });

    // first がランナーに到達するまで小待機
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runner.pending.size).toBe(1);

    // 同じセッションに 2 本目 → 409
    const concurrent = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'second' }),
    });
    expect(concurrent.status).toBe(409);

    // 1 本目を解放して、後始末
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${id}`);
    const r1 = await first;
    await readSSEUntilDone(r1.body);
  });

  it('hides reply suggestion markup from Web SSE and returns structured suggestions', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    runner.nextResult =
      '回答本文\n<xangi_reply_suggestions>["続けて","詳しく","別案"]</xangi_reply_suggestions>';

    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: '質問' }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${id}`);
    const events = (await readSSEUntilDone((await send).body)).events;
    const textEvent = events.find((e) => e.event === 'text');
    const done = events.find((e) => e.event === 'done');

    expect(runner.prompts.at(-1)).toContain('<xangi_reply_suggestions>');
    expect(textEvent?.data.fullText).toBe('回答本文');
    expect(done?.data.response).toBe('回答本文');
    expect(done?.data.replySuggestions).toEqual(['続けて', '詳しく', '別案']);
  });

  it('stores terminal inbox suggestions for the session detail API', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    runner.persistResults = true;
    runner.nextResult =
      '回答本文\n<xangi_reply_suggestions>["そのまま進めて","詳細を教えて","別案を見せて"]</xangi_reply_suggestions>';

    const accepted = await fetch(`${baseUrl}/api/terminal/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, text: '次はどうする？', source: 'even-g2' }),
    });
    expect(accepted.status).toBe(202);

    const ctx = `${WEB_CHAT_CONTEXT_PREFIX}${id}`;
    for (let i = 0; i < 50 && !runner.pending.has(ctx); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runner.prompts.at(-1)).toContain('<xangi_reply_suggestions>');
    expect(runner.release(ctx)).toBe(true);

    let detail: {
      messages: Array<{ role: string; content: string; replySuggestions: string[] }>;
    } | null = null;
    for (let i = 0; i < 50; i++) {
      detail = await (await fetch(`${baseUrl}/api/sessions/${id}`)).json();
      if (detail.messages.some((message) => message.role === 'assistant')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const assistant = detail?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.content).toBe('回答本文');
    expect(assistant?.replySuggestions).toEqual(['そのまま進めて', '詳細を教えて', '別案を見せて']);
    // inbox handler は 202 返却後に非同期実行されるため、finally まで完了させる。
    await new Promise((r) => setTimeout(r, 20));
  });

  it('POST /api/chat allows two different sessions to stream concurrently', async () => {
    const a = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const b = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;

    const sendA = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: a, message: 'hello A' }),
    });
    const sendB = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: b, message: 'hello B' }),
    });

    // 両方が runner に到達するまで待つ
    for (let i = 0; i < 50 && runner.pending.size < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runner.pending.size).toBe(2);
    expect([...runner.pending.keys()].sort()).toEqual(
      [`${WEB_CHAT_CONTEXT_PREFIX}${a}`, `${WEB_CHAT_CONTEXT_PREFIX}${b}`].sort()
    );

    // 両方解放
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${a}`);
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${b}`);

    const [resA, resB] = await Promise.all([sendA, sendB]);
    const evA = await readSSEUntilDone(resA.body);
    const evB = await readSSEUntilDone(resB.body);
    expect(evA.events.find((e) => e.event === 'done')).toBeTruthy();
    expect(evB.events.find((e) => e.event === 'done')).toBeTruthy();
  });

  it('POST /api/sessions/:id/stop destroys the runner but keeps the session', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const ctx = `${WEB_CHAT_CONTEXT_PREFIX}${id}`;

    // 1 回 runStream を回して runner を pool に入れる
    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'hi' }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.release(ctx);
    const r1 = await send;
    await readSSEUntilDone(r1.body);

    // この時点で hasRunner=true
    expect(runner.hasRunner(ctx)).toBe(true);

    // /stop で destroy
    const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    });
    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.stopped).toBe(true);

    // runner は破棄、セッション自体は残る
    expect(runner.destroyed.has(ctx)).toBe(true);
    expect(runner.hasRunner(ctx)).toBe(false);
    expect(getSessionEntry(id)).toBeDefined();
  });

  it('GET /api/sessions marks only a running turn as active', async () => {
    const a = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const b = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;

    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: a, message: 'hi' }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const runningList = await (await fetch(`${baseUrl}/api/sessions`)).json();
    const sa = runningList.sessions.find((s: { id: string }) => s.id === a);
    const sb = runningList.sessions.find((s: { id: string }) => s.id === b);
    expect(sa.isActive).toBe(true);
    expect(sb.isActive).toBe(false);

    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${a}`);
    await readSSEUntilDone((await send).body);

    const completedList = await (await fetch(`${baseUrl}/api/sessions`)).json();
    const completed = completedList.sessions.find((s: { id: string }) => s.id === a);
    expect(completed.isActive).toBe(false);
  });

  it('GET /api/sessions includes monitor source metadata', async () => {
    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      meta?: { processCwd?: string; workdir?: string; pid?: number };
    };

    expect(list.meta?.workdir).toBe(testDir);
    expect(list.meta?.processCwd).toBe(process.cwd());
    expect(typeof list.meta?.pid).toBe('number');
  });

  it('GET /api/sessions exposes whether provider context is resumable', async () => {
    const id = createSession('stateless-channel', {
      platform: 'discord',
      backend: 'workspace-search',
    });
    setProviderSessionId(
      id,
      'workspace-search:stateless-channel',
      'workspace-search',
      undefined,
      undefined,
      'stateless'
    );

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string; sessionMode?: string }>;
    };

    expect(list.sessions.find((session) => session.id === id)?.sessionMode).toBe('stateless');
  });

  it('recognizes existing extension sessions that predate provider mode metadata', async () => {
    await installExtensionBackendFixture('legacy-extension-backend', 'Legacy extension backend');
    const id = createSession('legacy-stateless-channel', {
      platform: 'discord',
      backend: 'legacy-extension-backend',
    });

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string; sessionMode?: string }>;
    };

    expect(list.sessions.find((session) => session.id === id)?.sessionMode).toBe('stateless');
  });

  it('serves the React shell and exposes inter-chat state through config', async () => {
    const config = (await (await fetch(`${baseUrl}/api/config`)).json()) as {
      interChatEnabled?: boolean;
      allowedBackends?: string[];
      uploadMaxBytes?: number;
      completionShowElapsed?: boolean;
    };
    const html = await (await fetch(baseUrl)).text();
    const stylesheetPath = html.match(/href="([^"]+\.css)"/)?.[1];

    expect(config.interChatEnabled).toBe(false);
    expect(config.allowedBackends).toEqual(['claude-code', 'codex']);
    expect(config.uploadMaxBytes).toBe(64 * 1024 * 1024);
    expect(config.completionShowElapsed).toBe(true);
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('/app/assets/');
    expect(html).toContain('viewport-fit=cover');
    expect(stylesheetPath).toBeTruthy();

    const stylesheet = await (await fetch(`${baseUrl}${stylesheetPath}`)).text();
    expect(stylesheet).toContain('safe-area-inset-top');
    expect(stylesheet).toContain('safe-area-inset-right');
    expect(stylesheet).toContain('safe-area-inset-bottom');
    expect(stylesheet).toContain('safe-area-inset-left');
    expect(stylesheet).toContain('(max-width:768px),(max-height:500px) and (hover:none)');

    const sourceStylesheet = readFileSync(
      join(process.cwd(), 'web-ui', 'src', 'styles.css'),
      'utf8'
    );
    const chatSource = readFileSync(join(process.cwd(), 'web-ui', 'src', 'Chat.tsx'), 'utf8');
    const confirmDialogSource = readFileSync(
      join(process.cwd(), 'web-ui', 'src', 'ConfirmDialog.tsx'),
      'utf8'
    );
    const workspaceSource = readFileSync(
      join(process.cwd(), 'web-ui', 'src', 'Workspace.tsx'),
      'utf8'
    );
    expect(sourceStylesheet).toMatch(
      /\.app-shell\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/s
    );
    expect(sourceStylesheet).toMatch(
      /\.sidebar\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s
    );
    expect(sourceStylesheet).toMatch(
      /\.session-list\s*\{[^}]*flex:\s*0 0 auto[^}]*overflow:\s*visible/s
    );
    expect(sourceStylesheet).toMatch(
      /\.app-shell\.sidebar-collapsed\s*\{[^}]*grid-template-columns:\s*0 minmax\(0,\s*1fr\)/s
    );
    expect(sourceStylesheet).toMatch(/\.session-project-tag\s*\{/);
    expect(sourceStylesheet).toMatch(/\.workspace\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
    expect(sourceStylesheet).toMatch(
      /\.workspace-file-controls select,\s*\.workspace-file-controls button\s*\{[^}]*font-weight:\s*400/s
    );
    expect(sourceStylesheet).toMatch(
      /\.pane\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*overflow:\s*hidden/s
    );
    expect(sourceStylesheet).toMatch(
      /\.pane-title\s*\{[^}]*width:\s*0[^}]*min-width:\s*0[^}]*flex:\s*1 1 0/s
    );
    expect(sourceStylesheet).toMatch(
      /\.pane-tabs > span > button:first-child\s*\{[^}]*width:\s*0[^}]*min-width:\s*0[^}]*flex:\s*1 1 0/s
    );
    expect(sourceStylesheet).toMatch(
      /\.pane-tabs > span > button:last-child\s*\{[^}]*z-index:\s*1[^}]*flex:\s*0 0 28px/s
    );
    expect(sourceStylesheet).toMatch(
      /\.panes-toolbar\s*\{[^}]*min-height:\s*40px[^}]*padding-top:\s*1px[^}]*padding-bottom:\s*1px/s
    );
    expect(sourceStylesheet).toMatch(
      /\.pane-tabs\s*\{[^}]*display:\s*flex[^}]*overflow-x:\s*auto[^}]*padding-top:\s*1px[^}]*padding-bottom:\s*1px[^}]*scrollbar-width:\s*none/s
    );
    expect(sourceStylesheet).toMatch(/\.pane-tabs::\-webkit-scrollbar\s*\{[^}]*display:\s*none/s);
    expect(sourceStylesheet).toMatch(/\.pane-tabs button\s*\{[^}]*min-height:\s*36px/s);
    expect(sourceStylesheet).toMatch(
      /\.add-pane\s*\{[^}]*min-height:\s*36px[^}]*padding:\s*4px 8px/s
    );
    expect(chatSource).toMatch(
      /<header className="panes-toolbar">[\s\S]*className="add-pane"[\s\S]*<\/header>[\s\S]*<div className="pane-tabs" role="tablist">/
    );
    expect(sourceStylesheet).toMatch(/\.session-copy strong\s*\{[^}]*font-weight:\s*500/s);
    expect(sourceStylesheet).toMatch(
      /\.session-row\.current \.session-copy strong\s*\{[^}]*font-weight:\s*600/s
    );
    expect(sourceStylesheet).toMatch(
      /@media \(max-width: 900px\)[\s\S]*grid-auto-rows:\s*minmax\(260px,\s*1fr\)[\s\S]*overflow-y:\s*auto/
    );
    expect(sourceStylesheet).toMatch(
      /\.code-block > pre code\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/s
    );
    expect(sourceStylesheet).toMatch(
      /\.code-block > pre code\[class\*='language-'\]\s*\{[^}]*white-space:\s*pre[^}]*overflow-wrap:\s*normal/s
    );
    expect(sourceStylesheet).toMatch(/\.plain-message\s*\{[^}]*white-space:\s*pre-wrap/s);
    expect(sourceStylesheet).toMatch(/\.markdown-message\s*\{[^}]*white-space:\s*normal/s);
    expect(chatSource).toMatch(
      /if \(activeRef\.current\) \{\s*requestAnimationFrame\(\(\) => draftRef\.current\?\.focus\(\)\);\s*\}/
    );
    expect(chatSource).toContain('会話を読み込み中…');
    expect(chatSource).toMatch(
      /detail && detail\.messages\.length === 0 && !detail\.hasMore && !liveTurn\.visible[\s\S]*まだメッセージがありません/
    );
    expect(chatSource).toContain("if (activeProjectId) params.set('projectId', activeProjectId)");
    expect(chatSource).toContain('projectId={activeProjectId || undefined}');
    expect(chatSource).toContain("jsonInit('POST', projectId ? { projectId } : {})");
    expect(chatSource).toContain('session-project-tag');
    expect(chatSource).toContain('className="projects-link"');
    expect(chatSource).toContain('className="project-view"');
    expect(chatSource).toContain('＋ 新規Project');
    expect(chatSource).toContain('Workspaceを追加');
    expect(chatSource).toContain('Workspaceを追加・管理');
    expect(chatSource).toContain('ディレクトリとファイルは削除しません');
    expect(chatSource.match(/className="notice" role="status"/g)).toHaveLength(2);
    expect(chatSource).toContain('Projectへ移動');
    expect(chatSource).toContain('既定のAI設定');
    expect(chatSource).toContain('project-context-chip');
    expect(sourceStylesheet).toMatch(/\.project-model-settings\s*\{/);
    expect(sourceStylesheet).toMatch(/\.pane-backend-badge\s*\{/);
    expect(chatSource).not.toContain('Project内の会話');
    expect(sourceStylesheet).toMatch(
      /\.projects-link\s*\{[^}]*border:\s*0[^}]*background:\s*transparent/s
    );
    expect(sourceStylesheet).toMatch(/\.project-view-list\s*\{/);
    expect(chatSource).toContain('SIDEBAR_COLLAPSED_KEY');
    expect(chatSource).toContain('new ResizeObserver(scrollToBottom)');
    expect(chatSource).toContain(
      'mutationObserver?.observe(viewport, { childList: true, subtree: true })'
    );
    expect(sourceStylesheet).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.workspace-markdown-preview\s*\{[^}]*font-size:\s*15px/s
    );
    expect(sourceStylesheet).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.workspace-editor-tabs button\s*\{[^}]*min-height:\s*32px[^}]*font-size:\s*13px/s
    );
    expect(sourceStylesheet).toMatch(
      /\.workspace-browser-shell\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s
    );
    expect(sourceStylesheet).toMatch(/\.workspace-file-panel\s*\{[^}]*overflow-y:\s*auto/s);
    expect(sourceStylesheet).not.toMatch(/\.workspace-browser-header\s*\{/);
    expect(sourceStylesheet).not.toMatch(/\.workspace-file-panel-title\s*\{/);
    expect(workspaceSource).not.toContain('className="workspace-browser-header"');
    expect(workspaceSource).not.toContain('className="workspace-file-panel-title"');
    expect(workspaceSource).toMatch(
      /className="workspace-editor-actions"[\s\S]*visibleSaveState !== 'idle'[\s\S]*workspace-save-status/
    );
    expect(chatSource).toContain('<SessionDeleteDialog');
    expect(chatSource).toContain('<ConfirmDialog');
    expect(confirmDialogSource).toContain('dialog.showModal()');
    expect(chatSource).not.toContain("window.confirm('このセッションを削除しますか？')");
    expect(sourceStylesheet).toMatch(
      /\.confirm-dialog-actions button,\s*\.session-project-dialog-actions button\s*\{[^}]*min-height:\s*44px/s
    );
  });

  it('GET /api/sessions returns at most the latest 100 sessions', async () => {
    for (let i = 0; i < 105; i++) {
      createSession(`web-chat:limit-${i}`, {
        platform: 'web',
        title: `limit session ${i}`,
      });
    }

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string }>;
      meta: { limit: number };
    };
    expect(list.sessions).toHaveLength(100);
    expect(list.meta.limit).toBe(100);
    expect(list.meta.total).toBe(105);
    expect(list.meta.hasMore).toBe(true);
    expect(list.meta.nextOffset).toBe(100);
  });

  it('GET /api/sessions pages and searches the complete session catalog', async () => {
    for (let i = 0; i < 7; i++) {
      createSession(`web-chat:page-${i}`, {
        platform: 'web',
        title: `pagination needle ${i}`,
      });
    }
    createSession('web-chat:other', {
      platform: 'web',
      title: 'unrelated session',
    });

    const first = (await (
      await fetch(`${baseUrl}/api/sessions?q=pagination%20needle&limit=3`)
    ).json()) as {
      sessions: Array<{ id: string }>;
      meta: { total: number; hasMore: boolean; nextOffset: number | null };
    };
    const second = (await (
      await fetch(`${baseUrl}/api/sessions?q=pagination%20needle&limit=3&offset=3`)
    ).json()) as {
      sessions: Array<{ id: string }>;
      meta: { total: number; hasMore: boolean; nextOffset: number | null };
    };
    const last = (await (
      await fetch(`${baseUrl}/api/sessions?q=pagination%20needle&limit=3&offset=6`)
    ).json()) as {
      sessions: Array<{ id: string }>;
      meta: { total: number; hasMore: boolean; nextOffset: number | null };
    };

    expect(first.sessions).toHaveLength(3);
    expect(first.meta).toMatchObject({ total: 7, hasMore: true, nextOffset: 3 });
    expect(second.sessions).toHaveLength(3);
    expect(second.meta).toMatchObject({ total: 7, hasMore: true, nextOffset: 6 });
    expect(last.sessions).toHaveLength(1);
    expect(last.meta).toMatchObject({ total: 7, hasMore: false, nextOffset: null });
    expect(
      new Set(
        [...first.sessions, ...second.sessions, ...last.sessions].map((session) => session.id)
      ).size
    ).toBe(7);
  });

  it('GET /api/sessions cursor stays stable when a newer session is added', async () => {
    for (let i = 0; i < 3; i++) {
      createSession(`web-chat:stable-${i}`, {
        platform: 'web',
        title: `stable cursor ${i}`,
      });
    }
    const first = (await (
      await fetch(`${baseUrl}/api/sessions?q=stable%20cursor&limit=2`)
    ).json()) as {
      sessions: Array<{ id: string }>;
      meta: { nextCursor: string };
    };

    await new Promise((resolve) => setTimeout(resolve, 5));
    createSession('web-chat:stable-new', {
      platform: 'web',
      title: 'stable cursor newly added',
    });
    const second = (await (
      await fetch(
        `${baseUrl}/api/sessions?q=stable%20cursor&limit=2&cursor=${encodeURIComponent(
          first.meta.nextCursor
        )}`
      )
    ).json()) as { sessions: Array<{ id: string; title: string }> };

    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]?.title).not.toBe('stable cursor newly added');
    expect(first.sessions.some((session) => session.id === second.sessions[0]?.id)).toBe(false);
  });

  it('GET /api/sessions keeps a running session visible outside the latest 100', async () => {
    const oldId = createSession('old-running-channel', {
      platform: 'discord',
      title: 'old but running',
    });
    for (let i = 0; i < 105; i++) {
      createSession(`newer-channel-${i}`, {
        platform: 'discord',
        title: `newer session ${i}`,
      });
    }
    startActivity({
      threadId: 'discord:old-running-channel',
      turnId: 'old-running-turn',
      platform: 'discord',
      userText: 'still running',
    });

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string; isActive: boolean }>;
    };
    expect(list.sessions).toHaveLength(100);
    expect(list.sessions.find((session) => session.id === oldId)?.isActive).toBe(true);
  });

  it('GET /api/sessions/:id returns only the latest 50 messages', async () => {
    const id = createSession('web-chat:message-limit', {
      platform: 'web',
      title: 'message limit',
    });
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, `${id}.jsonl`),
      Array.from({ length: 60 }, (_, index) =>
        JSON.stringify({
          id: `m${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `message ${index}`,
          createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
          platformMessageId: index === 10 ? 'platform-message-10' : undefined,
        })
      ).join('\n') + '\n'
    );

    const detail = (await (
      await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}`)
    ).json()) as {
      messages: Array<{ content: string; platformMessageId?: string }>;
      hasMore: boolean;
      nextBefore: number | null;
    };
    expect(detail.messages).toHaveLength(50);
    expect(detail.messages[0]?.content).toBe('message 10');
    expect(detail.messages[0]?.platformMessageId).toBe('platform-message-10');
    expect(detail.messages.at(-1)?.content).toBe('message 59');
    expect(detail.hasMore).toBe(true);
    expect(detail.nextBefore).toBe(50);

    const newest = (await (
      await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}?limit=20`)
    ).json()) as {
      messages: Array<{ content: string }>;
      hasMore: boolean;
      nextBefore: number | null;
    };
    const middle = (await (
      await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}?limit=20&before=20`)
    ).json()) as typeof newest;
    const oldest = (await (
      await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}?limit=20&before=40`)
    ).json()) as typeof newest;

    expect(newest.messages.map((message) => message.content)).toEqual(
      Array.from({ length: 20 }, (_, index) => `message ${index + 40}`)
    );
    expect(newest).toMatchObject({ hasMore: true, nextBefore: 20 });
    expect(middle.messages.map((message) => message.content)).toEqual(
      Array.from({ length: 20 }, (_, index) => `message ${index + 20}`)
    );
    expect(middle).toMatchObject({ hasMore: true, nextBefore: 40 });
    expect(oldest.messages.map((message) => message.content)).toEqual(
      Array.from({ length: 20 }, (_, index) => `message ${index}`)
    );
    expect(oldest).toMatchObject({ hasMore: false, nextBefore: null });
  });

  it('GET /api/sessions/:id exposes the active turn for stream recovery', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'keep running after disconnect' }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const detail = (await (
      await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}?cursor=tail`)
    ).json()) as {
      isActive: boolean;
      activity?: { active: boolean; threadId: string; turnId: string };
    };
    expect(detail.isActive).toBe(true);
    expect(detail.activity).toMatchObject({ active: true, threadId: `web:${id}` });
    expect(detail.activity?.turnId).toMatch(/^web-msg-/);

    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${id}`);
    await readSSEUntilDone((await send).body);
  });

  it('GET /api/sessions/:id cursor does not shift when a message is appended', async () => {
    const id = createSession('web-chat:stable-messages', {
      platform: 'web',
      title: 'stable messages',
    });
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, `${id}.jsonl`);
    const entry = (index: number) =>
      JSON.stringify({
        id: `stable-m${index}`,
        role: 'user',
        content: `stable message ${index}`,
        createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      });
    writeFileSync(logPath, Array.from({ length: 6 }, (_, index) => entry(index)).join('\n') + '\n');

    const first = (await (
      await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}?limit=2&cursor=tail`)
    ).json()) as {
      messages: Array<{ id: string }>;
      nextCursor: number;
    };
    appendFileSync(logPath, entry(6) + '\n');
    const second = (await (
      await fetch(
        `${baseUrl}/api/sessions/${encodeURIComponent(id)}?limit=2&cursor=${first.nextCursor}`
      )
    ).json()) as typeof first;

    expect(first.messages.map((message) => message.id)).toEqual(['stable-m4', 'stable-m5']);
    expect(second.messages.map((message) => message.id)).toEqual(['stable-m2', 'stable-m3']);
  });

  it('GET /api/sessions/stream sends an initial snapshot without polling', async () => {
    const id = createSession('web-chat:sse', { platform: 'web', title: 'SSE session' });
    const response = await fetch(`${baseUrl}/api/sessions/stream`);
    const reader = response.body?.getReader();
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const chunk = await reader?.read();
    const text = new TextDecoder().decode(chunk?.value);
    expect(text).toContain('event: sessions');
    expect(text).toContain('SSE session');

    await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
    const invalidationChunk = await reader?.read();
    const invalidationText = new TextDecoder().decode(invalidationChunk?.value);
    expect(invalidationText).toContain('event: sessions');

    events.turnStarted({
      threadId: `web:${id}`,
      turnId: 'web-sse-turn',
      platform: 'web',
      userText: 'SSE update',
    });
    const activityChunk = await reader?.read();
    const activityText = new TextDecoder().decode(activityChunk?.value);
    expect(activityText).toContain('event: activity');
    expect(activityText).toContain('SSE update');

    const activityContext = {
      threadId: `web:${id}`,
      turnId: 'web-sse-activity',
      platform: 'web' as const,
    };
    startActivity(activityContext);
    updateActivityTool(activityContext, 'test_tool', { q: 'live monitor' });
    const snapshotChunk = await reader?.read();
    const snapshotText = new TextDecoder().decode(snapshotChunk?.value);
    expect(snapshotText).toContain('event: activity_snapshot');
    expect(snapshotText).toContain('test_tool');
    await reader?.cancel();
  });

  it('GET /api/sessions/stream publishes title and message count after chat completion', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const stream = await fetch(`${baseUrl}/api/sessions/stream`);
    const reader = stream.body!.getReader();
    await reader.read();

    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'snapshot title' }),
    });
    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${id}`);
    await readSSEUntilDone((await send).body);

    const updates = await readStreamUntil(
      reader,
      (text) =>
        text.includes('event: sessions') &&
        text.includes('snapshot title') &&
        text.includes('"messageCount":1')
    );
    expect(updates).toContain(`"id":"${id}"`);
    await reader.cancel();
  });

  it('persists and streams an interrupted assistant response during shutdown', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const responsePromise = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'restart now' }),
    });

    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runner.emitText(`${WEB_CHAT_CONTEXT_PREFIX}${id}`, '途中までの回答')).toBe(true);
    logPrompt(testDir, id, 'restart now');

    await finalizeActiveStreams();

    const response = await responsePromise;
    const messages = readSessionMessages(testDir, id);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.content).toEqual({
      result: '途中までの回答\n\n⏸ プロセス再起動により中断されました',
    });
    expect(messages[1]?.platformMessageId).toBeUndefined();

    const reader = response.body!.getReader();
    const streamed = await readStreamUntil(
      reader,
      (text) => text.includes('event: done') && text.includes('プロセス再起動により中断されました')
    );
    expect(streamed).toContain('"replySuggestions":[]');
    expect(runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${id}`)).toBe(true);
    while (!(await reader.read()).done) {
      // Drain the normal completion emitted after the shutdown finalizer.
    }
  });

  it('GET /api/sessions/:id separates uploaded file paths from user display text', async () => {
    const id = createSession('web-chat:attachment-display', {
      platform: 'web',
      title: 'Attachment display',
    });
    const logsDir = join(testDir, 'logs', 'sessions');
    const uploadDir = join(testDir, 'tmp', 'web-uploads');
    const receivedAttachmentDir = join(testDir, '.xangi', 'media', 'attachments');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(uploadDir, { recursive: true });
    mkdirSync(receivedAttachmentDir, { recursive: true });
    const imagePath = join(uploadDir, 'image.png');
    const reportPath = join(uploadDir, 'report.pdf');
    const receivedImagePath = join(receivedAttachmentDir, 'discord-image.png');
    writeFileSync(imagePath, 'image');
    writeFileSync(reportPath, 'report');
    writeFileSync(receivedImagePath, 'discord image');
    appendFileSync(
      join(logsDir, `${id}.jsonl`),
      JSON.stringify({
        id: 'attachment-message',
        role: 'user',
        content: [
          '<prefetched-history platform="Web">',
          '[添付ファイル] /private/old-secret.png',
          '</prefetched-history>',
          '画像を見てください',
          `[添付ファイル] ${imagePath}`,
          `[添付ファイル] ${reportPath}`,
          '[添付ファイル] /private/outside.pdf',
          '[添付ファイル]',
          `  - ${receivedImagePath}`,
          '  - /private/outside-image.png',
        ].join('\n'),
        createdAt: new Date().toISOString(),
      }) + '\n'
    );

    const detail = (await (
      await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}`)
    ).json()) as {
      messages: Array<{ content: string; attachments: string[] }>;
    };
    expect(detail.messages[0]).toMatchObject({
      content: '画像を見てください',
      attachments: [imagePath, reportPath, receivedImagePath],
    });

    const receivedImage = await fetch(
      `${baseUrl}/api/workspace-file?path=${encodeURIComponent(receivedImagePath)}`
    );
    expect(receivedImage.status).toBe(200);
    expect(receivedImage.headers.get('content-type')).toBe('image/png');
    expect(receivedImage.headers.get('accept-ranges')).toBe('bytes');

    const ranged = await fetch(
      `${baseUrl}/api/workspace-file?path=${encodeURIComponent(receivedImagePath)}`,
      { headers: { Range: 'bytes=2-5' } }
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/13');
    expect(ranged.headers.get('content-length')).toBe('4');
    expect(await ranged.text()).toBe('scor');

    const unsatisfiable = await fetch(
      `${baseUrl}/api/workspace-file?path=${encodeURIComponent(receivedImagePath)}`,
      { headers: { Range: 'bytes=99-100' } }
    );
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */13');
  });

  it('POST /api/upload interprets the configured limit as MiB', async () => {
    const previous = process.env.WEB_CHAT_UPLOAD_MAX_MB;
    process.env.WEB_CHAT_UPLOAD_MAX_MB = '1';
    try {
      const form = new FormData();
      form.append('file', new Blob(['x'.repeat(1024 * 1024)]), 'large.txt');
      const response = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        error: 'Upload too large',
        maxBytes: 1024 * 1024,
      });
    } finally {
      if (previous === undefined) delete process.env.WEB_CHAT_UPLOAD_MAX_MB;
      else process.env.WEB_CHAT_UPLOAD_MAX_MB = previous;
    }
  });

  it('GET /api/workspace-file rejects sibling paths and downloads active content', async () => {
    const inside = join(testDir, 'report.html');
    const siblingDir = `${testDir}-sibling`;
    const sibling = join(siblingDir, 'secret.txt');
    writeFileSync(inside, '<script>fetch("/api/sessions",{method:"DELETE"})</script>');
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(sibling, 'secret');
    try {
      const allowed = await fetch(
        `${baseUrl}/api/workspace-file?path=${encodeURIComponent(inside)}`
      );
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('content-disposition')).toContain('attachment');
      expect(allowed.headers.get('x-content-type-options')).toBe('nosniff');

      const denied = await fetch(
        `${baseUrl}/api/workspace-file?path=${encodeURIComponent(sibling)}`
      );
      expect(denied.status).toBe(403);
    } finally {
      rmSync(siblingDir, { recursive: true });
    }
  });

  it('GET /api/artifact-preview serves only workspace HTML with a restrictive sandbox', async () => {
    const inside = join(testDir, 'artifact.html');
    const textFile = join(testDir, 'artifact.txt');
    const siblingDir = `${testDir}-artifact-sibling`;
    const sibling = join(siblingDir, 'outside.html');
    writeFileSync(inside, '<!doctype html><button>safe preview</button>');
    writeFileSync(textFile, 'not html');
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(sibling, '<!doctype html><p>outside</p>');
    try {
      const allowed = await fetch(
        `${baseUrl}/api/artifact-preview?path=${encodeURIComponent(inside)}`
      );
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(allowed.headers.get('content-disposition')).toBeNull();
      expect(allowed.headers.get('cache-control')).toBe('no-store');
      expect(allowed.headers.get('referrer-policy')).toBe('no-referrer');
      expect(allowed.headers.get('content-security-policy')).toContain(
        'sandbox allow-scripts allow-forms'
      );
      expect(allowed.headers.get('content-security-policy')).toContain("connect-src 'none'");
      expect(allowed.headers.get('content-security-policy')).toContain("form-action 'none'");
      expect(await allowed.text()).toContain('safe preview');

      const wrongType = await fetch(
        `${baseUrl}/api/artifact-preview?path=${encodeURIComponent(textFile)}`
      );
      expect(wrongType.status).toBe(404);

      const outside = await fetch(
        `${baseUrl}/api/artifact-preview?path=${encodeURIComponent(sibling)}`
      );
      expect(outside.status).toBe(404);
    } finally {
      rmSync(siblingDir, { recursive: true });
    }
  });

  it('GET /api/workspace-file resolves relative source paths inside the workspace', async () => {
    const source = join(testDir, 'scheduler.ts');
    writeFileSync(source, 'export const scheduled = true;\n');

    const response = await fetch(
      `${baseUrl}/api/workspace-file?path=${encodeURIComponent('scheduler.ts')}`
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(await response.text()).toBe('export const scheduled = true;\n');
  });

  it('GET /api/sessions includes current activity for running web sessions', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;

    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'monitor me' }),
    });

    for (let i = 0; i < 50 && runner.pending.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{
        id: string;
        isCurrent: boolean;
        activity?: { state: string; summary: string; active: boolean; userTextPreview?: string };
      }>;
    };
    const found = list.sessions.find((s) => s.id === id);
    expect(found?.isCurrent).toBe(true);
    expect(found?.activity?.state).toBe('thinking');
    expect(found?.activity?.active).toBe(true);
    expect(found?.activity?.userTextPreview).toBe('monitor me');

    runner.release(`${WEB_CHAT_CONTEXT_PREFIX}${id}`);
    await readSSEUntilDone((await send).body);
  });

  it('GET /api/sessions/:id/tool-history returns persisted tools for that session', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const activity = {
      threadId: `web:${id}`,
      turnId: 'web-turn-history',
      platform: 'web' as const,
      userText: 'ツール履歴を確認',
    };
    startActivity(activity);
    updateActivityTool(activity, 'Bash', { command: 'pwd' });
    updateActivityTool(activity, 'Read', { file_path: '/tmp/example.txt' });

    const response = await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(id)}/tool-history?limit=10`
    );
    const data = (await response.json()) as {
      tools: Array<{
        turnId: string;
        toolName: string;
        summary: string;
        inputPreview?: string;
      }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(data.tools).toHaveLength(2);
    expect(data.tools.map((tool) => tool.toolName)).toEqual(['Bash', 'Read']);
    expect(data.tools[0]).toMatchObject({
      turnId: 'web-turn-history',
      summary: '実行中: Bash: pwd',
      inputPreview: '{"command":"pwd"}',
    });
  });

  it('GET /api/sessions/:id/turn-history returns commentary and tools in turn order', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const activity = {
      threadId: `web:${id}`,
      turnId: 'web-turn-commentary',
      platform: 'web' as const,
      userText: '履歴を確認',
    };
    startActivity(activity);
    updateActivityText(activity, '調べます。', '調べます。');
    updateActivityTool(activity, 'Read', { file_path: '/tmp/example.txt' });
    updateActivityText(activity, '最終回答です。', '最終回答です。');
    completeActivity(activity, '最終回答です。');

    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/turn-history`);
    const data = (await response.json()) as {
      history: Array<{ kind: string; text?: string; toolName?: string }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(data.history).toEqual([
      expect.objectContaining({ kind: 'text', text: '調べます。' }),
      expect.objectContaining({ kind: 'tool', toolName: 'Read' }),
    ]);
  });

  it('GET /api/sessions/:id/tool-history resolves an unmanaged Discord thread transcript', async () => {
    const id = 'unmanaged-tool-history';
    const threadId = '1531821464939004026';
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, `${id}.jsonl`),
      JSON.stringify({
        id: 'u1',
        role: 'user',
        content:
          '[プラットフォーム: Discord]\n' +
          '[チャンネル: #dev (ID: 1512834653877440683) / thread: 履歴テスト (ID: ' +
          `${threadId})]\n履歴を見せて`,
        createdAt: '2026-07-29T00:00:00Z',
      }) + '\n'
    );
    const activity = {
      threadId: `discord:${threadId}`,
      turnId: 'discord-turn-history',
      platform: 'discord' as const,
      userText: '履歴を見せて',
    };
    startActivity(activity);
    updateActivityTool(activity, 'Read', { file_path: '/tmp/history.txt' });

    const response = await fetch(`${baseUrl}/api/sessions/${id}/tool-history`);
    const data = (await response.json()) as { tools: Array<{ toolName: string }> };

    expect(response.status).toBe(200);
    expect(data.tools.map((tool) => tool.toolName)).toEqual(['Read']);
  });

  it('GET /api/sessions includes Discord sessions (channelId-based contextKey) as managed', async () => {
    // Discord セッション: title 空 + contextKey が 10桁以上の数字 channel ID。
    // 旧フィルターはこれを除外していたが、修正後は managed として出るべき。
    const channelId = '1469726038291386523';
    const discordAppId = createSession(channelId, { platform: 'discord' });

    // ログファイルから title が導出されるパスを検証するためログを書き込む
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, `${discordAppId}.jsonl`);
    const userMessage =
      '[プラットフォーム: Discord]\n' +
      `[チャンネル: #dev_xangi (ID: ${channelId})]\n` +
      '[発言者: からあげ (ID: 1)]\n' +
      '[現在時刻: 2026/5/5 10:00:00(火)]\n' +
      '最初のメッセージです';
    writeFileSync(
      logPath,
      JSON.stringify({
        id: 'm1',
        role: 'user',
        content: userMessage,
        createdAt: '2026-05-05T01:00:00Z',
      }) + '\n'
    );

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{
        id: string;
        title: string;
        platform: string;
        contextKey: string;
      }>;
    };
    const found = list.sessions.find((s) => s.id === discordAppId);
    expect(found).toBeDefined();
    expect(found?.platform).toBe('discord');
    // managed なので contextKey はチャンネル ID（unmanaged だと '' になっていた）
    expect(found?.contextKey).toBe(channelId);
    // タイトルは最初の user メッセージから導出されるので「最初のメッセージです」
    expect(found?.title).toBe('最初のメッセージです');
  });

  it('GET /api/sessions/:id hides internal prompt metadata and reply suggestion markup', async () => {
    const id = createSession('web-chat:test-sanitize', {
      platform: 'discord',
      title: '[システム注記: internal]',
    });
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, `${id}.jsonl`),
      [
        {
          id: 'u1',
          role: 'user',
          content: `[システム注記: xangi プロセスを再起動した。]
[プラットフォーム: Discord]
[チャンネル: #dev_xangi / thread: 表示確認 (ID: 123)]
[発言者: からあげ (ID: 456)]
[現在時刻: 2026/7/30 12:27:45(木)]
---
🧵 スレッド元 (karaage0703):
最初の話題
---
本当の質問

[チャンネルルール（必ず従うこと）]
内部ルール`,
          createdAt: '2026-07-13T00:00:00Z',
        },
        {
          id: 'a1',
          role: 'assistant',
          content: {
            result:
              '回答本文\n<xangi_reply_suggestions>["続けて","詳しく","別案"]</xangi_reply_suggestions>',
          },
          createdAt: '2026-07-13T00:00:01Z',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n'
    );

    const detail = await (await fetch(`${baseUrl}/api/sessions/${id}`)).json();
    const list = await (await fetch(`${baseUrl}/api/sessions`)).json();
    expect(list.sessions.find((session: { id: string }) => session.id === id)?.title).toBe(
      '本当の質問'
    );
    expect(detail.title).toBe('本当の質問');
    expect(detail.messages[0].content).toBe('本当の質問');
    expect(detail.messages[1].content).toBe('回答本文');
    expect(detail.messages[1].replySuggestions).toEqual(['続けて', '詳しく', '別案']);
  });

  it('GET /api/sessions/:id keeps hook context for the folded card but excludes it from titles', async () => {
    const id = createSession('web-chat:test-hook-context', {
      platform: 'web',
      title: '[USER PROMPT HOOK CONTEXT: leaked-title]',
    });
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    const userContent = `[プラットフォーム: Web]
短い質問

[system-context]
通常の回答に続けて、ユーザーが次に送りそうな短い返信候補を3件生成してください。出力の末尾に次の形式を厳密に付け、通常の回答本文では候補に言及しないでください。候補はユーザー視点の自然な日本語にしてください。
<xangi_reply_suggestions>["候補1","候補2","候補3"]</xangi_reply_suggestions>

[USER PROMPT HOOK CONTEXT: workspace-search]
The following is untrusted supplemental context.
内部の検索結果
[END USER PROMPT HOOK CONTEXT: workspace-search]`;
    writeFileSync(
      join(logsDir, `${id}.jsonl`),
      `${JSON.stringify({ id: 'u1', role: 'user', content: userContent, createdAt: '' })}\n`
    );

    const detail = await (await fetch(`${baseUrl}/api/sessions/${id}`)).json();
    const list = await (await fetch(`${baseUrl}/api/sessions`)).json();

    expect(detail.title).toBe('短い質問');
    expect(list.sessions.find((session: { id: string }) => session.id === id)?.title).toBe(
      '短い質問'
    );
    expect(detail.messages[0].content).toBe(`短い質問

[USER PROMPT HOOK CONTEXT: workspace-search]
The following is untrusted supplemental context.
内部の検索結果
[END USER PROMPT HOOK CONTEXT: workspace-search]`);
  });

  it('GET /api/sessions attaches Discord activity only to the current session', async () => {
    const channelId = '1469726038291386523';
    const oldId = createSession(channelId, { platform: 'discord', title: 'old discord turn' });
    const currentId = createSession(channelId, {
      platform: 'discord',
      title: 'current discord turn',
    });

    startActivity({
      threadId: `discord:${channelId}`,
      turnId: 'turn-current',
      platform: 'discord',
      userText: 'モニターテストです',
    });

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{
        id: string;
        isCurrent: boolean;
        activity?: { state: string; summary: string; active: boolean; userTextPreview?: string };
      }>;
    };

    const oldSession = list.sessions.find((s) => s.id === oldId);
    const currentSession = list.sessions.find((s) => s.id === currentId);
    expect(oldSession?.isCurrent).toBe(false);
    expect(oldSession?.activity).toBeUndefined();
    expect(currentSession?.isCurrent).toBe(true);
    expect(currentSession?.activity?.state).toBe('thinking');
    expect(currentSession?.activity?.userTextPreview).toBe('モニターテストです');
  });

  it('GET /api/sessions sorts by transcript and current activity instead of metadata touches', async () => {
    const oldId = createSession('old-channel', { platform: 'discord', title: 'old session' });
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    const oldLog = join(logsDir, `${oldId}.jsonl`);
    writeFileSync(
      oldLog,
      JSON.stringify({
        id: 'old-message',
        role: 'user',
        content: 'old session',
        createdAt: '2026-05-17T00:00:00.000Z',
      }) + '\n'
    );
    const oldTime = new Date('2026-05-17T00:00:00.000Z');
    utimesSync(oldLog, oldTime, oldTime);

    // Provider metadata updates must not make old content look recent in the sidebar.
    setProviderSessionId(oldId, 'provider-touched-today');

    const currentId = createSession('current-channel', {
      platform: 'discord',
      title: 'current session',
    });
    startActivity({
      threadId: 'discord:current-channel',
      turnId: 'current-turn',
      platform: 'discord',
      userText: 'running now',
    });

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string; updatedAt: string }>;
    };
    expect(list.sessions[0]?.id).toBe(currentId);
    expect(list.sessions.find((s) => s.id === oldId)?.updatedAt).toBe(oldTime.toISOString());
  });

  it('GET /api/sessions hides scheduler audit transcripts', async () => {
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    const schedulerId = 'scheduler-run-discord-1783929000000-12345678';
    writeFileSync(
      join(logsDir, `${schedulerId}.jsonl`),
      JSON.stringify({
        id: 'scheduled-message',
        role: 'user',
        content: 'scheduled task',
        createdAt: '2026-07-13T00:00:00.000Z',
      }) + '\n'
    );

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(list.sessions.some((s) => s.id === schedulerId)).toBe(false);
  });

  it('GET /api/sessions hides unmanaged transcripts without a user-derived title', async () => {
    const logsDir = join(testDir, 'logs', 'sessions');
    mkdirSync(logsDir, { recursive: true });
    const internalId = 'unmanaged-without-user-title';
    writeFileSync(
      join(logsDir, `${internalId}.jsonl`),
      JSON.stringify({
        id: 'assistant-only',
        role: 'assistant',
        content: 'internal result',
        createdAt: '2026-07-13T00:00:00.000Z',
      }) + '\n'
    );

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(list.sessions.some((session) => session.id === internalId)).toBe(false);
  });

  it('GET /api/sessions falls back to contextKey when no title and no log can be derived', async () => {
    const channelId = '1500000000000000001';
    const id = createSession(channelId, { platform: 'discord' });
    // ログ無し → タイトル導出不可。フォールバックで contextKey が返る
    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string; title: string; contextKey: string }>;
    };
    const found = list.sessions.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.title).toBe(channelId);
    expect(found?.contextKey).toBe(channelId);
  });

  it('GET /api/sessions/:id/timeout is routed to timeout handler, not to session detail', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/no-such-session/timeout`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toEqual({ active: false });
    expect(body).not.toHaveProperty('messages');
  });

  it('POST /api/sessions/:id/timeout/extend returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/no-such-session/timeout/extend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('session not found');
  });

  it('DELETE /api/sessions/:id destroys the corresponding runner', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const ctx = `${WEB_CHAT_CONTEXT_PREFIX}${id}`;

    const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    expect(res.ok).toBe(true);
    expect(runner.destroyed.has(ctx)).toBe(true);
    expect(getSessionEntry(id)).toBeUndefined();
  });

  it('POST /api/sessions/:id/close keeps history and detaches the session', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const entry = getSessionEntry(id)!;

    const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/close`, {
      method: 'POST',
    });

    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ ok: true, lifecycle: 'closed' });
    expect(getSessionEntry(id)).toMatchObject({ lifecycle: 'closed', closeReason: 'web' });
    expect(getActiveSessionId(entry.contextKey)).toBeUndefined();
    expect(runner.destroyed.has(entry.contextKey)).toBe(true);

    const detail = await (await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}`)).json();
    expect(detail.lifecycle).toBe('closed');

    const send = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'should not continue' }),
    });
    expect(send.status).toBe(409);
    expect(await send.json()).toEqual({ error: 'Session is closed' });

    const closed = (await (
      await fetch(`${baseUrl}/api/sessions?lifecycle=closed&limit=200`)
    ).json()) as { sessions: Array<{ id: string; lifecycle: string }> };
    expect(closed.sessions).toContainEqual(expect.objectContaining({ id, lifecycle: 'closed' }));
  });

  it('requires explicit force before closing a session that started running', async () => {
    const id = (await (await fetch(`${baseUrl}/api/sessions`, { method: 'POST' })).json())
      .sessionId as string;
    const contextKey = `${WEB_CHAT_CONTEXT_PREFIX}${id}`;
    const send = fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId: id, message: 'running turn' }),
    });
    for (let i = 0; i < 50 && !runner.pending.has(contextKey); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runner.pending.has(contextKey)).toBe(true);

    const rejected = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false }),
    });
    expect(rejected.status).toBe(409);
    expect(getSessionEntry(id)?.lifecycle).toBe('open');
    expect(runner.destroyed.has(contextKey)).toBe(false);

    const forced = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(forced.status).toBe(200);
    expect(getSessionEntry(id)?.lifecycle).toBe('closed');
    expect(runner.destroyed.has(contextKey)).toBe(true);

    runner.release(contextKey);
    await readSSEUntilDone((await send).body);
    expect(getSessionEntry(id)?.lifecycle).toBe('closed');
  });
});
