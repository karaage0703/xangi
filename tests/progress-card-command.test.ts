import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeProgressCardCommand } from '../src/progress-card-command.js';
import {
  clearSessions,
  createSession,
  getSessionEntry,
  initSessions,
} from '../src/sessions.js';

describe('progress_card command', () => {
  let testDir: string;
  let appSessionId: string;

  beforeEach(() => {
    clearSessions();
    testDir = mkdtempSync(join(tmpdir(), 'progress-card-test-'));
    initSessions(testDir);
    appSessionId = createSession('channel-1', { platform: 'discord' });
  });

  afterEach(() => {
    clearSessions();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it('replaces the whole plan for the active session', () => {
    const result = executeProgressCardCommand(
      {
        'plan-json': JSON.stringify([
          { step: '調査', status: 'completed' },
          { step: '実装', status: 'in_progress' },
        ]),
        note: '動作確認中',
      },
      { channelId: 'channel-1' }
    );

    expect(result).toContain('1/2 done');
    expect(getSessionEntry(appSessionId)?.progressCard?.note).toBe('動作確認中');
  });

  it('rejects multiple current steps', () => {
    expect(() =>
      executeProgressCardCommand(
        {
          'plan-json': JSON.stringify([
            { step: 'A', status: 'in_progress' },
            { step: 'B', status: 'in_progress' },
          ]),
        },
        { channelId: 'channel-1' }
      )
    ).toThrow('at most one in_progress');
  });
});
