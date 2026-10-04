import { clearActivities, readTurnHistory } from '../src/activity-store.js';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunStore } from '../src/agent-runs.js';
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
  return { store, run, runner, transport, notify, options };
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
