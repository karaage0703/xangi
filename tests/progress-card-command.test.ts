import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRunningSession } from '../src/running-session-context.js';
import { executeProgressCardCommand } from '../src/progress-card-command.js';
import {
  clearSessions,
  createSession,
  createSchedulerSession,
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

  it('updates the executing reservation without changing the active conversation', () => {
    createSchedulerSession('scheduled-1', 'channel-1', { platform: 'discord', title: 'scheduled' });
    const release = registerRunningSession('channel-1', 'scheduled-1');
    try {
      executeProgressCardCommand({ note: '予約の進捗' }, { channelId: 'channel-1' });
      expect(getSessionEntry('scheduled-1')?.progressCard?.note).toBe('予約の進捗');
      expect(getSessionEntry(appSessionId)?.progressCard).toBeUndefined();
    } finally { release(); }
    executeProgressCardCommand({ note: '通常会話' }, { channelId: 'channel-1' });
    expect(getSessionEntry(appSessionId)?.progressCard?.note).toBe('通常会話');
  });

  it('supports a reservation without any active conversation', () => {
    createSchedulerSession('scheduled-2', 'scheduled-channel', { platform: 'discord', title: 'scheduled' });
    const release = registerRunningSession('scheduled-channel', 'scheduled-2');
    try {
      executeProgressCardCommand({ note: '予約のみ' }, { channelId: 'scheduled-channel' });
      expect(getSessionEntry('scheduled-2')?.progressCard?.note).toBe('予約のみ');
      executeProgressCardCommand({ clear: 'true' }, { channelId: 'scheduled-channel' });
      expect(getSessionEntry('scheduled-2')?.progressCard).toBeUndefined();
    } finally { release(); }
  });

  it('rejects ambiguous concurrent sessions instead of updating the active conversation', () => {
    createSchedulerSession('scheduled-3', 'channel-1', { platform: 'discord', title: 'scheduled' });
    const first = registerRunningSession('channel-1', 'scheduled-3');
    const second = registerRunningSession('channel-1', appSessionId);
    try {
      expect(() => executeProgressCardCommand({ note: 'ambiguous' }, { channelId: 'channel-1' }))
        .toThrow('multiple running sessions');
      expect(getSessionEntry(appSessionId)?.progressCard).toBeUndefined();
    } finally { first(); second(); }
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
