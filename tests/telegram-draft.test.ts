import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import {
  isUnsupportedTelegramDraftError,
  nextTelegramDraftId,
  TelegramDraftPreview,
  TelegramDraftRegistry,
} from '../src/telegram-draft.js';

afterEach(() => {
  vi.useRealTimers();
});

function preview(
  sendMessageDraft = vi.fn().mockResolvedValue(true),
  threadId?: number,
  current = () => true,
  onFailure = vi.fn()
) {
  const draft = new TelegramDraftPreview(
    { sendMessageDraft } as unknown as Pick<Api, 'sendMessageDraft'>,
    123,
    threadId,
    current,
    onFailure
  );
  return { draft, sendMessageDraft, onFailure };
}

describe('TelegramDraftPreview', () => {
  it('keeps one nonzero ID per turn, throttles updates, and refreshes before expiry', async () => {
    vi.useFakeTimers();
    const { draft, sendMessageDraft } = preview(undefined, 9);
    draft.start();
    await vi.waitFor(() => expect(sendMessageDraft).toHaveBeenCalledTimes(1));
    expect(sendMessageDraft.mock.calls[0].slice(0, 4)).toEqual([
      123,
      draft.draftId,
      '考え中...',
      { message_thread_id: 9, can_stop: true },
    ]);
    await draft.update('partial');
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await draft.update('partial');
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendMessageDraft).toHaveBeenCalledTimes(3);
    expect(sendMessageDraft.mock.calls.every((call) => call[1] === draft.draftId)).toBe(true);
    draft.stop();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendMessageDraft).toHaveBeenCalledTimes(3);
  });

  it('uses distinct nonzero IDs, omits absent topics, and stops on generation change', async () => {
    vi.useFakeTimers();
    let current = true;
    const first = preview(undefined, undefined, () => current);
    const second = preview();
    expect(first.draft.draftId).not.toBe(second.draft.draftId);
    expect(nextTelegramDraftId()).toBeGreaterThan(0);
    first.draft.start();
    await vi.waitFor(() => expect(first.sendMessageDraft).toHaveBeenCalledTimes(1));
    expect(first.sendMessageDraft.mock.calls[0][3]).toEqual({ can_stop: true });
    current = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(first.sendMessageDraft).toHaveBeenCalledTimes(1);
    first.draft.stop();
  });

  it('stops draft updates after a failure without throwing into the agent run', async () => {
    vi.useFakeTimers();
    const sendMessageDraft = vi.fn().mockRejectedValue(new Error('network timeout'));
    const { draft, onFailure } = preview(sendMessageDraft);
    draft.start();
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(21_000);
    await expect(draft.update('answer')).resolves.toBeUndefined();
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    draft.stop();
  });

  it('recognizes only definite unsupported API responses', () => {
    expect(
      isUnsupportedTelegramDraftError({
        error_code: 400,
        description: 'Bad Request: method not found',
      })
    ).toBe(true);
    expect(
      isUnsupportedTelegramDraftError({ error_code: 500, description: 'method not found' })
    ).toBe(false);
    expect(isUnsupportedTelegramDraftError(new Error('ETIMEDOUT'))).toBe(false);
  });

  it('aborts an in-flight draft request when stopped', async () => {
    const sendMessageDraft = vi.fn(
      (_chat: number, _id: number, _text: string, _options: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const { draft, onFailure } = preview(sendMessageDraft);
    draft.start();
    const signal = sendMessageDraft.mock.calls[0][4];
    expect(signal.aborted).toBe(false);
    draft.stop();
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('TelegramDraftRegistry', () => {
  it('accepts a stop only for the current draft, chat, topic, and generation', () => {
    const registry = new TelegramDraftRegistry();
    const key = 'telegram:dm:123:topic:9';
    const stop = vi.fn();
    registry.register(11, {
      chatId: 123,
      messageThreadId: 9,
      contextKey: key,
      generation: 4,
      stop,
    });
    const current = () => 4;
    const onMismatch = vi.fn();
    expect(registry.consumeStop(12, 123, 9, current)).toBeUndefined();
    expect(registry.consumeStop(11, 456, 9, current)).toBeUndefined();
    expect(registry.consumeStop(11, 123, 8, current, onMismatch)).toBeUndefined();
    expect(onMismatch).toHaveBeenCalledWith('topic');
    expect(registry.consumeStop(11, 123, undefined, current)).toBe(key);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.consumeStop(11, 123, 9, current)).toBeUndefined();

    registry.register(12, { chatId: 123, contextKey: key, generation: 4 });
    expect(registry.consumeStop('12', 123, 9, current)).toBe(key);
    expect(registry.consumeStop('not-an-id', 123, 9, current)).toBeUndefined();

    registry.register(13, { chatId: 123, contextKey: key, generation: 4 });
    expect(registry.consumeStop(13, 123, undefined, () => 5, onMismatch)).toBeUndefined();
    expect(onMismatch).toHaveBeenCalledWith('generation');
    registry.register(14, { chatId: 123, contextKey: key, generation: 5 });
    registry.unregister(14);
    expect(registry.consumeStop(14, 123, undefined, () => 5)).toBeUndefined();

    const resetStop = vi.fn();
    registry.register(15, { chatId: 123, contextKey: key, generation: 5, stop: resetStop });
    registry.stopContext(key);
    expect(resetStop).toHaveBeenCalledTimes(1);
    expect(registry.consumeStop(15, 123, undefined, () => 5)).toBeUndefined();
  });
});
