import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync } from 'fs';
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
    delete process.env.XANGI_PLATFORM;
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

  it('uses XANGI_PLATFORM when --platform is omitted', async () => {
    process.env.XANGI_PLATFORM = 'slack';

    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: 'C123',
    });

    const schedules = JSON.parse(
      readFileSync(join(tmpDir, '.xangi', 'schedules.json'), 'utf-8')
    ) as Array<{ platform: string; channelId: string }>;
    expect(schedules[0]).toMatchObject({ platform: 'slack', channelId: 'C123' });
  });

  it('lets explicit --platform override XANGI_PLATFORM', async () => {
    process.env.XANGI_PLATFORM = 'slack';

    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: '1234567890',
      platform: 'discord',
    });

    const schedules = JSON.parse(
      readFileSync(join(tmpDir, '.xangi', 'schedules.json'), 'utf-8')
    ) as Array<{ platform: string }>;
    expect(schedules[0]?.platform).toBe('discord');
  });

  it('supports Web schedules and normalizes web-chat context keys', async () => {
    process.env.XANGI_PLATFORM = 'web';

    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: 'web-chat:pane123',
    });

    const schedules = JSON.parse(
      readFileSync(join(tmpDir, '.xangi', 'schedules.json'), 'utf-8')
    ) as Array<{ platform: string; channelId: string }>;
    expect(schedules[0]).toMatchObject({ platform: 'web', channelId: 'pane123' });
  });

  it('rejects invalid schedule platforms', async () => {
    await expect(
      scheduleCmd('schedule_add', {
        input: '毎日 9:00 おはよう',
        channel: 'ch1',
        platform: 'mastodon',
      })
    ).rejects.toThrow('--platform must be discord, slack, or web');
  });
});
