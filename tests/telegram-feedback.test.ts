import { describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import {
  createTelegramReactionTracker,
  parseTelegramReaction,
  sendTelegramControlReply,
} from '../src/telegram-feedback.js';

describe('Telegram group feedback', () => {
  it('validates configured emoji and allows an empty acknowledgement to disable it', () => {
    const warn = vi.fn();
    expect(parseTelegramReaction(undefined, '👀', warn)).toBe('👀');
    expect(parseTelegramReaction('', '👀', warn)).toBeUndefined();
    expect(parseTelegramReaction('✅', '👀', warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('acknowledges once, then replaces or removes the reaction at completion', async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(true);
    const api = { setMessageReaction } as unknown as Pick<Api, 'setMessageReaction'>;
    const success = createTelegramReactionTracker(api, -100, 7, '👀', '🎉', vi.fn());
    await success.finish(true);
    await success.finish(true);
    expect(setMessageReaction.mock.calls).toEqual([
      [-100, 7, [{ type: 'emoji', emoji: '👀' }]],
      [-100, 7, [{ type: 'emoji', emoji: '🎉' }]],
    ]);

    const failure = createTelegramReactionTracker(api, -100, 8, '👀', undefined, vi.fn());
    await failure.finish(false);
    expect(setMessageReaction.mock.calls.slice(2)).toEqual([
      [-100, 8, [{ type: 'emoji', emoji: '👀' }]],
      [-100, 8, []],
    ]);

    const disabled = createTelegramReactionTracker(api, -100, 9, undefined, undefined, vi.fn());
    await disabled.finish(true);
    expect(setMessageReaction).toHaveBeenCalledTimes(4);
  });

  it('does not interrupt the agent when reactions fail', async () => {
    const warn = vi.fn();
    const setMessageReaction = vi.fn().mockRejectedValue(new Error('not allowed'));
    const api = { setMessageReaction } as unknown as Pick<Api, 'setMessageReaction'>;
    const tracker = createTelegramReactionTracker(api, -100, 1, '👀', '🎉', warn);
    await expect(tracker.finish(true)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('Telegram ephemeral control replies', () => {
  const send = async (sendMessage: ReturnType<typeof vi.fn>, chatType: string, enabled = true) =>
    sendTelegramControlReply(
      { sendMessage } as unknown as Pick<Api, 'sendMessage'>,
      -100,
      42,
      chatType,
      8,
      '実行を停止しました。',
      enabled
    );

  it('sends group control replies only to the requester and keeps the topic', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    await send(sendMessage, 'supergroup');
    expect(sendMessage).toHaveBeenCalledWith(-100, '実行を停止しました。', {
      message_thread_id: 8,
      ephemeral_message_parameters: { receiver_user_id: 42 },
    });
  });

  it('keeps DMs and disabled mode as ordinary messages', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    await send(sendMessage, 'private');
    await send(sendMessage, 'group', false);
    expect(sendMessage.mock.calls.map((call) => call[2])).toEqual([
      { message_thread_id: 8 },
      { message_thread_id: 8 },
    ]);
  });

  it('falls back once after a definite HTTP 400, but never on a timeout', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce({ error_code: 400, description: 'not supported' })
      .mockResolvedValueOnce({});
    await send(sendMessage, 'group');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][2]).toEqual({ message_thread_id: 8 });

    const timeout = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(send(timeout, 'group')).rejects.toThrow('ETIMEDOUT');
    expect(timeout).toHaveBeenCalledTimes(1);
  });
});
