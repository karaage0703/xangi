import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Events } from 'discord.js';
import type { Client, Message } from 'discord.js';
import type { AgentRunner } from '../src/agent-runner.js';
import type { Config } from '../src/config.js';
import { registerDiscordMessageHandlers } from '../src/discord/message-handler.js';
import {
  buildDiscordChannelContextLine,
  resolveConversationChannelId,
} from '../src/discord/thread-context.js';
import { clearSettingsCache, initSettings, saveSettings } from '../src/settings.js';
import { clearSessions, initSessions } from '../src/sessions.js';

let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'xangi-discord-thread-test-'));
  clearSettingsCache();
  initSettings(tempDir);
  initSessions(tempDir);
});

afterEach(() => {
  clearSettingsCache();
  clearSessions();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('resolveConversationChannelId', () => {
  it('新規スレッドを作成できた場合は会話キーをそのスレッドIDにする', () => {
    // DISCORD_REPLY_IN_THREAD=true で親チャンネルの発言から thread を作成したケース。
    // セッション/ランナー/イベントのキーが親ではなく thread ID になる必要がある。
    expect(resolveConversationChannelId('parent-channel-123', 'created-thread-456')).toBe(
      'created-thread-456'
    );
  });

  it('スレッドを作成しなかった場合（既にスレッド内 / DM / 作成不可）は受信チャンネルIDを使う', () => {
    expect(resolveConversationChannelId('channel-123', undefined)).toBe('channel-123');
  });
});

describe('buildDiscordChannelContextLine', () => {
  it('新規スレッドを作成した場合は親チャンネル名とスレッド名を両方表示する', () => {
    expect(
      buildDiscordChannelContextLine({
        channelName: 'dev_xangi',
        conversationChannelId: 'thread-456',
        createdThreadName: 'thread title',
      })
    ).toBe('[チャンネル: #dev_xangi / thread: thread title (ID: thread-456)]');
  });

  it('通常チャンネルや既存スレッドでは従来のチャンネル表示を使う', () => {
    expect(
      buildDiscordChannelContextLine({
        channelName: 'dev_xangi',
        conversationChannelId: 'channel-123',
      })
    ).toBe('[チャンネル: #dev_xangi (ID: channel-123)]');
  });

  it('DM などチャンネル名がない場合はチャンネル行を出さない', () => {
    expect(
      buildDiscordChannelContextLine({
        channelName: null,
        conversationChannelId: 'dm-123',
      })
    ).toBeNull();
  });
});

describe('Discord thread run lock', () => {
  it('親チャンネルのスレッドモードでは新規スレッドごとに同時実行できる', async () => {
    saveSettings({
      discordAutoReplyChannels: { '123': true },
      discordThreadModeChannels: { '123': true },
    });

    const handlers = new Map<string, (message: Message) => Promise<void>>();
    const client = {
      user: { id: '999' },
      on: vi.fn((event: string, handler: (message: Message) => Promise<void>) => {
        handlers.set(event, handler);
        return client;
      }),
      channels: { fetch: vi.fn() },
    } as unknown as Client;

    let releaseFirst!: () => void;
    const firstRun = new Promise<{ result: string; sessionId: string }>((resolve) => {
      releaseFirst = () => resolve({ result: 'first ok', sessionId: 'provider-1' });
    });
    const runStream = vi
      .fn()
      .mockImplementationOnce(async () => firstRun)
      .mockResolvedValue({ result: 'second ok', sessionId: 'provider-2' });
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      discord: {
        allowedUsers: ['*'],
        replyInThread: true,
        streaming: true,
        showThinking: true,
        showButtons: false,
      },
    } as Config;

    registerDiscordMessageHandlers({
      client,
      config,
      agentRunner,
      workdir: tempDir!,
    });

    const firstMessage = createThreadModeMessage({
      messageId: '1001',
      content: 'セッションテスト 001',
      threadId: '9001',
      client,
    });
    const secondMessage = createThreadModeMessage({
      messageId: '1002',
      content: 'セッションテスト 002',
      threadId: '9002',
      client,
    });
    const onMessageCreate = handlers.get(Events.MessageCreate)!;

    const first = onMessageCreate(firstMessage);
    await new Promise((resolve) => setImmediate(resolve));
    await onMessageCreate(secondMessage);
    releaseFirst();
    await first;

    expect(firstMessage.startThread).toHaveBeenCalledTimes(1);
    expect(secondMessage.startThread).toHaveBeenCalledTimes(1);
    expect(runStream).toHaveBeenCalledTimes(2);
    expect(runStream.mock.calls[0][2]).toEqual(
      expect.objectContaining({ channelId: '9001', appSessionId: expect.any(String) })
    );
    expect(runStream.mock.calls[1][2]).toEqual(
      expect.objectContaining({ channelId: '9002', appSessionId: expect.any(String) })
    );
  });

  it('既存スレッド内メッセージではスレッド元をプロンプトに含める', async () => {
    saveSettings({
      discordAutoReplyChannels: { '123': true },
    });

    const handlers = new Map<string, (message: Message) => Promise<void>>();
    const client = {
      user: { id: '999' },
      on: vi.fn((event: string, handler: (message: Message) => Promise<void>) => {
        handlers.set(event, handler);
        return client;
      }),
      channels: { fetch: vi.fn() },
    } as unknown as Client;
    const runStream = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 'provider-1' });
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      discord: {
        allowedUsers: ['*'],
        replyInThread: true,
        streaming: true,
        showThinking: true,
        showButtons: false,
      },
    } as Config;

    registerDiscordMessageHandlers({
      client,
      config,
      agentRunner,
      workdir: tempDir!,
    });

    const message = createExistingThreadMessage({
      messageId: '2001',
      content: '詳しく教えて',
      threadId: 'thread-123',
      parentChannelId: '123',
      starterContent: 'Don’t rewrite your CLI for agents https://developer.microsoft.com/blog/',
      client,
    });
    const onMessageCreate = handlers.get(Events.MessageCreate)!;

    await onMessageCreate(message);

    expect(runStream).toHaveBeenCalledTimes(1);
    const prompt = runStream.mock.calls[0][0] as string;
    expect(prompt).toContain('🧵 スレッド元 (starter#0001):');
    expect(prompt).toContain('Don’t rewrite your CLI for agents');
    expect(prompt).toContain('詳しく教えて');
    expect(runStream.mock.calls[0][2]).toEqual(
      expect.objectContaining({ channelId: 'thread-123', appSessionId: expect.any(String) })
    );
  });
});

function createThreadModeMessage(params: {
  messageId: string;
  content: string;
  threadId: string;
  client: Client;
}): Message {
  const replyMessage = {
    id: `reply-${params.messageId}`,
    edit: vi.fn().mockResolvedValue(undefined),
    channel: { send: vi.fn().mockResolvedValue(undefined) },
  };
  const thread = {
    id: params.threadId,
    name: `thread-${params.messageId}`,
    send: vi.fn().mockResolvedValue(replyMessage),
  };
  const channel = {
    id: '123',
    name: 'dev_xangi',
    isThread: () => false,
    send: vi.fn().mockResolvedValue(undefined),
  };
  const removeReaction = vi.fn().mockResolvedValue(undefined);
  return {
    id: params.messageId,
    content: params.content,
    system: false,
    guild: { id: 'guild-1' },
    channel,
    channelId: channel.id,
    client: params.client,
    author: {
      id: '42',
      bot: false,
      tag: 'user#0001',
      username: 'user',
      displayName: 'user',
    },
    mentions: { has: vi.fn().mockReturnValue(false) },
    attachments: new Map(),
    reference: null,
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(replyMessage),
    startThread: vi.fn().mockResolvedValue(thread),
    reactions: {
      cache: {
        find: vi.fn().mockReturnValue({
          emoji: { name: '👀' },
          users: { remove: removeReaction },
        }),
      },
    },
  } as unknown as Message;
}

function createExistingThreadMessage(params: {
  messageId: string;
  content: string;
  threadId: string;
  parentChannelId: string;
  starterContent: string;
  client: Client;
}): Message {
  const replyMessage = {
    id: `reply-${params.messageId}`,
    edit: vi.fn().mockResolvedValue(undefined),
    channel: { send: vi.fn().mockResolvedValue(undefined) },
  };
  const starterMessage = {
    id: params.threadId,
    content: params.starterContent,
    author: {
      id: '100',
      bot: false,
      tag: 'starter#0001',
      username: 'starter',
      displayName: 'starter',
    },
    attachments: new Map(),
  };
  const thread = {
    id: params.threadId,
    name: '詳しく教えて',
    parentId: params.parentChannelId,
    isThread: () => true,
    fetchStarterMessage: vi.fn().mockResolvedValue(starterMessage),
    send: vi.fn().mockResolvedValue(replyMessage),
  };
  const removeReaction = vi.fn().mockResolvedValue(undefined);
  return {
    id: params.messageId,
    content: params.content,
    system: false,
    guild: { id: 'guild-1' },
    channel: thread,
    channelId: thread.id,
    client: params.client,
    author: {
      id: '42',
      bot: false,
      tag: 'user#0001',
      username: 'user',
      displayName: 'user',
    },
    mentions: { has: vi.fn().mockReturnValue(false) },
    attachments: new Map(),
    reference: null,
    react: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(replyMessage),
    reactions: {
      cache: {
        find: vi.fn().mockReturnValue({
          emoji: { name: '👀' },
          users: { remove: removeReaction },
        }),
      },
    },
  } as unknown as Message;
}
