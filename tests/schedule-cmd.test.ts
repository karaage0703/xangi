import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scheduleCmd } from '../src/cli/schedule-cmd.js';

/**
 * src/cli/schedule-cmd.ts のリグレッションテスト。
 *
 * PR #189: DATA_DIR が未設定でも WORKSPACE_PATH/.xangi に schedules.json
 * を書き出すこと（process.cwd() に書かない）。
 */
describe('schedule-cmd WORKSPACE_PATH (PR #189)', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-cmd-test-'));
    originalEnv = { ...process.env };
    delete process.env.DATA_DIR;
    process.env.WORKSPACE_PATH = tmpDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes schedules.json under WORKSPACE_PATH/.xangi when DATA_DIR is unset', async () => {
    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: 'ch1',
      platform: 'discord',
    });

    const expectedPath = join(tmpDir, '.xangi', 'schedules.json');
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('respects DATA_DIR over WORKSPACE_PATH', async () => {
    const dataDir = join(tmpDir, 'custom-data');
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;

    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 テスト',
      channel: 'ch1',
      platform: 'discord',
    });

    expect(existsSync(join(dataDir, 'schedules.json'))).toBe(true);
    expect(existsSync(join(tmpDir, '.xangi', 'schedules.json'))).toBe(false);
  });

  it('returns empty list initially under fresh WORKSPACE_PATH', async () => {
    const result = await scheduleCmd('schedule_list', {});
    expect(result).toContain('スケジュールはありません');
  });
});
