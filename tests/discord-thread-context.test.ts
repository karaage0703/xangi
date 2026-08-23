import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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
  getDiscordChannelTopic,
  resolveConversationChannelId,
  resolveDiscordSettingsChannelId,
} from '../src/discord/thread-context.js';
import { clearSettingsCache, initSettings, saveSettings } from '../src/settings.js';
import {
  clearSessions,
  createSession,
  createWebSession,
  getActiveSessionId,
  initSessions,
} from '../src/sessions.js';
import { logPrompt, readSessionMessages } from '../src/transcript-logger.js';

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

describe('resolveDiscordSettingsChannelId', () => {
  it('既存スレッドでは親チャンネルIDを設定解決に使う', () => {
    expect(
      resolveDiscordSettingsChannelId('thread-456', {
        isThread: () => true,
        parentId: 'parent-123',
      })
    ).toBe('parent-123');
  });

  it('通常チャンネルでは受信チャンネルIDを設定解決に使う', () => {
    expect(
      resolveDiscordSettingsChannelId('channel-123', {
        isThread: () => false,
        parentId: null,
      })
    ).toBe('channel-123');
  });
});

describe('getDiscordChannelTopic', () => {
  it('通常チャンネルではチャンネル topic を使う', () => {
    expect(getDiscordChannelTopic({ topic: 'parent rules' })).toBe('parent rules');
  });

  it('スレッドでは親チャンネル topic を使う', () => {
    expect(
      getDiscordChannelTopic({
        isThread: () => true,
        parent: { topic: 'thread inherited rules' },
      })
    ).toBe('thread inherited rules');
  });
});

describe('buildDiscordChannelContextLine', () => {
  it('スレッドでは親チャンネル名・IDとスレッド名・IDを両方表示する', () => {
    expect(
      buildDiscordChannelContextLine({
        channelName: 'dev_xangi',
        conversationChannelId: 'thread-456',
        settingsChannelId: 'parent-123',
        threadName: 'thread title',
        parentChannelName: 'dev_xangi',
      })
    ).toBe('[チャンネル: #dev_xangi (ID: parent-123) / thread: thread title (ID: thread-456)]');
  });

  it('親チャンネル名が取得できなくても親IDを表示する', () => {
    expect(
      buildDiscordChannelContextLine({
        channelName: 'thread title',
        conversationChannelId: 'thread-456',
        settingsChannelId: 'parent-123',
        threadName: 'thread title',
        parentChannelName: null,
      })
    ).toBe('[チャンネル: 親チャンネル (ID: parent-123) / thread: thread title (ID: thread-456)]');
  });

  it('通常チャンネルでは従来のチャンネル表示を使う', () => {
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

describe('Discord streaming attachments', () => {
  it('ストリーミング応答の構造化添付をDiscordへ送信する', async () => {
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
    const attachmentPath = join(tempDir!, 'generated-audio.mp3');
    writeFileSync(attachmentPath, 'audio');
    const runStream = vi.fn().mockResolvedValue({
      result: '生成した音声を送ります',
      sessionId: 'provider-1',
      attachments: [attachmentPath],
    });
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
      messageId: 'attachment-1',
      content: '音声を作って',
      threadId: 'thread-attachment',
      parentChannelId: '123',
      starterContent: '音声生成スレッド',
      client,
    });

    await handlers.get(Events.MessageCreate)!(message);

    expect(
      (message.channel as unknown as { send: ReturnType<typeof vi.fn> }).send
    ).toHaveBeenCalledWith({
      files: [{ attachment: attachmentPath }],
    });
  });
});

describe('Discord thread run lock', () => {
  it('bot宛ての2件目と3件目へ処理中を返し、先行処理の完了後だけ次を実行する', async () => {
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

    let releaseFirst!: () => void;
    const firstRun = new Promise<{ result: string; sessionId: string }>((resolve) => {
      releaseFirst = () => resolve({ result: 'first ok', sessionId: 'provider-1' });
    });
    const runStream = vi
      .fn()
      .mockImplementationOnce(async () => firstRun)
      .mockResolvedValue({ result: 'next ok', sessionId: 'provider-2' });
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

    registerDiscordMessageHandlers({ client, config, agentRunner, workdir: tempDir! });
    const onMessageCreate = handlers.get(Events.MessageCreate)!;
    const firstMessage = createExistingThreadMessage({
      messageId: 'busy-1',
      content: '最初の依頼',
      threadId: 'busy-thread',
      parentChannelId: '123',
      starterContent: '排他テスト',
      client,
    });
    const secondMessage = createExistingThreadMessage({
      messageId: 'busy-2',
      content: 'メンションなしの2件目',
      threadId: 'busy-thread',
      parentChannelId: '123',
      starterContent: '排他テスト',
      client,
    });
    const thirdMessage = createExistingThreadMessage({
      messageId: 'busy-3',
      content: '<@999> メンションありの3件目',
      threadId: 'busy-thread',
      parentChannelId: '123',
      starterContent: '排他テスト',
      mentioned: true,
      client,
    });
    const afterCompletionMessage = createExistingThreadMessage({
      messageId: 'busy-4',
      content: '完了後の依頼',
      threadId: 'busy-thread',
      parentChannelId: '123',
      starterContent: '排他テスト',
      client,
    });

    const first = onMessageCreate(firstMessage);
    await vi.waitFor(() => expect(runStream).toHaveBeenCalledTimes(1));
    await onMessageCreate(secondMessage);
    await onMessageCreate(thirdMessage);

    expect(runStream).toHaveBeenCalledTimes(1);
    for (const busyMessage of [secondMessage, thirdMessage]) {
      expect(busyMessage.reply).toHaveBeenCalledWith({
        content: '⏳ 現在処理中です。完了後にもう一度送ってください。',
        allowedMentions: { parse: [], repliedUser: false },
      });
    }

    releaseFirst();
    await first;
    await onMessageCreate(afterCompletionMessage);
    expect(runStream).toHaveBeenCalledTimes(2);
  });

  it('autoreply無効かつメンションなしの投稿には処理中を表示しない', async () => {
    saveSettings({
      discordAutoReplyChannels: { '123': false },
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
    const runStream = vi.fn().mockImplementationOnce(async () => firstRun);
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

    registerDiscordMessageHandlers({ client, config, agentRunner, workdir: tempDir! });
    const onMessageCreate = handlers.get(Events.MessageCreate)!;
    const firstMessage = createExistingThreadMessage({
      messageId: 'mention-1',
      content: '<@999> 最初の依頼',
      threadId: 'mention-thread',
      parentChannelId: '123',
      starterContent: '依頼判定テスト',
      mentioned: true,
      client,
    });
    const nonRequestMessage = createExistingThreadMessage({
      messageId: 'mention-2',
      content: 'メンションなしの会話',
      threadId: 'mention-thread',
      parentChannelId: '123',
      starterContent: '依頼判定テスト',
      client,
    });

    const first = onMessageCreate(firstMessage);
    await vi.waitFor(() => expect(runStream).toHaveBeenCalledTimes(1));
    await onMessageCreate(nonRequestMessage);

    expect(nonRequestMessage.reply).not.toHaveBeenCalled();
    expect(runStream).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
  });

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
    expect(runStream.mock.calls[0][0]).toContain(
      '[チャンネル: #dev_xangi (ID: 123) / thread: thread-1001 (ID: 9001)]'
    );
    expect(runStream.mock.calls[1][0]).toContain(
      '[チャンネル: #dev_xangi (ID: 123) / thread: thread-1002 (ID: 9002)]'
    );
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
    expect(prompt).toContain(
      '[チャンネル: #dev_pr_check (ID: 123) / thread: 詳しく教えて (ID: thread-123)]'
    );
    expect(prompt).toContain('🧵 スレッド元 (starter#0001):');
    expect(prompt).toContain('Don’t rewrite your CLI for agents');
    expect(prompt).toContain('詳しく教えて');
    expect(runStream.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        channelId: 'thread-123',
        settingsChannelId: '123',
        appSessionId: expect.any(String),
      })
    );
  });

  it('既存スレッド内メッセージでは親チャンネル topic をプロンプトに含める', async () => {
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
      messageId: '2002',
      content: 'このルールで返して',
      threadId: 'thread-456',
      parentChannelId: '123',
      parentTopic: 'このチャンネルでは簡潔に答える',
      starterContent: 'thread starter',
      client,
    });
    const onMessageCreate = handlers.get(Events.MessageCreate)!;

    await onMessageCreate(message);

    const prompt = runStream.mock.calls[0][0] as string;
    expect(prompt).toContain('[チャンネルルール（必ず従うこと）]');
    expect(prompt).toContain('このチャンネルでは簡潔に答える');
  });

  it('Discordへ貼られたWeb会話リンクの履歴を引用する', async () => {
    saveSettings({ discordAutoReplyChannels: { '123': true } });
    const webSessionId = createWebSession({ title: 'Discordから参照' });
    logPrompt(tempDir!, webSessionId, 'Web UIで決めた内容');
    const linkedMessageId = readSessionMessages(tempDir!, webSessionId)[0].id;
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
    registerDiscordMessageHandlers({ client, config, agentRunner, workdir: tempDir! });
    const message = createExistingThreadMessage({
      messageId: '2004',
      content: `これを参照 http://xangi.test/chat/${webSessionId}#message-${linkedMessageId}`,
      threadId: 'thread-reference',
      parentChannelId: '123',
      starterContent: 'thread starter',
      client,
    });

    await handlers.get(Events.MessageCreate)!(message);

    const prompt = runStream.mock.calls[0][0] as string;
    expect(prompt).toContain('<referenced-message platform="web"');
    expect(prompt).toContain('Web UIで決めた内容');
  });

  it('既存スレッド内メッセージでは親チャンネルの完了通知設定を使う', async () => {
    saveSettings({
      discordAutoReplyChannels: { '123': true },
      discordCompletionNotifyChannels: { '123': 'off' },
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
        completionNotifyMode: 'message',
        completionNotifyAfterMs: 0,
      },
    } as Config;

    registerDiscordMessageHandlers({
      client,
      config,
      agentRunner,
      workdir: tempDir!,
    });

    const message = createExistingThreadMessage({
      messageId: '2003',
      content: '通知しないで',
      threadId: 'thread-789',
      parentChannelId: '123',
      starterContent: 'thread starter',
      client,
    });
    const onMessageCreate = handlers.get(Events.MessageCreate)!;

    await onMessageCreate(message);

    expect(
      (message.channel as unknown as { send: ReturnType<typeof vi.fn> }).send
    ).not.toHaveBeenCalled();
  });
});

describe('Discord remote input bridge', () => {
  it('Web入力を元スレッドへ表示し、指定されたappSessionIdで処理する', async () => {
    const threadId = 'remote-thread-123';
    const appSessionId = createSession(threadId, { platform: 'discord' });
    const replyMessage = {
      id: 'remote-reply-1',
      edit: vi.fn().mockResolvedValue(undefined),
      channel: { send: vi.fn().mockResolvedValue(undefined) },
    };
    const mirroredMessage = {
      id: 'remote-source-1',
      content: '🌐 Webから: 続きをお願いします',
      createdTimestamp: Date.now(),
      channelId: threadId,
      client: null as unknown as Client,
      author: {
        id: '999',
        bot: true,
        username: 'xangi',
        displayName: 'xangi',
      },
      channel: null as unknown,
      reply: vi.fn().mockResolvedValue(replyMessage),
      react: vi.fn().mockResolvedValue(undefined),
      reactions: {
        cache: {
          find: vi.fn().mockReturnValue({
            emoji: { name: '👀' },
            users: { remove: vi.fn().mockResolvedValue(undefined) },
          }),
        },
      },
    } as unknown as Message;
    const thread = {
      id: threadId,
      name: '既存スレッド',
      parentId: 'parent-123',
      parent: { name: 'dev_xangi' },
      isThread: () => true,
      send: vi.fn().mockResolvedValue(mirroredMessage),
    };
    const client = {
      user: { id: '999' },
      on: vi.fn().mockReturnThis(),
      channels: { fetch: vi.fn().mockResolvedValue(thread) },
    } as unknown as Client;
    (mirroredMessage as unknown as { client: Client; channel: unknown }).client = client;
    (mirroredMessage as unknown as { client: Client; channel: unknown }).channel = thread;

    const runStream = vi
      .fn()
      .mockResolvedValue({ result: 'Discordで回答', sessionId: 'provider-remote-1' });
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { backend: 'claude-code', config: { skipPermissions: false, workdir: tempDir } },
      discord: {
        allowedUsers: ['*'],
        streaming: true,
        showThinking: true,
        showButtons: false,
        completionNotifyAfterMs: 60_000,
      },
    } as Config;

    const bridge = registerDiscordMessageHandlers({
      client,
      config,
      agentRunner,
      workdir: tempDir!,
    });
    const result = await bridge.continueSession({
      appSessionId,
      message: '続きをお願いします',
    });

    expect(result).toEqual({ response: 'Discordで回答' });
    expect(thread.send).toHaveBeenCalledWith({
      content: '🌐 Webから: 続きをお願いします',
      allowedMentions: { parse: [] },
    });
    expect(runStream).toHaveBeenCalledWith(
      expect.stringContaining('[発言者: Web (ID: web)]'),
      expect.any(Object),
      expect.objectContaining({
        channelId: threadId,
        appSessionId,
      })
    );
    expect(getActiveSessionId(threadId)).toBe(appSessionId);
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
  parentTopic?: string;
  starterContent: string;
  mentioned?: boolean;
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
    parent: { name: 'dev_pr_check', topic: params.parentTopic ?? null },
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
    mentions: { has: vi.fn().mockReturnValue(params.mentioned ?? false) },
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
