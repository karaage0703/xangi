import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Scheduler, type Schedule } from '../src/scheduler.js';
import { NonRetryableError } from '../src/errors.js';

function makeScheduler(): Scheduler {
  const dir = mkdtempSync(join(tmpdir(), 'xangi-sched-test-'));
  return new Scheduler(dir, { quiet: true });
}

function makeSchedule(id: string): Schedule {
  return {
    id,
    type: 'cron',
    expression: '0 9 * * *',
    message: 'テストジョブ',
    channelId: 'ch1',
    platform: 'discord',
    createdAt: new Date().toISOString(),
    enabled: true,
  };
}

type ExecutableScheduler = { executeJob(schedule: Schedule): Promise<void> };

describe('Scheduler 再発火ガード', () => {
  it('前回実行中に同じスケジュールが発火したらスキップする', async () => {
    const scheduler = makeScheduler();
    let resolveRun: (() => void) | undefined;
    const runner = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRun = () => resolve('done');
        })
    );
    scheduler.registerAgentRunner('discord', runner);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const schedule = makeSchedule('job1');
    const exec = scheduler as unknown as ExecutableScheduler;

    const first = exec.executeJob(schedule); // 実行中のまま保持
    await exec.executeJob(schedule); // 2 回目 → ガードでスキップ
    expect(runner).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('duplicate fire guard'));

    resolveRun?.();
    await first;

    // 実行完了後は再び実行できる
    const second = exec.executeJob(schedule);
    resolveRun?.();
    await second;
    expect(runner).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('別 ID のスケジュールは並行実行できる', async () => {
    const scheduler = makeScheduler();
    const resolvers: (() => void)[] = [];
    const runner = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(() => resolve('done'));
        })
    );
    scheduler.registerAgentRunner('discord', runner);
    const exec = scheduler as unknown as ExecutableScheduler;

    const p1 = exec.executeJob(makeSchedule('jobA'));
    const p2 = exec.executeJob(makeSchedule('jobB'));
    expect(runner).toHaveBeenCalledTimes(2);
    resolvers.forEach((r) => r());
    await Promise.all([p1, p2]);
  });
});

describe('Scheduler transient リトライ', () => {
  it('DNS 一時失敗はバックオフ後に 1 回リトライして成功する', async () => {
    const scheduler = makeScheduler();
    const runner = vi
      .fn<(prompt: string, channelId: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN discord.com'))
      .mockResolvedValueOnce('ok');
    scheduler.registerAgentRunner('discord', runner);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const exec = scheduler as unknown as ExecutableScheduler;
    await exec.executeJob(makeSchedule('jobRetry'));
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('リトライも失敗したら諦める（2 回まで）', async () => {
    const scheduler = makeScheduler();
    const runner = vi
      .fn<(prompt: string, channelId: string) => Promise<string>>()
      .mockRejectedValue(new Error('ConnectTimeoutError: Connect Timeout Error'));
    scheduler.registerAgentRunner('discord', runner);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exec = scheduler as unknown as ExecutableScheduler;
    await exec.executeJob(makeSchedule('jobRetryFail'));
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('タイムアウト等の非 transient エラーはリトライしない', async () => {
    const scheduler = makeScheduler();
    const runner = vi
      .fn<(prompt: string, channelId: string) => Promise<string>>()
      .mockRejectedValue(new Error('Request timed out after 300000ms. Killing process.'));
    scheduler.registerAgentRunner('discord', runner);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exec = scheduler as unknown as ExecutableScheduler;
    await exec.executeJob(makeSchedule('jobTimeout'));
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('副作用後の Telegram 配信失敗は transient でも Agent を再実行しない', async () => {
    const scheduler = makeScheduler();
    const timeout = Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
    const attachmentsAttempted = vi.fn();
    const runner = vi.fn(async () => {
      attachmentsAttempted();
      throw new NonRetryableError('Telegram result delivery failed', { cause: timeout });
    });
    scheduler.registerAgentRunner('telegram', runner);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exec = scheduler as unknown as ExecutableScheduler;
    await exec.executeJob({ ...makeSchedule('telegramDeliveryFail'), platform: 'telegram' });

    expect(attachmentsAttempted).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
