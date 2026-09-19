import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleCmd } from '../src/cli/schedule-cmd.js';
import type { Schedule } from '../src/scheduler.js';

describe('schedule platform inference', () => {
  let dir: string;
  const lineUser = `U${'a'.repeat(32)}`;
  const saved = (): Schedule[] => JSON.parse(readFileSync(join(dir, 'schedules.json'), 'utf8'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xangi-platform-'));
    vi.stubEnv('DATA_DIR', dir);
    vi.stubEnv('XANGI_PLATFORM', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    [`line:${lineUser}`, 'line', `line:${lineUser}`],
    [lineUser, 'line', lineUser],
    ['C123ABC', 'slack', 'C123ABC'],
    ['D123ABC', 'slack', 'D123ABC'],
    ['G123ABC:1700000000.000100', 'slack', 'G123ABC:1700000000.000100'],
    ['telegram:dm:123', 'telegram', 'telegram:dm:123'],
    ['telegram:chat:-100123', 'telegram', 'telegram:chat:-100123'],
    ['telegram:chat:-100123:topic:42', 'telegram', 'telegram:chat:-100123:topic:42'],
    ['123:topic:42', 'telegram', '123:topic:42'],
    ['web-chat:pane123', 'web', 'pane123'],
    ['1234567890', 'discord', '1234567890'],
    ['-100123', 'discord', '-100123'],
    ['unknown', 'discord', 'unknown'],
  ])('resolves %s to %s', async (channel, platform, channelId) => {
    await scheduleCmd('schedule_add', { input: '1分後 テスト', channel });
    expect(saved()[0]).toMatchObject({ platform, channelId, type: 'once' });
  });

  it('prefers the explicit platform over the environment and inference', async () => {
    vi.stubEnv('XANGI_PLATFORM', 'slack');
    await scheduleCmd('schedule_add', {
      input: '1分後 テスト',
      channel: `line:${lineUser}`,
      platform: 'telegram',
    });
    expect(saved()[0].platform).toBe('telegram');
  });

  it('prefers the environment over inference', async () => {
    vi.stubEnv('XANGI_PLATFORM', 'slack');
    await scheduleCmd('schedule_add', { input: '1分後 テスト', channel: `line:${lineUser}` });
    expect(saved()[0].platform).toBe('slack');
  });

  it.each(['explicit', 'environment'])(
    'rejects an invalid %s platform without falling back',
    async (source) => {
      if (source === 'environment') vi.stubEnv('XANGI_PLATFORM', 'invalid');
      await expect(
        scheduleCmd('schedule_add', {
          input: '1分後 テスト',
          channel: `line:${lineUser}`,
          ...(source === 'explicit' ? { platform: 'invalid' } : {}),
        })
      ).rejects.toThrow('--platform must be');
    }
  );

  it('infers from the actual destination when input overrides the channel', async () => {
    await scheduleCmd('schedule_add', {
      input: '<#1234567890> 1分後 テスト',
      channel: `line:${lineUser}`,
    });
    expect(saved()[0]).toMatchObject({ platform: 'discord', channelId: '1234567890' });
  });
});
