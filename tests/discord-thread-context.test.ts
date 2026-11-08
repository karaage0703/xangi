import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Events } from 'discord.js';
import type { Client, Message } from 'discord.js';
import type { AgentRunner } from '../src/agent-runner.js';
import type { Config } from '../src/config.js';
import {
  registerDiscordMessageHandlers,
  shouldApplyDiscordAiSessionTitle,
  shouldStartDiscordAiSessionTitle,
} from '../src/discord/message-handler.js';
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
  getSessionEntry,
  updateSessionTitle,
  initSessions,
  setProviderSessionId,
} from '../src/sessions.js';
import { logPrompt, readSessionMessages } from '../src/transcript-logger.js';
import { DiscordTurnCoordinator } from '../src/discord/turn-coordinator.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

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

describe('Discord AI session title mode', () => {
  it('AI命名をxangiが新規作成したスレッドの最初のturnだけに制限できる', () => {
    expect(
      shouldStartDiscordAiSessionTitle({ mode: 'ai', aiOnce: true, createdThreadName: '最初の質問' })
    ).toBe(true);
    expect(
      shouldStartDiscordAiSessionTitle({ mode: 'ai', aiOnce: true, createdThreadName: null })
    ).toBe(false);
  });

  it('生成待ちの間に /new された旧セッションのタイトルを適用しない', () => {
    expect(
      shouldApplyDiscordAiSessionTitle({
        aiOnce: true,
        appSessionId: 'old-session',
        activeSessionId: 'new-session',
        createdThreadName: '最初の質問',
        currentThreadName: '最初の質問',
      })
    ).toBe(false);
  });

  it('生成待ちの間に手動変更されたスレッド名を上書きしない', () => {
    expect(
      shouldApplyDiscordAiSessionTitle({
        aiOnce: true,
        appSessionId: 'session-1',
        activeSessionId: 'session-1',
        createdThreadName: '最初の質問',
        currentThreadName: '手動タイトル',
      })
    ).toBe(false);
    expect(
      shouldApplyDiscordAiSessionTitle({
        aiOnce: true,
        appSessionId: 'session-1',
        activeSessionId: 'session-1',
        createdThreadName: '最初の質問',
        currentThreadName: '最初の質問',
      })
    ).toBe(true);
  });

  it('制限を使わないaiモードは既存スレッドでも従来どおり対象にする', () => {
    expect(
      shouldStartDiscordAiSessionTitle({ mode: 'ai', aiOnce: false, createdThreadName: null })
    ).toBe(true);
    expect(
      shouldStartDiscordAiSessionTitle({ mode: 'prefix', aiOnce: true, createdThreadName: '最初の質問' })
    ).toBe(false);
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
  it.each(['queued', 'running'])('scheduler taskが%sなら通常メッセージをbusy拒否する', async (state) => {
    saveSettings({ discordAutoReplyChannels: { '123': true } });
    const handlers = new Map<string, (message: Message) => Promise<void>>();
    const client = {
      user: { id: '999' },
      on: vi.fn((event: string, handler: (message: Message) => Promise<void>) => {
        handlers.set(event, handler);
        return client;
      }),
      channels: { fetch: vi.fn() },
    } as unknown as Client;
    const runStream = vi.fn();
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      discord: { allowedUsers: ['*'], streaming: true, showThinking: true, showButtons: false },
    } as Config;
    const coordinator = new DiscordTurnCoordinator();
    let releaseBlocker!: () => void;
    const blocker = coordinator.enqueue(
      'busy-thread',
      () => new Promise<void>((resolve) => (releaseBlocker = resolve))
    );
    let queued: Promise<void> | undefined;
    if (state === 'queued') queued = coordinator.enqueue('busy-thread', async () => undefined);
    registerDiscordMessageHandlers({
      client,
      config,
      agentRunner,
      workdir: tempDir!,
      turnCoordinator: coordinator,
    } as Parameters<typeof registerDiscordMessageHandlers>[0]);
    const message = createExistingThreadMessage({
      messageId: `scheduler-${state}`,
      content: '通常メッセージ',
      threadId: 'busy-thread',
      parentChannelId: '123',
      starterContent: '共有busyテスト',
      client,
    });

    await handlers.get(Events.MessageCreate)!(message);

    expect(runStream).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith({
      content: expect.stringContaining('完了後に送信'),
      components: expect.any(Array),
      allowedMentions: { parse: [], repliedUser: false },
    });
    releaseBlocker();
    await blocker;
    await queued;
  });

  it('処理中の複数投稿をボタンで予約し、キャンセルした投稿を除いて完了後に実行する', async () => {
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
        content: expect.stringContaining('完了後に送信'),
        components: expect.any(Array),
        allowedMentions: { parse: [], repliedUser: false },
      });
    }

    const click = async (message: Message, action: string) => {
      const replyMessage = await (message.reply as ReturnType<typeof vi.fn>).mock.results[0].value;
      const interaction = {
        isButton: () => true,
        customId: `xangi_pending:${action}`,
        user: { id: '42' },
        channelId: 'busy-thread',
        message: replyMessage,
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      };
      await handlers.get(Events.InteractionCreate)!(interaction as unknown as Message);
    };
    await click(secondMessage, 'send');
    await click(thirdMessage, 'send');
    await click(secondMessage, 'cancel');
    expect(runStream).toHaveBeenCalledTimes(1);
    releaseFirst();
    await first;
    await vi.waitFor(() => expect(runStream).toHaveBeenCalledTimes(2));
    expect(runStream.mock.calls[1][0]).toContain('メンションありの3件目');
    expect(runStream.mock.calls[1][0]).not.toContain('メンションなしの2件目');
    await vi.waitFor(() => expect(thirdMessage.reply).toHaveBeenCalledTimes(2));
    // Wait for completion of the queued turn before sending a fresh normal turn.
    const thirdReply = await (thirdMessage.reply as ReturnType<typeof vi.fn>).mock.results[0].value;
    await vi.waitFor(() =>
      expect(thirdReply.edit).toHaveBeenLastCalledWith({
        content: '✅ 予約した投稿の処理が終了しました。',
        components: [],
      })
    );
    await onMessageCreate(afterCompletionMessage);
    expect(runStream).toHaveBeenCalledTimes(3);
  });

  it('activeな会話スレッドではautoreply無効でもメンションなしの後続投稿を処理する', async () => {
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

    expect(nonRequestMessage.reply).toHaveBeenCalledWith({
      content: expect.stringContaining('完了後に送信'),
      components: expect.any(Array),
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(runStream).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
  });

  it('activeなsessionがないスレッドではautoreply無効かつメンションなしの投稿を無視する', async () => {
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
    const runStream = vi.fn();
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
      messageId: 'unrelated-1',
      content: 'メンションなしの会話',
      threadId: 'unrelated-thread',
      parentChannelId: '123',
      starterContent: '無関係なスレッド',
      client,
    });

    await handlers.get(Events.MessageCreate)!(message);

    expect(message.reply).not.toHaveBeenCalled();
    expect(runStream).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(runStream).toHaveBeenCalledTimes(1));
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

  it('既存スレッドで作成した内部セッションへDiscordスレッド名を引き継ぐ', async () => {
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
      sessionTitle: { mode: 'ai' },
      discord: {
        allowedUsers: ['*'],
        replyInThread: true,
        streaming: true,
        showThinking: true,
        showButtons: false,
        sessionTitleAiOnce: true,
      },
    } as Config;

    registerDiscordMessageHandlers({
      client,
      config,
      agentRunner,
      workdir: tempDir!,
    });

    const message = createExistingThreadMessage({
      messageId: 'existing-thread-title-1',
      content: '内部セッションを作り直す発言',
      threadId: 'thread-title-123',
      parentChannelId: '123',
      starterContent: 'スレッド開始メッセージ',
      client,
    });

    await handlers.get(Events.MessageCreate)!(message);

    const appSessionId = getActiveSessionId('thread-title-123');
    expect(appSessionId).toBeDefined();
    expect(getSessionEntry(appSessionId!)?.title).toBe('詳しく教えて');
    expect(runStream).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('本文非表示の経路でも準備完了時にタイトルを生成する (streaming=%s)', async (streaming) => {
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
    const runStream = vi.fn(async (_prompt, callbacks) => { callbacks.onBackendReady?.(); return {result:'ok',sessionId:'provider-1'}; });
    const run = vi.fn().mockResolvedValue({result:'更新したタイトル',sessionId:''});
    const agentRunner = {
      runStream,
      run,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      sessionTitle: { mode: 'ai' },
      discord: {
        allowedUsers: ['*'],
        replyInThread: true,
        streaming,
        showThinking: false,
        showButtons: false,
        sessionTitleAiOnce: false,
      },
    } as Config;

    registerDiscordMessageHandlers({
      client,
      config,
      agentRunner,
      workdir: tempDir!,
    });

    const message = createExistingThreadMessage({
      messageId: 'existing-thread-title-1',
      content: '内部セッションを作り直す発言',
      threadId: 'thread-title-123',
      parentChannelId: '123',
      starterContent: 'スレッド開始メッセージ',
      client,
    });

    const rename=vi.fn().mockResolvedValue(undefined);
    (message.channel as any).setName=rename;
    await handlers.get(Events.MessageCreate)!(message);

    const appSessionId = getActiveSessionId('thread-title-123');
    expect(appSessionId).toBeDefined();
    await vi.waitFor(()=>expect(getSessionEntry(appSessionId!)?.title).toBe('更新したタイトル'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('更新したタイトル');
    expect(runStream).toHaveBeenCalledTimes(1);
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
  it.each(['success', 'manual-thread', 'manual-session', 'new-session', 'fetch-race', 'rename-error', 'existing', 'second-turn', 'unrestricted-channel'] as const)(
    'prepares a shared-turn AI title while protecting Discord naming (%s)', async (scenario) => {
      const thread = {
        id: 'shared-title-thread', name: '最初の質問',
        isThread: () => scenario !== 'unrestricted-channel',
        fetch: vi.fn(async () => ({ name: thread.name })),
        setName: vi.fn().mockResolvedValue(undefined),
      };
      const client = {
        user: { id: '999' }, on: vi.fn().mockReturnThis(),
        channels: { fetch: vi.fn(async (id) => id === 'parent' ? {
          type: 0, threads: { create: vi.fn().mockResolvedValue(thread) },
        } : thread) },
      } as unknown as Client;
      const bridge = registerDiscordMessageHandlers({
        client, agentRunner: {} as AgentRunner, workdir: tempDir!,
        config: {
          agent: { config: { workdir: tempDir } },
          sessionTitle: { mode: 'ai' }, discord: { sessionTitleAiOnce: scenario !== 'unrestricted-channel' },
        } as Config,
      });
      const id = scenario === 'existing'
        ? createSession(thread.id, { platform: 'discord' })
        : (await bridge.createSession!('parent', thread.name)).sessionId;
      const input = { appSessionId: id, prefixTitle: '最初の質問' };
      const target = await bridge.prepareSessionTitle!(input);
      if (scenario === 'existing') {
        expect(target).toBeUndefined();
        expect(getSessionEntry(id)?.title).toBe(thread.name);
        return;
      }
      expect(target).toBeDefined();
      if (scenario === 'second-turn') {
        expect(await bridge.prepareSessionTitle!(input)).toBeUndefined();
        return;
      }
      updateSessionTitle(id, input.prefixTitle);
      if (scenario === 'manual-thread') thread.name = '手動スレッド名';
      if (scenario === 'manual-session') updateSessionTitle(id, '手動タイトル');
      if (scenario === 'new-session') createSession(thread.id, { platform: 'discord' });
      if (scenario === 'fetch-race') thread.fetch.mockImplementation(async () => {
        updateSessionTitle(id, '取得中の手動タイトル');
        return { name: thread.name };
      });
      if (scenario === 'rename-error') {
        thread.setName.mockRejectedValueOnce(new Error('rename unavailable'));
        await expect(target!.onTitle('AIタイトル')).rejects.toThrow('rename unavailable');
        expect(getSessionEntry(id)?.title).toBe(input.prefixTitle);
        return;
      }
      await target!.onTitle('AIタイトル');
      if (scenario === 'success' || scenario === 'unrestricted-channel') {
        if (scenario === 'success') expect(thread.setName).toHaveBeenCalledWith('AIタイトル');
        else expect(thread.setName).not.toHaveBeenCalled();
        expect(getSessionEntry(id)?.title).toBe('AIタイトル');
      } else {
        expect(thread.setName).not.toHaveBeenCalled();
        expect(getSessionEntry(id)?.title).toBe(
          scenario === 'manual-session' ? '手動タイトル' : scenario === 'fetch-race' ? '取得中の手動タイトル' : input.prefixTitle
        );
      }
    }
  );
  it.each(['画像を確認して', '', '長文'.repeat(2500)])(
    '完了したWeb入力と画像を回答より先に配送し、発言者を区別する',
    async (message) => {
      const appSessionId = createSession('delivery-thread', { platform: 'discord' });
      const send = vi.fn().mockImplementation(async () => ({ id: `posted-${send.mock.calls.length}` }));
      const client = {
        on: vi.fn().mockReturnThis(),
        channels: { fetch: vi.fn().mockResolvedValue({ send }) },
      } as unknown as Client;
      const bridge = registerDiscordMessageHandlers({ client, config: {} as Config } as Parameters<typeof registerDiscordMessageHandlers>[0]);
      const ids = await bridge.deliverResult!({
        appSessionId,
        text: '確認しました',
        attachments: ['/tmp/result.png'],
        webInput: { message, attachments: ['/tmp/user.png'] },
        assistantName: 'ボルト',
      });
      const payloads = send.mock.calls.map(([payload]) => payload);
      expect(payloads[0].content).toContain('👤 ユーザー（Web）');
      expect(payloads.filter((p) => p.content?.startsWith('👤'))).toHaveLength(1);
      expect(payloads.slice(0, -2).map((p) => p.content).join('')).toContain(message);
      expect(payloads.every((p) => !p.content || p.content.length <= 2000)).toBe(true);
      expect(payloads.slice(0, -2).flatMap((p) => p.files || [])).toEqual([{ attachment: '/tmp/user.png' }]);
      expect(payloads.at(-2)).toMatchObject({ content: '🤖 AI：ボルト\n確認しました' });
      expect(payloads.at(-1)).toMatchObject({ files: [{ attachment: '/tmp/result.png' }] });
      expect(payloads.every((p) => p.allowedMentions?.parse?.length === 0)).toBe(true);
      // The first returned ID still links the assistant transcript to its answer.
      expect(ids[0]).toBe(`posted-${payloads.length - 1}`);
      expect(new Set(ids).size).toBe(payloads.length);
    }
  );

  it('Web入力なしの従来の結果配送は本文を変更しない', async () => {
    const appSessionId = createSession('legacy-delivery', { platform: 'discord' });
    const send = vi.fn().mockResolvedValue({ id: 'result' });
    const client = { on: vi.fn(), channels: { fetch: vi.fn().mockResolvedValue({ send }) } } as unknown as Client;
    const bridge = registerDiscordMessageHandlers({ client, config: {} as Config } as Parameters<typeof registerDiscordMessageHandlers>[0]);
    expect(await bridge.deliverResult!({ appSessionId, text: '既存の結果', attachments: [] })).toEqual(['result']);
    expect(send).toHaveBeenCalledExactlyOnceWith({ content: '既存の結果', allowedMentions: { parse: [] } });
  });

  it.each(['queued', 'running'])('scheduler taskが%sならWeb継続をbusy拒否する', async (state) => {
    const threadId = 'remote-busy-thread';
    const appSessionId = createSession(threadId, { platform: 'discord' });
    const thread = {
      id: threadId,
      isThread: () => true,
      parentId: '123',
      send: vi.fn(),
    };
    const client = {
      user: { id: '999' },
      on: vi.fn().mockReturnThis(),
      channels: { fetch: vi.fn().mockResolvedValue(thread) },
    } as unknown as Client;
    const runStream = vi.fn();
    const agentRunner = {
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: false, workdir: tempDir } },
      discord: { allowedUsers: ['*'], streaming: true, showThinking: true, showButtons: false },
    } as Config;
    const coordinator = new DiscordTurnCoordinator();
    let releaseBlocker!: () => void;
    const blocker = coordinator.enqueue(
      threadId,
      () => new Promise<void>((resolve) => (releaseBlocker = resolve))
    );
    let queued: Promise<void> | undefined;
    if (state === 'queued') queued = coordinator.enqueue(threadId, async () => undefined);
    const bridge = registerDiscordMessageHandlers({
      client,
      config,
      agentRunner,
      workdir: tempDir!,
      turnCoordinator: coordinator,
    } as Parameters<typeof registerDiscordMessageHandlers>[0]);

    await expect(
      bridge.continueSession({ appSessionId, message: '続きをお願いします' })
    ).rejects.toThrow('このDiscordセッションは処理中です');
    expect(runStream).not.toHaveBeenCalled();
    expect(thread.send).not.toHaveBeenCalled();

    releaseBlocker();
    await blocker;
    await queued;
  });

  it.each([false, true])('Web入力と添付=%sを元スレッドへ表示し同じappSessionIdで処理する', async (withAttachment) => {
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
      ...(withAttachment ? { attachments: ['/tmp/web-uploads/sample.txt'] } : {}),
    });

    expect(result).toEqual({ response: 'Discordで回答' });
    expect(thread.send).toHaveBeenCalledWith({
      content: '🌐 Webから: 続きをお願いします',
      ...(withAttachment ? { files: [{ attachment: '/tmp/web-uploads/sample.txt' }] } : {}),
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
    if (withAttachment) expect(runStream.mock.calls[0][0]).toContain('[Attachment] /tmp/web-uploads/sample.txt');
    expect(getActiveSessionId(threadId)).toBe(appSessionId);
  });
  it('値の無いスレッドの会話はWebからの発言でも親チャンネルに結び付く', async () => {
    const appSessionId = createSession('T1', { platform: 'discord' });
    setProviderSessionId(appSessionId, 'P1', 'claude-code', 'claude-opus-5-5');
    const replyMessage = {
      id: 'remote-reply-1',
      edit: vi.fn().mockResolvedValue(undefined),
      channel: { send: vi.fn().mockResolvedValue(undefined) },
    };
    const mirroredMessage = {
      id: 'remote-source-1',
      content: '🌐 Webから: 確認して',
      createdTimestamp: Date.now(),
      channelId: 'T1',
      client: null as unknown as Client,
      author: { id: '999', bot: true, username: 'xangi', displayName: 'xangi' },
      channel: null as unknown,
      reply: vi.fn().mockResolvedValue(replyMessage),
      react: vi.fn().mockResolvedValue(undefined),
      reactions: { cache: { find: vi.fn().mockReturnValue(undefined) } },
    } as unknown as Message;
    const thread = {
      id: 'T1',
      name: '既存スレッド',
      parentId: 'C1',
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
    const agentRunner = {
      runStream: vi.fn().mockResolvedValue({ result: '確認しました', sessionId: 'P1' }),
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
    const workspaceRegistry = await WorkspaceRegistry.open({
      dataDir: join(tempDir!, 'state'),
      defaultWorkspacePath: tempDir!,
    });

    const bridge = registerDiscordMessageHandlers({
      client,
      config,
      agentRunner,
      workdir: tempDir!,
      workspaceRegistry,
    });
    await bridge.continueSession({ appSessionId, message: '確認して' });

    expect(getSessionEntry(appSessionId)?.agentBindingKey).toBe('C1');
    expect(getSessionEntry(appSessionId)?.agent?.providerSessionId).toBe('P1');
  });
  it.each([false, true])('AI-names a Web-created thread and preserves manual rename=%s', async (manualRename) => {
    const threadId = 'remote-thread-123';
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
      name: '続きをお願いします',
      fetch: vi.fn().mockImplementation(async () => ({ name: manualRename ? '手動の名前' : '続きをお願いします' })),
      setName: vi.fn().mockResolvedValue(undefined),
      parentId: 'parent-123',
      parent: { name: 'dev_xangi' },
      isThread: () => true,
      send: vi.fn().mockResolvedValue(mirroredMessage),
    };
    const client = {
      user: { id: '999' },
      on: vi.fn().mockReturnThis(),
      channels: { fetch: vi.fn().mockImplementation(async (id) => id === 'parent-123' ? { type: 0, threads: { create: vi.fn().mockResolvedValue(thread) } } : thread) },
    } as unknown as Client;
    (mirroredMessage as unknown as { client: Client; channel: unknown }).client = client;
    (mirroredMessage as unknown as { client: Client; channel: unknown }).channel = thread;

    const runStream = vi
      .fn()
      .mockImplementation(async (_prompt, callbacks) => { callbacks.onBackendReady?.(); return { result: 'Discordで回答', sessionId: 'provider-remote-1' }; });
    const agentRunner = {
      run: vi.fn().mockResolvedValue({ result: 'AIで付けた名前', sessionId: 'title' }),
      runStream,
      getTimeoutState: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRunner;
    const config = {
      agent: { backend: 'claude-code', config: { skipPermissions: false, workdir: tempDir } },
      sessionTitle: { mode: 'ai' },
      discord: {
        sessionTitleAiOnce: true,
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
    const { sessionId: appSessionId } = await bridge.createSession!('parent-123', '続きをお願いします');
    expect(getSessionEntry(appSessionId)?.title).toBeFalsy();
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
    await vi.waitFor(() => expect(thread.fetch).toHaveBeenCalled());
    if (manualRename) {
      expect(thread.setName).not.toHaveBeenCalled();
      expect(getSessionEntry(appSessionId)?.title).not.toBe('AIで付けた名前');
    } else {
      await vi.waitFor(() => expect(thread.setName).toHaveBeenCalledWith('AIで付けた名前'));
      expect(getSessionEntry(appSessionId)?.title).toBe('AIで付けた名前');
    }
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
