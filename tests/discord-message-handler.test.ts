import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  processPrompt,
  sendDiscordCompletedResult,
  shouldProcessDiscordMessage,
} from '../src/discord/message-handler.js';
import { DiscordTurnCoordinator } from '../src/discord/turn-coordinator.js';
import { createCompletedButtons } from '../src/discord/ui.js';
import { clearSessions, initSessions, setSession } from '../src/sessions.js';
import { initSettings } from '../src/settings.js';

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

describe('processPrompt error completion', () => {
  it.each([
    [
      "You've hit your session limit · resets 5am (Asia/Tokyo)",
      '💳 バックエンドの利用上限に達しています',
    ],
    ['LLM request timed out after 300000ms', '⏱️ タイムアウトしました'],
    ['This operation was aborted', '❌ エラーが発生しました'],
    ['Process exited unexpectedly with code 1', '💥 AIプロセスが予期せず終了しました'],
    ['Some random error', '❌ エラーが発生しました'],
  ])('ends %s without follow-up and accepts the next turn', async (errorMessage, display) => {
    const testDir = mkdtempSync(join(tmpdir(), 'xangi-session-limit-'));
    clearSessions();
    initSessions(testDir);
    initSettings(testDir);
    setSession('session-limit-test', 'existing-claude-session');
    const edit = vi.fn().mockResolvedValue(undefined);
    const replyMessage = { id: 'reply', edit };
    const sendInitial = vi.fn().mockResolvedValue(replyMessage);
    const runStream = vi.fn().mockRejectedValue(new Error(errorMessage));
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
            agent: { backend: 'claude-code', config: { workdir: testDir } },
            discord: { streaming: false, showButtons: false, replySuggestions: false },
          } as never,
          target as never,
          { id: 'user', name: 'user', messageId: 'source', react: false }
        );

      const first = await coordinator.tryRun('session-limit-test', turn);
      expect(first).toEqual({ accepted: true, result: null });
      expect(coordinator.isBusy('session-limit-test')).toBe(false);
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      expect(edit).toHaveBeenCalledWith({
        content: expect.stringContaining(display),
        components: [],
      });
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
