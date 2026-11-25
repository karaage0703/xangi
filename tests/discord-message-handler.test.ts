import { Events, type Client, type Message } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  processPrompt,
  registerDiscordMessageHandlers,
  sendDiscordCompletedResult,
  shouldProcessDiscordMessage,
} from '../src/discord/message-handler.js';
import { formatAgentWork, WORK_REQUEST_THREAD_DETAILS, WORK_REQUEST_CONTINUATION } from '../src/agent-work-presentation.js';
import { DiscordTurnCoordinator } from '../src/discord/turn-coordinator.js';
import { AntigravityTimeoutError, AntigravityTurnError } from '../src/errors.js';
import { createCompletedButtons } from '../src/discord/ui.js';
import { clearSessions, initSessions, setSession } from '../src/sessions.js';
import { clearSettingsCache, initSettings, saveSettings } from '../src/settings.js';
import { ProjectCatalog } from '../src/project-catalog.js';
import { acceptsWorkChannelMessage } from '../src/agent-work-channel-routing.js';
import { finalizeActiveStreams } from '../src/stream-finalizer.js';
import { logPrompt, readSessionMessages } from '../src/transcript-logger.js';

const originalSplitDelay = process.env.DISCORD_SPLIT_SEND_DELAY_MS;

afterEach(() => {
  if (originalSplitDelay === undefined) {
    delete process.env.DISCORD_SPLIT_SEND_DELAY_MS;
  } else {
    process.env.DISCORD_SPLIT_SEND_DELAY_MS = originalSplitDelay;
  }
});

describe('shouldProcessDiscordMessage', () => {
  it('processes normal messages', () => {
    expect(shouldProcessDiscordMessage({ system: false })).toBe(true);
  });

  it('does not process Discord system messages', () => {
    expect(shouldProcessDiscordMessage({ system: true })).toBe(false);
  });
});

it.each([
  formatAgentWork('作業をお願いします', '担当').text,
  `作業をお願いします\n${WORK_REQUEST_THREAD_DETAILS}`,
  `${WORK_REQUEST_CONTINUATION}分割された依頼文`,
])('does not auto-reply to an assignment posted by another Bot', async (content) => {
  const on = vi.fn();
  const checkMention = vi.fn(() => true);
  registerDiscordMessageHandlers({
    client: { on, user: { id: 'responder' } } as unknown as Client,
    config: {
      discord: { respondToBotsEnabled: true, respondToBots: ['requester'] },
      agent: { config: {} },
    },
    agentRunner: {},
    workdir: tmpdir(),
    workspaceRegistry: {},
  } as unknown as Parameters<typeof registerDiscordMessageHandlers>[0]);
  await on.mock.calls.find(([event]) => event === Events.MessageCreate)![1]({
    author: { id: 'requester', bot: true },
    channel: { id: 'work-thread' },
    mentions: { has: checkMention },
    content,
  });
  expect(checkMention).not.toHaveBeenCalled();
});

it('lets only the assigned Discord Bot process an autoreply in a linked Project thread', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'discord-project-routing-'));
  try {
    initSettings(dataDir);
    saveSettings({ discordAutoReplyChannels: { 'project-channel': true } });
    const catalog = new ProjectCatalog(dataDir);
    const agent = catalog.saveAgent({ name: 'Dedicated Agent' });
    writeFileSync(join(dataDir, 'channel-agents.json'), JSON.stringify({
      [JSON.stringify(['discord', 'project-channel'])]: agent.id,
    }));
    const bot = { id: 'dedicated-bot', agentId: agent.id, platform: 'discord' as const, enabled: true };
    const contents = vi.fn(() => '');
    const message = {
      guild: {},
      author: { bot: false, id: 'user' },
      channel: { id: 'project-thread', isThread: () => true, parentId: 'project-channel' },
      attachments: new Map(),
      mentions: { has: () => false },
      get content() {
        return contents();
      },
    } as unknown as Message;

    async function receive(connectionId: string | undefined, connections = [bot]) {
      const on = vi.fn();
      registerDiscordMessageHandlers({
        client: { on, user: {} } as unknown as Client,
        config: { discord: { allowedUsers: ['user'] }, agent: { config: {} } },
        agentRunner: {},
        workdir: dataDir,
        workspaceRegistry: {},
        acceptWorkChannelMessage: (channelId: string) =>
          acceptsWorkChannelMessage(dataDir, connections, 'discord', channelId, connectionId),
      } as unknown as Parameters<typeof registerDiscordMessageHandlers>[0]);
      await on.mock.calls.find(([event]) => event === Events.MessageCreate)![1](message);
    }

    await receive(undefined);
    await receive('other');
    expect(contents).not.toHaveBeenCalled();
    await receive('dedicated-bot');
    expect(contents).toHaveBeenCalledTimes(1);
    expect(() =>
      acceptsWorkChannelMessage(dataDir, [{ ...bot, enabled: false }], 'discord', 'project-channel')
    ).toThrow('専用Botが無効');
    expect(() =>
      acceptsWorkChannelMessage(dataDir, [bot, { ...bot, id: 'duplicate' }], 'discord', 'project-channel')
    ).toThrow('専用Botを1つだけ');
  } finally {
    clearSettingsCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('processPrompt error completion', () => {
  it.each([
    [
      new AntigravityTimeoutError('terminated task-1', 'agy-session', '途中の回答'),
      'Agyの時間上限に達したため',
    ],
    [
      new AntigravityTimeoutError('terminated task-1', 'agy-session', '途中の回答' + 'x'.repeat(7891)),
      'Agyの時間上限に達したため',
    ],
    [
      new AntigravityTurnError('error', 'AGY_HOOK_BLOCKED: policy stopped this turn.'),
      'AGY_HOOK_BLOCKED: policy stopped this turn.',
    ],
    [
      new AntigravityTurnError('interrupted', 'Antigravity CLI was interrupted'),
      'Agyの処理が中断されました',
    ],
    [
      "You've hit your session limit · resets 5am (Asia/Tokyo)",
      '💳 バックエンドの利用上限に達しています',
    ],
    ['LLM request timed out after 300000ms', '⏱️ タイムアウトしました'],
    ['This operation was aborted', '❌ エラーが発生しました'],
    ['Process exited unexpectedly with code 1', '💥 AIプロセスが予期せず終了しました'],
    ['Some random error', '❌ エラーが発生しました'],
    ['Runner is shutting down', '❌ エラーが発生しました'],
    ['Request cancelled by user', '🛑 停止しました'],
    ['Runner is shutting down', '⏸ プロセス再起動により中断されました', true],
    ['Process exited during shutdown (code 0)', '⏸ プロセス再起動により中断されました', true],
  ])('ends %s with %s without follow-up and accepts the next turn', async (errorMessage, display, shutdown) => {
    const testDir = mkdtempSync(join(tmpdir(), 'xangi-session-limit-'));
    clearSessions();
    initSessions(testDir);
    initSettings(testDir);
    setSession('session-limit-test', 'existing-claude-session');
    const edit = vi.fn().mockResolvedValue(undefined);
    const replyMessage = { id: 'reply', edit };
    const sendInitial = vi.fn().mockResolvedValue(replyMessage);
    const runStream = vi.fn().mockImplementation(async (_prompt, callbacks, options) => {
      logPrompt(testDir, options.appSessionId, '確認');
      callbacks.onText?.('途中の回答', '途中の回答');
      callbacks.onToolUse?.('Bash', { command: 'pwd' });
      if (shutdown) await finalizeActiveStreams();
      const error = errorMessage instanceof Error ? errorMessage : new Error(errorMessage);
      callbacks.onError?.(error);
      throw error;
    });
    const run = vi.fn();
    const message = {
      id: 'source',
      content: '確認',
      createdTimestamp: Date.now(),
      channel: { name: 'test' },
      author: { id: 'user', displayName: 'user' },
      reactions: { cache: { find: () => undefined } },
      client: { user: { id: 'bot' } },
    };
    const target = {
      conversationChannelId: 'session-limit-test',
      settingsChannelId: 'session-limit-test',
      createdThreadName: null,
      threadName: null,
      parentChannelName: null,
      isThread: false,
      outputChannel: { send: vi.fn() },
      sendInitial,
    };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const coordinator = new DiscordTurnCoordinator();
      const turn = () =>
        processPrompt(
          message as never,
          { runStream, run } as never,
          '確認',
          false,
          'session-limit-test',
          {
            agent: {
              backend: errorMessage instanceof AntigravityTurnError ? 'antigravity' : 'claude-code',
              config: { workdir: testDir },
            },
            discord: { streaming: true, showButtons: false, replySuggestions: false },
          } as never,
          target as never,
          { id: 'user', name: 'user', messageId: 'source', react: false }
        );

      const first = await coordinator.tryRun('session-limit-test', turn);
      expect(first).toEqual({ accepted: true, result: null });
      expect(coordinator.isBusy('session-limit-test')).toBe(false);
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      if (errorMessage instanceof AntigravityTimeoutError) {
        const content = edit.mock.calls.at(-1)?.[0].content;
        expect(content.match(/途中の回答/g)).toHaveLength(1);
        expect(content).toContain('未完了');
        expect(content.length).toBeLessThanOrEqual(2000);
        if (errorMessage.partialResponse.length > 2000) {
          expect(content).toMatch(/…（以下省略）$/);
        }
      }
      expect(edit).toHaveBeenLastCalledWith({
        content: expect.stringContaining(display),
        components: [],
      });
      if (errorMessage === 'Request cancelled by user') {
        const appSessionId = runStream.mock.calls[0][2].appSessionId;
        expect(readSessionMessages(testDir, appSessionId).at(-1)).toMatchObject({
          role: 'assistant',
          content: { result: expect.stringContaining('途中の回答') },
        });
      }
      if (shutdown) {
        expect(edit.mock.calls.at(-1)?.[0].content).toContain('途中の回答');
        expect(edit.mock.calls.at(-1)?.[0].content).toContain('pwd');
        expect(errorLog).not.toHaveBeenCalled();
        const appSessionId = runStream.mock.calls[0][2].appSessionId;
        expect(readSessionMessages(testDir, appSessionId).at(-1)).toMatchObject({
          role: 'assistant',
          content: { result: expect.stringContaining(display) },
        });
      }
      const latencyDir = join(testDir, 'logs', 'turn-latency');
      const latencyRecords = readdirSync(latencyDir).flatMap((file) =>
        readFileSync(join(latencyDir, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      );
      expect(latencyRecords.at(-1)?.outcome).toBe(
        shutdown || errorMessage === 'Request cancelled by user' ? 'cancelled' : 'error'
      );
      expect(target.outputChannel.send).not.toHaveBeenCalled();
      const next = await coordinator.tryRun('session-limit-test', turn);
      expect(next.accepted).toBe(true);
      expect(runStream).toHaveBeenCalledTimes(2);
      expect(run).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      clearSessions();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('sendDiscordCompletedResult', () => {
  it('keeps a split fenced code block valid in every Discord message', async () => {
    process.env.DISCORD_SPLIT_SEND_DELAY_MS = '0';
    const edit = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ id: 'followup' });
    const code = ['```text', ...Array.from({ length: 120 }, () => 'x'.repeat(30)), '```'].join(
      '\n'
    );

    await sendDiscordCompletedResult({
      replyMessage: { id: 'initial-message', edit } as never,
      outputChannel: { send } as never,
      messageParts: [code],
    });

    const firstContent = edit.mock.calls[0][0].content as string;
    expect(firstContent).toMatch(/^```text\n/);
    expect(firstContent).toMatch(/\n```$/);
    expect(firstContent.length).toBeLessThanOrEqual(1900);
    expect(send).toHaveBeenCalled();
    for (const [content] of send.mock.calls) {
      expect(content).toMatch(/^```text\n/);
      expect(content.length).toBeLessThanOrEqual(1900);
    }
  });

  it('puts completed buttons only on the final split message', async () => {
    process.env.DISCORD_SPLIT_SEND_DELAY_MS = '0';
    const edit = vi.fn().mockResolvedValue(undefined);
    const finalMessage = { id: 'final-message' };
    const send = vi.fn().mockResolvedValue(finalMessage);
    const completedButtons = createCompletedButtons({ showTools: true });

    const result = await sendDiscordCompletedResult({
      replyMessage: { id: 'initial-message', edit } as never,
      outputChannel: { send } as never,
      messageParts: ['最初の投稿', '最後の投稿'],
      completedButtons,
    });

    expect(edit).toHaveBeenCalledWith({ content: '最初の投稿', components: [] });
    expect(send).toHaveBeenCalledWith({
      content: '最後の投稿',
      components: [completedButtons],
    });
    expect(result).toBe(finalMessage);
  });
});
