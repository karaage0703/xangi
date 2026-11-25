import { clearActivities, readTurnHistory } from '../src/activity-store.js';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AgentConnectionRuntimes } from '../src/agent-connection-runtime.js';
import { AgentConnectionStore } from '../src/agent-connections.js';
import { handleDedicatedWorkInput, relayDedicatedWorkInput } from '../src/agent-connection-work.js';
import { AgentRunStore } from '../src/agent-runs.js';
import { isWorkRequestPost } from '../src/agent-work-presentation.js';
import { registerDiscordAgentWork } from '../src/discord/agent-work.js';
import { PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import {
  closeAgentWork,
  executeAgentWork,
  prepareAgentWork,
  registerAgentWork,
  registerWorkTransport,
  submitAgentWork,
} from '../src/agent-work.js';
import { registerAgentSelection, changeChannelAgent } from '../src/agent-selection.js';
import { ProjectCatalog } from '../src/project-catalog.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { initSessions, clearSessions, createWebSession, getSessionEntry, getActiveSessionId } from '../src/sessions.js';
import type { AgentRunner, RunResult, StreamCallbacks, RunOptions } from '../src/agent-runner.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-work-'));
  initSessions(root);
});
afterEach(() => {
  clearSessions();
  rmSync(root, { recursive: true, force: true });
});
async function setup(bound = true) {
  const store = AgentRunStore.fromDataDir(root);
  const catalog = new ProjectCatalog(root);
  const registry = await WorkspaceRegistry.open({
    dataDir: join(root, 'state'),
    defaultWorkspacePath: root,
  });
  const agent = catalog.saveAgent({
    name: '調査担当',
    prompt: '出典を確認',
    workspaceId: 'default',
    backend: 'codex',
  });
  const runner = {
    runStream: vi.fn(async () => ({ result: '完了', sessionId: 'provider-1' })),
  } as unknown as AgentRunner;
  registerAgentSelection(root, { catalog, registry, runner });
  if (bound) await changeChannelAgent('discord', 'work-channel', agent.id);
  const appSessionId = createWebSession({
    selectedAgentId: agent.id,
    selectedAgentConfig: agent,
    workspacePath: root,
    workspaceId: 'default',
  });
  const run = store.create({
    task: '調査して',
    agentId: agent.id,
    backend: 'codex',
    workspaceId: 'default',
    workspacePath: root,
    appSessionId,
    parentContextKey: 'parent',
    parentPlatform: 'discord',
  });
  const transport = {
    create: vi.fn(async () => ({
      platform: 'discord',
      channelId: 'work-channel',
      threadId: run.id,
      url: `https://discord.com/channels/g/${run.id}`,
    })),
    send: vi.fn(async (_thread: unknown, _text: string) => {}),
    progress: vi.fn(async () => {}),
  };
  registerWorkTransport('discord', transport);
  const notify = vi.fn();
  registerAgentWork({ store, runner, notify });
  const options: RunOptions = {
    channelId: `web-chat:${appSessionId}`,
    appSessionId,
    platform: 'web',
    workdir: root,
  };
  return { store, run, runner, transport, notify, options, registry };
}
it('shows the persisted assignment without exposing the Team execution prompt or run ID', async () => {
  const f = await setup();
  const task = 'Team: リサーチ\n会話の参考情報: user: 内部履歴\nメンバー: [{agentId:secret}]';
  const run = f.store.create({
    ...f.run,
    task,
    workPresentation: {
      assignment: '館内の飲食施設を調査。日曜営業と価格を確認。候補は2件まで。',
      teamName: 'リサーチ',
    },
  });
  const reloaded = AgentRunStore.fromDataDir(root);
  const saved = reloaded.get(run.id)!;
  await prepareAgentWork(saved, reloaded);
  const [, title, text] = f.transport.create.mock.calls[0] as unknown as string[];
  expect(title).toBe('館内の飲食施設を調査');
  expect(text).toContain('- 日曜営業と価格を確認。');
  expect(text).toContain('- 候補は2件まで。');
  expect(text).not.toContain('内部履歴');
  expect(text).not.toContain('agentId');
  expect(text).not.toContain(run.id);
  expect(saved.task).toBe(task);
});
it('streams progress and consumes durable follow-ups on the same provider session before completion', async () => {
  const f = await setup();
  let release!: (result: RunResult) => void;
  const execute = vi.fn(async (_prompt: string, callbacks: StreamCallbacks) => {
    callbacks.onText?.('調査中', '調査中');
    if (execute.mock.calls.length === 1)
      return await new Promise<RunResult>((r) => {
        release = r;
      });
    return { result: '追加指示込み', sessionId: 'provider-1' };
  });
  const pending = executeAgentWork(f.run, f.store, f.options, execute);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(submitAgentWork('discord', f.run.id, 'msg1', '日本語で')).toContain('受け付け');
  submitAgentWork('discord', f.run.id, 'msg1', '日本語で');
  expect(f.store.get(f.run.id)?.pendingWorkInputs).toHaveLength(1);
  release({ result: '初回', sessionId: 'provider-1' });
  await pending;
  await vi.waitFor(() => expect(f.store.get(f.run.id)?.status).toBe('succeeded'));
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1][0]).toContain('日本語で');
  expect((execute.mock.calls[1] as unknown as [string, unknown, RunOptions])[2].sessionId).toBe(
    'provider-1'
  );
  expect(f.transport.progress).toHaveBeenCalled();
  expect(f.transport.create).toHaveBeenCalledTimes(1);
  expect(f.runner.runStream).not.toHaveBeenCalled();
  await new Promise((r) => setTimeout(r, 0));
});
it('continues a completed thread after reloading persisted runs, with parent notification', async () => {
  const f = await setup();
  await executeAgentWork(f.run, f.store, f.options, async () => ({
    result: '初回',
    sessionId: 'provider-1',
  }));
  f.store.markParentNotified(f.run.id);
  const reloaded = AgentRunStore.fromDataDir(root);
  registerAgentWork({ store: reloaded, runner: f.runner, notify: f.notify });
  submitAgentWork('discord', f.run.id, 'msg2', 'もう少し詳しく');
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledTimes(1));
  expect(f.runner.runStream).toHaveBeenCalledWith(
    expect.stringContaining('もう少し詳しく'),
    expect.anything(),
    expect.objectContaining({ sessionId: 'provider-1', appSessionId: f.run.appSessionId })
  );
  expect(reloaded.get(f.run.id)?.parentNotifiedAt).toBeUndefined();
  expect(f.transport.create).toHaveBeenCalledTimes(1);
});
it('runs without a thread when unassigned', async () => {
  const f = await setup(false);
  await executeAgentWork(f.run, f.store, f.options, async () => ({ result: 'ok', sessionId: 'p' }));
  expect(f.transport.create).not.toHaveBeenCalled();
  expect(f.store.get(f.run.id)?.status).toBe('succeeded');
});
it('keeps delegated work from a secret conversation out of Discord', async () => {
  const f = await setup();
  const parentAppSessionId = createWebSession({ secret: true, workspacePath: root });
  await expect(prepareAgentWork({ ...f.run, parentAppSessionId }, f.store)).resolves.toBeUndefined();
  expect(f.transport.create).not.toHaveBeenCalled();
});

it('fails visibly before execution if the configured channel is inaccessible', async () => {
  const f = await setup();
  f.transport.create.mockRejectedValue(new Error('Missing permissions'));
  const execute = vi.fn();
  await expect(executeAgentWork(f.run, f.store, f.options, execute)).rejects.toThrow(
    'Missing permissions'
  );
  expect(execute).not.toHaveBeenCalled();
  expect(f.store.get(f.run.id)).toMatchObject({ status: 'failed', error: 'Missing permissions' });
});
it('preserves the result and records delivery errors', async () => {
  const f = await setup();
  f.transport.send.mockRejectedValue(new Error('thread deleted'));
  await executeAgentWork(f.run, f.store, f.options, async () => ({
    result: 'evidence',
    sessionId: 'p',
  }));
  expect(f.store.get(f.run.id)).toMatchObject({
    status: 'succeeded',
    result: 'evidence',
    workDeliveryError: expect.stringContaining('thread deleted'),
  });
});
it('drains an instruction arriving during the final display without creating a second session', async () => {
  const f = await setup();
  let added = false;
  f.transport.send.mockImplementation(async (_thread, text) => {
    if (text.startsWith('応答完了') && !added) {
      added = true;
      submitAgentWork('discord', f.run.id, 'race', '追加');
    }
  });
  const execute = vi.fn(async () => ({ result: 'ok', sessionId: 'p' }));
  await executeAgentWork(f.run, f.store, f.options, execute);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(f.transport.create).toHaveBeenCalledTimes(1);
  await new Promise((r) => setTimeout(r, 0));
});

it('routes only authorized human thread input to the existing work without a normal Discord turn', async () => {
  const { registerDiscordMessageHandlers } = await import('../src/discord/message-handler.js');
  const { initSettings } = await import('../src/settings.js');
  initSettings(root);
  const f = await setup();
  await executeAgentWork(f.run, f.store, f.options, async () => ({ result: 'ok', sessionId: 'p' }));
  const handlers = new Map<string, (message: any) => Promise<void>>();
  const client = {
    user: { id: 'bot' },
    on: (name: string, handler: any) => handlers.set(name, handler),
    channels: { fetch: vi.fn() },
  };
  registerDiscordMessageHandlers({
    client,
    config: { agent: { config: {} }, discord: { allowedUsers: ['user'] } },
    agentRunner: f.runner,
    workdir: root,
  } as any);
  registerWorkTransport('discord', f.transport);
  const message = (id: string, user: string, bot = false) => ({
    id,
    system: false,
    author: { id: user, bot },
    mentions: { has: () => false },
    guild: { id: 'guild' },
    channel: { id: f.run.id, isThread: () => true, parentId: 'work-channel' },
    content: 'この条件も確認して',
    attachments: new Map(),
    reply: vi.fn(async () => {}),
  });
  await handlers.get('messageCreate')!(message('x', 'stranger'));
  await handlers.get('messageCreate')!(message('y', 'bot', true));
  expect(f.runner.runStream).not.toHaveBeenCalled();
  const allowed = message('z', 'user');
  await handlers.get('messageCreate')!(allowed);
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledTimes(1));
  expect(allowed.reply).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringContaining('受け付け') })
  );
  expect(f.runner.runStream).toHaveBeenCalledTimes(1);
  expect(f.runner.runStream).toHaveBeenCalledWith(
    expect.stringContaining('この条件も確認して'),
    expect.anything(),
    expect.objectContaining({ appSessionId: f.run.appSessionId, sessionId: 'p' })
  );
});

it('does not automatically restart failed work to drain pending instructions', async () => {
  const f = await setup();
  let release!: (result: RunResult) => void;
  const execute = vi.fn(
    () =>
      new Promise<RunResult>((resolve) => {
        release = resolve;
      })
  );
  const pending = executeAgentWork(f.run, f.store, f.options, execute);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  submitAgentWork('discord', f.run.id, 'queued-before-failure', '追加');
  release({ result: '中止', sessionId: 'p', failed: true });
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.store.get(f.run.id)?.status).toBe('failed');
  expect(f.store.get(f.run.id)?.pendingWorkInputs).toHaveLength(1);
  expect(f.runner.runStream).not.toHaveBeenCalled();
});

it('shows complete starter text and attaches running/final controls to the delegated execution', async () => {
  const { registerDiscordAgentWork } = await import('../src/discord/agent-work.js');
  const { discordProcessingMessages, discordToolHistoryByMessageId, parseDiscordHistoryCustomId } = await import('../src/discord/ui.js');
  const f = await setup();
  const edits: any[] = [];
  const messages: any[] = [];
  const thread = {
    id: 'work-thread',
    url: 'https://discord.com/channels/g/work-thread',
    isTextBased: () => true,
    send: vi.fn(async (options: any) => {
      messages.push(options);
      return {
        id: `work-message-${messages.length}`,
        edit: vi.fn(async (o: any) => {
          edits.push(o);
        }),
      };
    }),
  };
  const parent = {
    isTextBased: () => true,
    isThread: () => false,
    isDMBased: () => false,
    send: vi.fn(async () => ({ startThread: vi.fn(async () => thread) })),
  };
  const client = {
    channels: { fetch: vi.fn(async (id: string) => (id === 'work-channel' ? parent : thread)) },
  };
  const now = Date.now();
  f.runner.getTimeoutState = () => ({
    active: true,
    timeoutAt: now + 60000,
    maxTimeoutAt: now + 600000,
  });
  registerDiscordAgentWork(client as any, f.runner);
  f.run.task = '先頭'.repeat(60) + '依頼の最後まで表示';
  let release!: () => void;
  const execution = executeAgentWork(f.run, f.store, f.options, async (_prompt, callbacks) => {
    callbacks.onText?.('調査しています', '調査しています');
    callbacks.onToolUse?.('web_fetch', { url: 'https://example.com/first' });
    await new Promise<void>((r) => {
      release = r;
    });
    return { result: '完了本文', sessionId: 'p' };
  });
  await vi.waitFor(() => expect(discordProcessingMessages.has(f.options.channelId!)).toBe(true));
  expect(parent.send.mock.calls[0][0].content).toContain('依頼の最後まで表示');
  expect(parent.send).toHaveBeenCalledTimes(1);
  expect(messages.some(({ content }) => isWorkRequestPost(content))).toBe(false);
  const running = messages.find((m) => m.content === '作業中');
  expect(running.components[0].toJSON().components.map((b: any) => b.custom_id)).toEqual([
    'xangi_stop',
    'xangi_extend',
    'xangi_timeout_display',
  ]);
  release();
  await execution;
  expect(discordProcessingMessages.has(f.options.channelId!)).toBe(false);
  const last = messages.at(-1);
  expect(last.components[0].toJSON().components[0].custom_id).toBe('xangi_thread_leave');
  expect(edits).toContainEqual({ components: [] });
  const historyButton = last.components[0].toJSON().components[1];
  expect(historyButton.label).toBe('History');
  const firstContext = parseDiscordHistoryCustomId(historyButton.custom_id)!;
  expect(firstContext.threadId).toBe(`web:${f.run.appSessionId}`);
  const firstHistory = discordToolHistoryByMessageId.get(`work-message-${messages.length}`)!;
  expect(firstHistory.some((entry) => entry.kind === 'tool' && entry.summary.includes('/first'))).toBe(true);
  expect(firstHistory.some((entry) => entry.kind === 'text' && entry.text === '完了本文')).toBe(false);
  await executeAgentWork(f.store.get(f.run.id)!, f.store, f.options, async (_prompt, callbacks) => {
    callbacks.onToolUse?.('web_fetch', { url: 'https://example.com/second' });
    return { result: '次の本文', sessionId: 'p' };
  });
  const nextContext = parseDiscordHistoryCustomId(messages.at(-1).components[0].toJSON().components[1].custom_id)!;
  expect(nextContext.turnId).not.toBe(firstContext.turnId);
  clearActivities();
  const persisted = readTurnHistory(firstContext.threadId, 200).filter((entry) => entry.turnId === firstContext.turnId);
  expect(persisted.some((entry) => entry.kind === 'tool' && entry.summary.includes('/first'))).toBe(true);
  expect(persisted.some((entry) => entry.kind === 'tool' && entry.summary.includes('/second'))).toBe(false);
  discordToolHistoryByMessageId.clear();
  const { createInteractionHandler } = await import('../src/discord/slash-commands.js');
  const handler = createInteractionHandler({
    config: { discord: { allowedUsers: ['user'] } }, resolver: { getSelectableBackends: () => [] },
    agentRunner: f.runner, scheduler: {}, workdir: root, skillsRef: { current: [] },
  } as any);
  const editReply = vi.fn(async () => {});
  await handler({
    isAutocomplete: () => false, isButton: () => true,
    customId: historyButton.custom_id, channelId: thread.id, user: { id: 'user' },
    message: { id: 'uncached-message' }, deferReply: vi.fn(async () => {}), editReply,
    followUp: vi.fn(async () => {}),
  } as any);
  expect(JSON.stringify(editReply.mock.calls)).toContain('/first');
  expect(JSON.stringify(editReply.mock.calls)).not.toContain('/second');
  await expect(executeAgentWork(f.store.get(f.run.id)!, f.store, f.options, async (_prompt, callbacks) => {
    callbacks.onToolUse?.('exec', { cmd: 'failing-tool' });
    throw new Error('test failure');
  })).rejects.toThrow('test failure');
  expect(messages.at(-1).components[0].toJSON().components.map((button: any) => button.label)).toEqual(['Close', 'History']);

});

it('routes controls to the child and completes idle work only after successful thread leave', async () => {
  const { createInteractionHandler } = await import('../src/discord/slash-commands.js');
  const f = await setup();
  f.store.setWorkThread(f.run.id, {
    platform: 'discord',
    channelId: 'work-channel',
    threadId: 'thread-controls',
    url: '',
  });
  const cancel = vi.fn(() => true),
    extendTimeout = vi.fn(() => ({ ok: true })),
    destroy = vi.fn(),
    remove = vi.fn(async () => true);
  const handler = createInteractionHandler({
    config: { discord: { allowedUsers: ['user'] } },
    resolver: { getSelectableBackends: () => [] },
    agentRunner: { cancel, extendTimeout, destroy },
    scheduler: {},
    workdir: root,
    skillsRef: { current: [] },
  } as any);
  const event = (customId: string) => ({
    isAutocomplete: () => false,
    isButton: () => true,
    customId,
    channelId: 'thread-controls',
    user: { id: 'user' },
    channel: { isThread: () => true, members: { remove } },
    message: { id: 'control-message' },
    deferUpdate: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
  });
  await handler(event('xangi_stop') as any);
  await handler(event('xangi_extend') as any);
  expect(cancel).toHaveBeenCalledWith(f.options.channelId);
  expect(extendTimeout).toHaveBeenCalledWith(f.options.channelId);
  await handler(event('xangi_thread_leave') as any);
  expect(remove).toHaveBeenCalledWith('user');
  expect(destroy).not.toHaveBeenCalled();
  expect(getSessionEntry(f.run.appSessionId)?.lifecycle).toBe('open');
  f.store.markSucceeded(f.run.id, { result: 'done', sessionId: 'p' });
  remove.mockRejectedValueOnce({ code: 50013 });
  await handler(event('xangi_thread_leave') as any);
  expect(getSessionEntry(f.run.appSessionId)?.lifecycle).toBe('open');
  const completedClose = event('xangi_thread_leave');
  await handler(completedClose as any);
  expect(getSessionEntry(f.run.appSessionId)?.lifecycle).toBe('closed');
  expect(completedClose.editReply).toHaveBeenCalledWith(
    '🚪 セッションを終了して、このスレッドから退出しました'
  );
});


it('closes completed work and reopens the same session for a later follow-up', async () => {
  const f = await setup();
  await executeAgentWork(f.run, f.store, f.options, f.runner.runStream.bind(f.runner));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const run = f.store.get(f.run.id)!;
  expect(closeAgentWork('discord', run.workThread!.threadId)).toBe('closed');
  expect(getSessionEntry(run.appSessionId)?.lifecycle).toBe('closed');
  expect(getActiveSessionId(f.options.channelId!)).toBeUndefined();
  submitAgentWork('discord', run.workThread!.threadId, 'follow-after-close', '続きを確認して');
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalled());
  expect(getSessionEntry(run.appSessionId)?.lifecycle).toBe('open');
  expect(getActiveSessionId(f.options.channelId!)).toBe(run.appSessionId);
  expect(f.runner.runStream).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object),
    expect.objectContaining({ appSessionId: run.appSessionId, sessionId: 'provider-1' }));
});

it('keeps queued follow-ups open when Close is pressed', async () => {
  const f = await setup();
  await prepareAgentWork(f.run, f.store);
  const thread = f.store.get(f.run.id)!.workThread!;
  expect(closeAgentWork('discord', thread.threadId)).toBe('busy');
  f.store.markSucceeded(f.run.id, { result: 'done', sessionId: 'p' });
  f.store.enqueueWorkInput(f.run.id, { id: 'pending', text: 'next' });
  expect(closeAgentWork('discord', thread.threadId)).toBe('busy');
  expect(getSessionEntry(f.run.appSessionId)?.lifecycle).toBe('open');
});

it('uses shared Slack controls for child execution, history, safe Close and continuation', async () => {
  const { registerSlackAgentWork } = await import('../src/slack-agent-work.js');
  const { createSlackWorkUi, refreshSlackProcessingBlocks, handleSlackNewAction, handleSlackStopAction, handleSlackExtendAction, resolveSlackHistoryActionContext } = await import('../src/slack.js');
  const f = await setup(false);
  f.store.setWorkThread(f.run.id, { platform: 'slack', channelId: 'CWORK', threadId: 'CWORK:1700.1', url: '' });
  const messages: any[] = [], updates: any[] = [];
  const client = {
    chat: {
      postMessage: vi.fn(async (message: any) => { messages.push(message); return { ts: `1700.${messages.length + 1}` }; }),
      update: vi.fn(async (message: any) => { updates.push(message); return {}; }),
      postEphemeral: vi.fn(async () => ({})),
    },
    reactions: { add: vi.fn(async () => ({})) },
  };
  f.runner.cancel = vi.fn(() => true);
  f.runner.extendTimeout = vi.fn(() => ({ ok: true }));
  f.runner.getTimeoutState = () => ({ active: true, timeoutAt: Date.now() + 60000, maxTimeoutAt: Date.now() + 600000 });
  registerSlackAgentWork(client as any, createSlackWorkUi(f.runner));
  let release!: () => void;
  const execution = executeAgentWork(f.store.get(f.run.id)!, f.store, f.options, async (_prompt, callbacks) => {
    callbacks.onText?.('Slack途中経過', 'Slack途中経過');
    callbacks.onToolUse?.('web_fetch', { url: 'https://example.com/slack-first' });
    await new Promise<void>((resolve) => { release = resolve; });
    return { result: '完了本文', sessionId: 'slack-provider' };
  });
  await vi.waitFor(() => expect(release).toBeDefined());
  const running = messages.find((message) => message.text === '作業中');
  expect(running.blocks[1].elements.map((button: any) => button.action_id)).toEqual(['xangi_stop', 'xangi_extend', 'xangi_timeout_display']);
  const body = { channel: { id: 'CWORK' }, user: { id: 'user' }, message: { ts: '1700.2', thread_ts: '1700.1', text: '完了本文' } };
  await handleSlackStopAction({ ...body, user: { id: 'other' } }, f.runner, ['user']);
  expect(f.runner.cancel).not.toHaveBeenCalled();
  await handleSlackStopAction(body, f.runner, ['user']);
  await handleSlackExtendAction(body, client as any, f.runner, ['user']);
  expect(f.runner.cancel).toHaveBeenCalledWith(f.options.channelId);
  expect(f.runner.extendTimeout).toHaveBeenCalledWith(f.options.channelId);
  await refreshSlackProcessingBlocks(client as any, f.runner, f.options.channelId!);
  expect(updates.at(-1)).toMatchObject({ channel: 'CWORK', ts: '1700.3' });
  expect(updates.at(-1).blocks[1].elements.some((button: any) => button.action_id === 'xangi_timeout_display')).toBe(true);
  await handleSlackNewAction(body, client as any, f.runner, ['user']);
  expect(getSessionEntry(f.run.appSessionId)?.lifecycle).toBe('open');
  expect(client.reactions.add).not.toHaveBeenCalled();
  release();
  await execution;
  const result = messages.at(-1);
  expect(result.blocks[1].elements.map((button: any) => button.text.text)).toEqual(['Close', 'History']);
  const context = resolveSlackHistoryActionContext(body.message, result.blocks[1].elements[1].value);
  expect(context.threadId).toBe(`web:${f.run.appSessionId}`);
  expect(context.threadTs).toBe('1700.1');
  clearActivities();
  expect(readTurnHistory(context.threadId!, 200).filter((entry) => entry.turnId === context.turnId).some((entry) => entry.kind === 'tool' && entry.summary.includes('slack-first'))).toBe(true);
  const updateCount = updates.length;
  await handleSlackNewAction(body, client as any, f.runner, ['user']);
  expect(getSessionEntry(f.run.appSessionId)?.lifecycle).toBe('closed');
  expect(client.reactions.add).toHaveBeenCalled();
  expect(updates.length).toBe(updateCount); // Close preserves the original History button.
  submitAgentWork('slack', 'CWORK:1700.1', 'after-slack-close', '続けて');
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalled());
  expect(getSessionEntry(f.run.appSessionId)?.lifecycle).toBe('open');
});


it('marks all Discord posts of a split assignment as work requests', async () => {
  const f = await setup();
  const thread = {
    id: 'long-assignment',
    url: 'https://discord.invalid/long-assignment',
    isTextBased: () => true,
    send: vi.fn(),
  };
  const channel = {
    isTextBased: () => true,
    isThread: () => false,
    isDMBased: () => false,
    send: vi.fn(async () => ({ startThread: async () => thread })),
  };
  registerDiscordAgentWork({
    channels: { fetch: async (id: string) => id === 'work-channel' ? channel : thread },
  } as unknown as Client);
  await prepareAgentWork({ ...f.run, task: '長い依頼。'.repeat(600) + '依頼の末尾' }, f.store);
  expect(isWorkRequestPost(channel.send.mock.calls[0][0].content)).toBe(true);
  expect(thread.send.mock.calls.length).toBeGreaterThan(1);
  for (const [{ content }] of thread.send.mock.calls) {
    expect(isWorkRequestPost(content)).toBe(true);
    expect(content.length).toBeLessThanOrEqual(2000);
  }
  expect(thread.send.mock.calls.at(-1)?.[0].content).toContain('依頼の末尾');
});

it('requires in-thread posting permission from the requester only for long assignments', async () => {
  const f = await setup();
  const thread = { id: 'short-thread', url: 'https://discord.invalid/short-thread' };
  const send = vi.fn(async () => ({ startThread: async () => thread }));
  const permissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.CreatePublicThreads,
  ]);
  registerDiscordAgentWork({
    user: { id: 'requester' },
    channels: { fetch: async () => ({
      isTextBased: () => true,
      isThread: () => false,
      isDMBased: () => false,
      permissionsFor: () => permissions,
      send,
    }) },
  } as unknown as Client);
  await expect(prepareAgentWork(f.run, f.store)).resolves.toMatchObject({ threadId: thread.id });
  const longRun = f.store.create({ ...f.run, task: '長い依頼。'.repeat(600) });
  await expect(prepareAgentWork(longRun, f.store)).rejects.toThrow('依頼元Bot');
  expect(send).toHaveBeenCalledTimes(1);
});

it('checks thread permissions before the requesting Bot posts', async () => {
  const f = await setup();
  const send = vi.fn();
  const permissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
  ]);
  registerDiscordAgentWork({
    user: { id: 'requester' },
    channels: { fetch: async () => ({
      isTextBased: () => true,
      isThread: () => false,
      isDMBased: () => false,
      permissionsFor: () => permissions,
      send,
    }) },
  } as unknown as Client);
  await expect(prepareAgentWork(f.run, f.store)).rejects.toThrow('依頼元Bot');
  expect(send).not.toHaveBeenCalled();
  expect(f.store.get(f.run.id)?.workThread).toBeUndefined();
});

it('posts the shared Bot request and sends replies and controls through the assigned Bot', async () => {
  const f = await setup();
  const worker = join(root, 'work-worker.mjs');
  const eventsPath = join(root, 'discord-events.jsonl');
  const moduleUrl = (name: string) => pathToFileURL(resolve('src', name)).href;
  writeFileSync(worker, `
    import { appendFileSync } from 'node:fs';
    import { registerDiscordAgentWork } from ${JSON.stringify(moduleUrl('discord/agent-work.ts'))};
    import { installDedicatedDiscordWorkWorker, relayDedicatedWorkInput } from ${JSON.stringify(moduleUrl('agent-connection-work.ts'))};
    const record = (event) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
    const threadId = 'dedicated-thread';
    let sequence = 0;
    let submitted = false;
    const thread = {
      id: threadId, url: 'https://discord.com/channels/test/dedicated-thread',
      isTextBased: () => true,
      send: async (options) => {
        record({ kind: 'message', content: options.content, components: options.components });
        if (options.content.startsWith('応答完了\\n\\n') && !submitted) {
          submitted = true;
          const request = { action: 'input', threadId, messageId: 'discord-message', text: '追記して', hasAttachments: false };
          setImmediate(async () => {
            const blocked = await relayDedicatedWorkInput({ ...request, userId: '999' });
            const accepted = await relayDedicatedWorkInput({ ...request, userId: '123' });
            record({ kind: 'input', blocked: blocked ?? null, accepted });
          });
        }
        return { id: 'message-' + ++sequence, edit: async (options) => record({ kind: 'edit', ...options }) };
      },
    };
    const parent = {
      isTextBased: () => true, isThread: () => false, isDMBased: () => false,
      send: async (options) => {
        record({ kind: 'starter', content: options.content, bot: process.env.XANGI_AGENT_CONNECTION_ID });
        return { startThread: async () => thread };
      },
    };
    registerDiscordAgentWork({ channels: { fetch: async (id) => id === 'work-channel' ? parent : thread } });
    installDedicatedDiscordWorkWorker();
    process.send({ type: 'agent-connection-ready' });
    process.on('SIGTERM', () => process.exit(0));
  `);
  const connection = await new AgentConnectionStore(root).save(f.run.agentId!, {
    platform: 'discord', botToken: 'dedicated-fixture', allowedUsers: '123',
  });
  f.transport.create.mockResolvedValue({
    platform: 'discord', channelId: 'work-channel', threadId: 'dedicated-thread',
    url: 'https://discord.com/channels/test/dedicated-thread',
  });
  const runtimes = new AgentConnectionRuntimes(root, root, f.registry, { entry: worker });
  let finish: (() => void) | undefined;
  try {
    const originalArgs = process.execArgv;
    try {
      process.execArgv = ['--import', createRequire(import.meta.url).resolve('tsx')];
      await runtimes.start();
    } finally {
      process.execArgv = originalArgs;
    }
    const timeoutAt = Date.now() + 30_000;
    f.runner.getTimeoutState = () => ({ active: true, timeoutAt, maxTimeoutAt: timeoutAt + 120_000 });
    f.runner.cancel = vi.fn(() => true);
    f.runner.extendTimeout = vi.fn(() => ({ ok: true }));
    const thread = await prepareAgentWork(f.run, f.store);
    expect(thread).toMatchObject({ connectionId: connection.id, threadId: 'dedicated-thread' });
    f.run.workThread = thread;

    const execution = executeAgentWork(f.run, f.store, f.options, async (_prompt, callbacks) => {
      callbacks.onText?.('進んでいます', '進んでいます');
      callbacks.onToolUse?.('read', { path: 'example.txt' });
      await new Promise<void>((resolveTurn) => { finish = resolveTurn; });
      return { result: '最初の回答', sessionId: 'dedicated-provider-session' };
    });
    const getEvents = () => readFileSync(eventsPath, 'utf8').trim().split('\n').map((event) => JSON.parse(event));
    await vi.waitFor(() => expect(getEvents()).toContainEqual(
      expect.objectContaining({ kind: 'edit', content: '実行中: read' })
    ));
    expect(await handleDedicatedWorkInput(
      { ...connection, id: 'different-discord-connection' },
      { action: 'stop', threadId: thread!.threadId, userId: '123' }
    )).toBeUndefined();
    expect(await handleDedicatedWorkInput(
      { ...connection, agentId: 'different-agent' },
      { action: 'close', threadId: thread!.threadId, userId: '123' }
    )).toBeUndefined();
    await vi.waitFor(() => expect(getEvents().some(
      (event) => event.kind === 'edit' &&
        event.components?.[0].components.some((button: { custom_id: string }) => button.custom_id === 'xangi_extend')
    )).toBe(true), { timeout: 3_000 });
    await expect(handleDedicatedWorkInput(
      connection, { action: 'extend', threadId: thread!.threadId, userId: '123' }
    )).resolves.toEqual({ ok: true });
    await expect(handleDedicatedWorkInput(
      connection, { action: 'stop', threadId: thread!.threadId, userId: '123' }
    )).resolves.toBe(true);
    expect(f.runner.cancel).toHaveBeenCalledWith(f.options.channelId);
    expect(f.runner.extendTimeout).toHaveBeenCalledWith(f.options.channelId);
    finish!();
    await execution;
    await vi.waitFor(() => expect(f.runner.runStream).toHaveBeenCalledWith(
      expect.stringContaining('追記して'), expect.anything(),
      expect.objectContaining({ appSessionId: f.run.appSessionId, sessionId: 'dedicated-provider-session' })
    ));
    await vi.waitFor(() => expect(f.store.get(f.run.id)?.status).toBe('succeeded'));
    const events = getEvents();
    expect(events.some((event) => event.kind === 'starter')).toBe(false);
    expect(f.transport.create).toHaveBeenCalledExactlyOnceWith(
      'work-channel', expect.any(String), expect.stringContaining('担当: 調査担当')
    );
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'input', blocked: null, accepted: expect.stringContaining('追加指示を受け付けました'),
    }));
    const firstResult = events.find((event) => event.content === '応答完了\n\n最初の回答');
    expect(firstResult.components[0].components.map((button: { custom_id: string }) => button.custom_id)).toEqual([
      'xangi_thread_leave',
      expect.stringMatching(/^xangi_tools\|web:/),
    ]);
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(AgentRunStore.fromDataDir(root).get(f.run.id)?.workThread?.connectionId).toBe(connection.id);
  } finally {
    finish?.();
    await runtimes.stop();
  }
}, 15_000);

it('does not silently use the shared Discord Bot when the assigned connection is disabled', async () => {
  const f = await setup();
  const store = new AgentConnectionStore(root);
  await store.save(f.run.agentId!, {
    platform: 'discord', botToken: 'disabled-fixture', allowedUsers: '123', enabled: false,
  });
  const runtimes = new AgentConnectionRuntimes(root, root, f.registry);
  await runtimes.start();
  try {
    await expect(prepareAgentWork(f.run, f.store)).rejects.toThrow('専用Botが無効');
    expect(f.transport.create).not.toHaveBeenCalled();
  } finally {
    await runtimes.stop();
  }
});

it('posts dedicated Bot requests and delivers replies from shared and dedicated recipients', async () => {
  const f = await setup();
  const worker = join(root, 'relay-worker.mjs');
  const eventsPath = join(root, 'relay-events.jsonl');
  const moduleUrl = (name: string) => pathToFileURL(resolve('src', name)).href;
  const defaultAgentId = 'xangi:default';
  await changeChannelAgent('discord', 'default-channel', defaultAgentId);
  const catalog = new ProjectCatalog(root);
  const caller = catalog.saveAgent({ name: '依頼元', prompt: '', workspaceId: 'default' });
  const connections = new AgentConnectionStore(root);
  const requester = await connections.save(caller.id, {
    platform: 'discord', botToken: 'relay-caller-fixture', allowedUsers: '123',
  });
  const recipient = await connections.save(f.run.agentId!, {
    platform: 'discord', botToken: 'relay-recipient-fixture', allowedUsers: '456',
  });
  writeFileSync(worker, `
    import { appendFileSync } from 'node:fs';
    import { installDedicatedDiscordWorkWorker, relayDedicatedWorkInput, sharedDelegationDefaults } from ${JSON.stringify(moduleUrl('agent-connection-work.ts'))};
    import { AgentRunStore } from ${JSON.stringify(moduleUrl('agent-runs.ts'))};
    import { registerWorkTransport, registerAgentWork, prepareAgentWork, executeAgentWork } from ${JSON.stringify(moduleUrl('agent-work.ts'))};
    import { initSessions, createWebSession } from ${JSON.stringify(moduleUrl('sessions.ts'))};
    const record = (event) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
    const connectionId = process.env.XANGI_AGENT_CONNECTION_ID;
    const agentId = process.env.XANGI_CONNECTION_AGENT_ID;
    const repliedThreads = new Set();
    registerWorkTransport('discord', {
      create: async (channelId, title, text) => {
        const threadId = 'thread-' + connectionId + '-' + channelId;
        record({ kind: 'starter', connectionId, channelId, threadId, text });
        return { platform: 'discord', channelId, threadId, url: 'https://discord.invalid/' + threadId };
      },
      progress: async () => {},
      send: async (thread, text) => {
        record({ kind: 'post', connectionId, threadId: thread.threadId, text });
        if (text === '応答完了\\n\\n最初の結果' && !repliedThreads.has(thread.threadId)) {
          repliedThreads.add(thread.threadId);
          setImmediate(async () => {
            const request = { action: 'input', threadId: thread.threadId, messageId: 'dedicated-follow-up', text: '専用側から続けて', hasAttachments: false };
            const blocked = await relayDedicatedWorkInput({ ...request, userId: '123' });
            const accepted = await relayDedicatedWorkInput({ ...request, userId: '456' });
            record({ kind: 'dedicated-input', blocked: blocked ?? null, accepted });
          });
        }
      },
    });
    installDedicatedDiscordWorkWorker();
    process.send({ type: 'agent-connection-ready' });
    process.on('SIGTERM', () => process.exit(0));
    if (agentId === ${JSON.stringify(caller.id)}) {
      const dataDir = process.env.DATA_DIR;
      initSessions(dataDir);
      const store = AgentRunStore.fromDataDir(dataDir);
      const runFollowUp = async (prompt, _callbacks, options) => {
        record({ kind: 'follow-up', prompt, sessionId: options.sessionId });
        return { result: '追加結果', sessionId: options.sessionId };
      };
      registerAgentWork({
        store,
        runner: { runStream: runFollowUp },
        notify: (run) => record({ kind: 'notify', agentId: run.agentId, result: run.result }),
      });
      if (store.list().length === 0) (async () => {
        record({ kind: 'defaults', value: await sharedDelegationDefaults() });
        const delegatedParent = createWebSession({
          selectedAgentId: ${JSON.stringify(f.run.agentId)}, workspacePath: process.cwd(),
        });
        const jobs = [
          [${JSON.stringify(defaultAgentId)}, undefined],
          [${JSON.stringify(f.run.agentId)}, undefined],
          [${JSON.stringify(defaultAgentId)}, delegatedParent],
        ];
        for (const [target, parentAppSessionId] of jobs) {
          const appSessionId = createWebSession({ workspacePath: process.cwd() });
          const run = store.create({
            task: '作業内容', agentId: target, workspaceId: 'default', workspacePath: process.cwd(),
            backend: 'codex', appSessionId, parentAppSessionId,
          });
          const thread = await prepareAgentWork(run, store);
          await executeAgentWork({ ...run, workThread: thread }, store, {
            workdir: process.cwd(), channelId: 'web-chat:' + appSessionId, appSessionId,
          }, async (prompt, callbacks, options) =>
            prompt.includes('[Additional user instructions]')
              ? runFollowUp(prompt, callbacks, options)
              : { result: '最初の結果', sessionId: 'provider-' + target }
          );
        }
      })().catch((error) => record({ kind: 'error', message: String(error) }));
    }
  `);
  const sharedThreadId = `thread-${requester.id}-default-channel`;
  const dedicatedThreadId = `thread-${requester.id}-work-channel`;
  const makeRuntimes = () => new AgentConnectionRuntimes(root, root, f.registry, {
    entry: worker,
    runtimeSettings: {
      resolver: { resolve: () => ({ backend: 'codex', effort: 'high' }) },
    } as NonNullable<ConstructorParameters<typeof AgentConnectionRuntimes>[3]>['runtimeSettings'],
  });
  let runtimes = makeRuntimes();
  const startRuntimes = async () => {
    const args = process.execArgv;
    try {
      process.execArgv = ['--import', createRequire(import.meta.url).resolve('tsx')];
      await runtimes.start();
    } finally {
      process.execArgv = args;
    }
  };
  try {
    await startRuntimes();
    const events = () => readFileSync(eventsPath, 'utf8').trim().split('\n').map((row) => JSON.parse(row));
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: sharedThreadId }), '応答完了\n\n最初の結果', expect.any(Object)
    ), { timeout: 6_000 });
    expect(f.transport.create).not.toHaveBeenCalled();
    await expect(relayDedicatedWorkInput({
      action: 'input', threadId: sharedThreadId, userId: '123',
      messageId: 'shared-follow-up', text: '共通側から続けて', hasAttachments: false,
    })).resolves.toContain('追加指示を受け付けました');
    await vi.waitFor(() => expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'defaults', value: { backend: 'codex', effort: 'high' } }),
      expect.objectContaining({ kind: 'starter', channelId: 'default-channel', connectionId: requester.id }),
      expect.objectContaining({ kind: 'starter', channelId: 'work-channel', connectionId: requester.id }),
      expect.objectContaining({ kind: 'starter', channelId: 'default-channel', connectionId: recipient.id }),
      expect.objectContaining({ kind: 'post', threadId: dedicatedThreadId, connectionId: recipient.id, text: '応答完了\n\n最初の結果' }),
      expect.objectContaining({ kind: 'follow-up', prompt: expect.stringContaining('共通側から続けて'), sessionId: 'provider-' + defaultAgentId }),
      expect.objectContaining({ kind: 'follow-up', prompt: expect.stringContaining('専用側から続けて'), sessionId: 'provider-' + f.run.agentId }),
      expect.objectContaining({ kind: 'dedicated-input', blocked: null, accepted: expect.stringContaining('追加指示を受け付けました') }),
      expect.objectContaining({ kind: 'notify', agentId: defaultAgentId, result: '追加結果' }),
      expect.objectContaining({ kind: 'notify', agentId: f.run.agentId, result: '追加結果' }),
    ])), { timeout: 6_000 });
    expect(events().filter(({ kind }) => kind === 'follow-up')).toHaveLength(2);
    expect(events().filter(({ kind }) => kind === 'error')).toEqual([]);
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: `thread-${recipient.id}-default-channel` }),
      '応答完了\n\n最初の結果', expect.any(Object)
    ));

    await runtimes.stop();
    runtimes = makeRuntimes();
    await startRuntimes();
    await expect(relayDedicatedWorkInput({
      action: 'input', threadId: sharedThreadId, userId: '123',
      messageId: 'restored-follow-up', text: '再起動後に続けて', hasAttachments: false,
    })).resolves.toContain('追加指示を受け付けました');
    await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({
      kind: 'follow-up', prompt: expect.stringContaining('再起動後に続けて'),
      sessionId: 'provider-' + defaultAgentId,
    })));
    expect(events().filter(({ kind }) => kind === 'starter')).toHaveLength(3);
  } finally {
    await runtimes.stop();
  }
}, 20_000);
