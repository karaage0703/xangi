import { describe, expect, it } from 'vitest';
import { buildCompletionNotification } from '../src/discord/completion-notify.js';

describe('Discord completion notification', () => {
  it('does nothing when disabled', () => {
    expect(
      buildCompletionNotification({
        mode: 'off',
        elapsedMs: 120_000,
        thresholdMs: 60_000,
        userId: 'u1',
        display: { showElapsed: true },
      })
    ).toBeNull();
  });

  it('does nothing below threshold', () => {
    expect(
      buildCompletionNotification({
        mode: 'mention',
        elapsedMs: 59_000,
        thresholdMs: 60_000,
        userId: 'u1',
        display: { showElapsed: true },
      })
    ).toBeNull();
  });

  it('builds a non-mention message notification', () => {
    expect(
      buildCompletionNotification({
        mode: 'message',
        elapsedMs: 61_000,
        thresholdMs: 60_000,
        userId: 'u1',
        display: { showElapsed: true },
      })
    ).toEqual({
      content: '✅ 完了（⏱ 1分01秒）',
      allowedMentions: { parse: [] },
    });
  });

  it('builds a mention notification with an explicit allowed user', () => {
    expect(
      buildCompletionNotification({
        mode: 'mention',
        elapsedMs: 90_000,
        thresholdMs: 60_000,
        userId: '123',
        display: { showElapsed: false },
      })
    ).toEqual({
      content: '<@123> ✅ 完了',
      allowedMentions: { parse: [], users: ['123'] },
    });
  });
});
