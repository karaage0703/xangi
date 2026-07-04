import { describe, it, expect } from 'vitest';
import {
  buildDiscordChannelContextLine,
  resolveConversationChannelId,
} from '../src/discord/thread-context.js';

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
