import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scheduleCmd } from '../src/cli/schedule-cmd.js';
import { Scheduler, type Schedule } from '../src/scheduler.js';

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

  it('supports Telegram schedules and preserves topic-aware context keys', async () => {
    process.env.XANGI_PLATFORM = 'telegram';

    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: 'telegram:chat:-100123:topic:42',
    });

    const schedules = JSON.parse(
      readFileSync(join(tmpDir, '.xangi', 'schedules.json'), 'utf-8')
    ) as Array<{ platform: string; channelId: string }>;
    expect(schedules[0]).toMatchObject({
      platform: 'telegram',
      channelId: 'telegram:chat:-100123:topic:42',
    });
  });

  it('rejects invalid schedule platforms', async () => {
    await expect(
      scheduleCmd('schedule_add', {
        input: '毎日 9:00 おはよう',
        channel: 'ch1',
        platform: 'mastodon',
      })
    ).rejects.toThrow('--platform must be discord, slack, telegram, or web');
  });

  it('updates only the message while preserving schedule identity and settings', async () => {
    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: 'web-chat:pane123',
      platform: 'web',
    });
    const filePath = join(tmpDir, '.xangi', 'schedules.json');
    const schedules = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<Record<string, unknown>>;
    schedules[0].enabled = false;
    schedules[0].label = '朝';
    schedules[0].projectId = 'project-1';
    writeFileSync(filePath, JSON.stringify(schedules, null, 2));
    const before = { ...schedules[0] };

    const result = await scheduleCmd('schedule_update', {
      id: String(before.id),
      message: '更新後の挨拶',
    });

    const [updated] = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<
      Record<string, unknown>
    >;
    expect(result).toContain(`ID: ${before.id}`);
    expect(updated).toEqual({ ...before, message: '更新後の挨拶' });
  });

  it('replaces type-specific fields and supports 起動時に input', async () => {
    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: 'ch1',
      platform: 'discord',
    });
    const filePath = join(tmpDir, '.xangi', 'schedules.json');
    const schedules = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<Record<string, unknown>>;
    schedules[0].runAt = '2099-01-01T00:00:00.000Z';
    writeFileSync(filePath, JSON.stringify(schedules, null, 2));

    await scheduleCmd('schedule_update', {
      id: String(schedules[0].id),
      input: '起動時に 更新後の起動通知',
    });

    const [updated] = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<
      Record<string, unknown>
    >;
    expect(updated).toMatchObject({ type: 'startup', message: '更新後の起動通知' });
    expect(updated).not.toHaveProperty('expression');
    expect(updated).not.toHaveProperty('runAt');
  });

  it('keeps the existing platform when only the channel changes', async () => {
    process.env.XANGI_PLATFORM = 'slack';
    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: 'discord-old',
      platform: 'discord',
    });
    const filePath = join(tmpDir, '.xangi', 'schedules.json');
    const [created] = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<
      Record<string, unknown>
    >;

    await scheduleCmd('schedule_update', {
      id: String(created.id),
      channel: 'discord-new',
    });

    const [updated] = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<
      Record<string, unknown>
    >;
    expect(updated).toMatchObject({ platform: 'discord', channelId: 'discord-new' });
  });

  it('requires an explicit channel for platform changes and leaves the file unchanged', async () => {
    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: 'ch1',
      platform: 'discord',
    });
    const filePath = join(tmpDir, '.xangi', 'schedules.json');
    const before = readFileSync(filePath, 'utf-8');
    const [created] = JSON.parse(before) as Array<Record<string, unknown>>;

    await expect(
      scheduleCmd('schedule_update', { id: String(created.id), platform: 'slack' })
    ).rejects.toThrow('--channel is required when changing --platform');
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('normalizes Web destinations and drops Web-only projectId when leaving Web', async () => {
    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: 'web-chat:pane123',
      platform: 'web',
    });
    const filePath = join(tmpDir, '.xangi', 'schedules.json');
    const schedules = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<Record<string, unknown>>;
    schedules[0].projectId = 'project-1';
    writeFileSync(filePath, JSON.stringify(schedules, null, 2));

    await scheduleCmd('schedule_update', {
      id: String(schedules[0].id),
      platform: 'discord',
      channel: '123456',
    });

    const [updated] = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<
      Record<string, unknown>
    >;
    expect(updated).toMatchObject({ platform: 'discord', channelId: '123456' });
    expect(updated).not.toHaveProperty('projectId');
  });

  it.each([
    [{}, '--id is required'],
    [{ id: 'missing' }, 'At least one of'],
    [{ id: 'missing', input: '解析不能' }, 'スケジュール形式を解析できません'],
    [{ id: 'missing', input: '起動時 通知', message: '通知' }, 'cannot be used together'],
    [{ id: 'missing', message: '通知' }, 'スケジュールが見つかりません'],
    [{ id: 'missing', message: '通知', typo: 'x' }, 'Unknown schedule_update flag'],
  ])('rejects invalid update flags without changing schedules: %j', async (flags, message) => {
    const filePath = join(tmpDir, '.xangi', 'schedules.json');
    mkdirSync(join(tmpDir, '.xangi'), { recursive: true });
    writeFileSync(filePath, '[]');
    const before = readFileSync(filePath, 'utf-8');

    await expect(scheduleCmd('schedule_update', flags)).rejects.toThrow(message);
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('does not overwrite a malformed schedules file', async () => {
    const filePath = join(tmpDir, '.xangi', 'schedules.json');
    mkdirSync(join(tmpDir, '.xangi'), { recursive: true });
    writeFileSync(filePath, '{broken');

    await expect(
      scheduleCmd('schedule_update', { id: 's1', message: '更新' })
    ).rejects.toThrow();
    expect(readFileSync(filePath, 'utf-8')).toBe('{broken');
  });

  it.each([
    ['cron 99 99 * * * 無効cron', 'Invalid cron expression'],
    ['2020-01-01 10:00 過去の予定', 'runAt must be in the future'],
    ['毎日 99:99 無効時刻', 'Invalid cron expression'],
  ])('rejects invalid parsed updates and leaves the file unchanged: %s', async (input, message) => {
    await scheduleCmd('schedule_add', {
      input: '毎日 9:00 おはよう',
      channel: 'ch1',
      platform: 'discord',
    });
    const filePath = join(tmpDir, '.xangi', 'schedules.json');
    const before = readFileSync(filePath, 'utf-8');
    const [created] = JSON.parse(before) as Array<Record<string, unknown>>;

    await expect(
      scheduleCmd('schedule_update', { id: String(created.id), input })
    ).rejects.toThrow(message);
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('rejects invalid parsed additions before writing schedules', async () => {
    await expect(
      scheduleCmd('schedule_add', {
        input: 'cron 99 99 * * * 無効cron',
        channel: 'ch1',
        platform: 'discord',
      })
    ).rejects.toThrow('Invalid cron expression');
    expect(existsSync(join(tmpDir, '.xangi', 'schedules.json'))).toBe(false);
  });

  it('turns parser exceptions into validation errors without changing schedules', async () => {
    await scheduleCmd('schedule_add', {
      input: '起動時 通知',
      channel: 'ch1',
      platform: 'discord',
    });
    const filePath = join(tmpDir, '.xangi', 'schedules.json');
    const before = readFileSync(filePath, 'utf-8');
    const [created] = JSON.parse(before) as Array<Record<string, unknown>>;

    await expect(
      scheduleCmd('schedule_update', {
        id: String(created.id),
        input: '2025-99-99 10:00 不正な日付',
      })
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('updates the live Scheduler instance and persisted file synchronously', async () => {
    const dataDir = join(tmpDir, '.xangi');
    const scheduler = new Scheduler(dataDir, { quiet: true });
    const addResult = await scheduleCmd(
      'schedule_add',
      { input: '起動時 変更前', channel: 'ch1', platform: 'discord' },
      scheduler
    );
    const id = addResult.match(/ID: ([^)]+)/)?.[1];
    expect(id).toBeTruthy();

    await scheduleCmd('schedule_update', { id: id!, message: '変更後' }, scheduler);

    expect(scheduler.get(id!)?.message).toBe('変更後');
    const persisted = JSON.parse(readFileSync(join(dataDir, 'schedules.json'), 'utf-8')) as Schedule[];
    expect(persisted.find((schedule) => schedule.id === id)?.message).toBe('変更後');
    scheduler.stopAll();
  });
});
