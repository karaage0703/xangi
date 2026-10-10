import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processPrompt } from '../src/discord/message-handler.js';
import { clearSessions, initSessions, setSession } from '../src/sessions.js';
import { initSettings } from '../src/settings.js';
import { IncompleteAgentTurnError } from '../src/errors.js';

describe('processPrompt のCodex途中終了', () => {
  it('完了未確認を警告し、自動フォローアップしない', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'xangi-codex-incomplete-'));
    clearSessions();
    initSessions(testDir);
    initSettings(testDir);
    setSession('incomplete-turn-test', 'existing-codex-session');
    const edit = vi.fn().mockResolvedValue(undefined);
    const replyMessage = { id: 'reply', edit };
    const sendInitial = vi.fn().mockResolvedValue(replyMessage);
    const runStream = vi
      .fn()
      .mockRejectedValue(new IncompleteAgentTurnError('Codex', 'existing-codex-session'));
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
      conversationChannelId: 'incomplete-turn-test',
      settingsChannelId: 'incomplete-turn-test',
      createdThreadName: null,
      threadName: null,
      parentChannelName: null,
      isThread: false,
      outputChannel: { send: vi.fn() },
      sendInitial,
    };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await processPrompt(
        message as never,
        { runStream, run } as never,
        '確認',
        false,
        'incomplete-turn-test',
        {
          agent: { backend: 'codex', config: { workdir: testDir } },
          discord: { streaming: false, showButtons: false, replySuggestions: false },
        } as never,
        target as never,
        { id: 'user', name: 'user', messageId: 'source', react: false }
      );

      expect(result).toBeNull();
      expect(runStream).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      expect(edit).toHaveBeenCalledWith({
        content: expect.stringContaining('⚠️ AIの完了通知を受け取れない'),
        components: [],
      });
      expect(target.outputChannel.send).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      clearSessions();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
