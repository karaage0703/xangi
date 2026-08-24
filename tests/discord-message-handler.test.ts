import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sendDiscordCompletedResult,
  shouldProcessDiscordMessage,
} from '../src/discord/message-handler.js';
import { createCompletedButtons } from '../src/discord/ui.js';

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
