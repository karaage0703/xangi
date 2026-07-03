import { describe, it, expect } from 'vitest';
import { resolveConversationChannelId } from '../src/discord/thread-context.js';

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
