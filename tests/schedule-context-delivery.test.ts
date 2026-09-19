import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineBotClient } from '@line/bot-sdk';
import type { AgentRunner } from '../src/agent-runner.js';
import { runToolCommand } from '../src/cli/tool-command.js';
import { buildCliEnv } from '../src/cli-process.js';
import { Scheduler } from '../src/scheduler.js';
import { startToolServer, stopToolServer } from '../src/tool-server.js';
import { LineChatQueue, registerLineSchedulerBridge } from '../src/line.js';
import { initSessions, clearSessions } from '../src/sessions.js';

describe('schedule creation from mixed-platform tool context', () => {
  let dir: string;
  let scheduler: Scheduler;
  const userId = `U${'b'.repeat(32)}`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xangi-schedule-context-'));
    vi.stubEnv('DATA_DIR', dir);
    vi.stubEnv('XANGI_TOOL_SERVER', undefined);
    vi.stubEnv('XANGI_PLATFORM', undefined);
    initSessions(dir);
    scheduler = new Scheduler(dir, { quiet: true });
    startToolServer({ scheduler });
    await vi.waitFor(() => expect(process.env.XANGI_TOOL_SERVER).toBeTruthy());
  });

  afterEach(() => {
    scheduler.stopAll();
    stopToolServer();
    clearSessions();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers from the per-turn LINE context and pushes after one minute', async () => {
    const pushMessage = vi.fn().mockResolvedValue({});
    const discordSender = vi.fn();
    scheduler.registerSender('discord', discordSender);
    registerLineSchedulerBridge({
      scheduler,
      client: { pushMessage } as unknown as LineBotClient,
      queue: new LineChatQueue(),
      agentRunner: {
        runStream: vi.fn(async (_prompt, callbacks) => {
          const result = { result: 'テスト', sessionId: 'test-provider' };
          callbacks.onComplete?.(result);
          return result;
        }),
      } as unknown as AgentRunner,
    });
    // Fake only scheduling timers; HTTP continues to use the real event loop.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const env = buildCliEnv(`line:${userId}`, undefined, dir);
    expect(env.XANGI_PLATFORM).toBeUndefined();
    await runToolCommand(['schedule_add', '--input', '1分後 テスト'], { env });
    expect(scheduler.list()[0]).toMatchObject({ platform: 'line', channelId: `line:${userId}` });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(pushMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pushMessage).toHaveBeenCalledWith({
      to: userId,
      messages: [{ type: 'text', text: expect.stringContaining('テスト') }],
    });
    expect(discordSender).not.toHaveBeenCalled();
    expect(scheduler.list()).toHaveLength(0);
  });

  it('rejects an invented LINE destination at registration and accepts a corrected retry', async () => {
    const env = buildCliEnv(`line:${userId}`, 'line', dir);

    await expect(
      runToolCommand(
        ['schedule_add', '--input', '1分後 テスト', '--channel', 'current', '--platform', 'line'],
        { env }
      )
    ).rejects.toThrow('現在の会話へ送る場合はchannelとplatformを省略して再実行');
    expect(scheduler.list()).toHaveLength(0);

    await expect(
      runToolCommand(['schedule_add', '--input', '1分後 テスト'], { env })
    ).resolves.toContain('スケジュールを追加しました');
    expect(scheduler.list()[0]).toMatchObject({
      platform: 'line',
      channelId: `line:${userId}`,
    });
  });

  it('preserves explicit flags and forwards an explicit environment platform', async () => {
    const env = buildCliEnv('12345', 'telegram', dir);
    await runToolCommand(['schedule_add', '--input', '1分後 テスト'], { env });
    await runToolCommand(
      ['schedule_add', '--input', '1分後 テスト', '--channel', 'C123', '--platform', 'slack'],
      { env }
    );
    expect(scheduler.list()).toEqual([
      expect.objectContaining({ channelId: '12345', platform: 'telegram' }),
      expect.objectContaining({ channelId: 'C123', platform: 'slack' }),
    ]);
    const slackId = scheduler.list()[1].id;
    await runToolCommand(['schedule_update', '--id', slackId, '--message', '更新'], { env });
    expect(scheduler.get(slackId)).toMatchObject({
      channelId: 'C123',
      platform: 'slack',
      message: '更新',
    });
  });
});
