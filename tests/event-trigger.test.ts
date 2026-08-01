import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  EventTrigger,
  loadTriggerConfig,
  TRIGGER_MAX_MESSAGE_LENGTH,
  type TriggerConfig,
} from '../src/event-trigger.js';
import type { Scheduler } from '../src/scheduler.js';
import { startToolServer, stopToolServer } from '../src/tool-server.js';

/** AgentRunFn / SendMessageFn だけ持つ最小の Scheduler フェイク */
function makeFakeScheduler(overrides?: {
  runner?: ((prompt: string, channelId: string) => Promise<string>) | null;
  sender?: ((channelId: string, message: string) => Promise<void>) | null;
}): {
  scheduler: Scheduler;
  runner: ReturnType<typeof vi.fn>;
  sender: ReturnType<typeof vi.fn>;
} {
  const runner = vi.fn(async (_prompt: string, _channelId: string) => 'agent result');
  const sender = vi.fn(async (_channelId: string, _message: string) => {});
  const runnerImpl = overrides?.runner === null ? undefined : (overrides?.runner ?? runner);
  const senderImpl = overrides?.sender === null ? undefined : (overrides?.sender ?? sender);
  const scheduler = {
    getAgentRunner: (platform: string) =>
      platform === 'discord' || platform === 'web' ? runnerImpl : undefined,
    getSender: (platform: string) =>
      platform === 'discord' || platform === 'web' ? senderImpl : undefined,
  } as unknown as Scheduler;
  return { scheduler, runner, sender };
}

function makeConfig(overrides?: Partial<TriggerConfig>): TriggerConfig {
  return { enabled: true, token: 'secret-token', minIntervalMs: 0, ...overrides };
}

const AUTH = 'Bearer secret-token';

/** fire-and-forget の完了を待つ（microtask flush） */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('loadTriggerConfig', () => {
  it('defaults: disabled, no token, 10s interval', () => {
    const cfg = loadTriggerConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.token).toBeUndefined();
    expect(cfg.minIntervalMs).toBe(10_000);
  });

  it('reads env values', () => {
    const cfg = loadTriggerConfig({
      TRIGGER_ENABLED: 'true',
      XANGI_TRIGGER_TOKEN: 'abc',
      TRIGGER_MIN_INTERVAL_MS: '500',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.token).toBe('abc');
    expect(cfg.minIntervalMs).toBe(500);
  });

  it('falls back to default interval for invalid values', () => {
    expect(loadTriggerConfig({ TRIGGER_MIN_INTERVAL_MS: 'abc' }).minIntervalMs).toBe(10_000);
    expect(loadTriggerConfig({ TRIGGER_MIN_INTERVAL_MS: '-5' }).minIntervalMs).toBe(10_000);
  });
});

describe('EventTrigger.handleHttp auth', () => {
  it('returns 404 when disabled', async () => {
    const { scheduler } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig({ enabled: false }), scheduler);
    const res = await trigger.handleHttp({ channel: 'c1', message: 'hi' }, AUTH);
    expect(res.status).toBe(404);
  });

  it('returns 401 when token is not configured (even if enabled)', async () => {
    const { scheduler } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig({ token: undefined }), scheduler);
    const res = await trigger.handleHttp({ channel: 'c1', message: 'hi' }, 'Bearer anything');
    expect(res.status).toBe(401);
  });

  it('returns 401 for missing or wrong bearer token', async () => {
    const { scheduler, runner } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig(), scheduler);
    expect((await trigger.handleHttp({ channel: 'c1', message: 'hi' }, undefined)).status).toBe(
      401
    );
    expect(
      (await trigger.handleHttp({ channel: 'c1', message: 'hi' }, 'Bearer wrong')).status
    ).toBe(401);
    expect(
      (await trigger.handleHttp({ channel: 'c1', message: 'hi' }, 'secret-token')).status
    ).toBe(401); // Bearer プレフィックス無しは拒否
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('EventTrigger validation', () => {
  it('returns 400 for missing channel / message', async () => {
    const { scheduler } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig(), scheduler);
    expect((await trigger.handleHttp({ message: 'hi' }, AUTH)).status).toBe(400);
    expect((await trigger.handleHttp({ channel: 'c1' }, AUTH)).status).toBe(400);
    expect((await trigger.handleHttp({ channel: '  ', message: 'hi' }, AUTH)).status).toBe(400);
  });

  it('returns 400 for too long message', async () => {
    const { scheduler } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig(), scheduler);
    const res = await trigger.handleHttp(
      { channel: 'c1', message: 'x'.repeat(TRIGGER_MAX_MESSAGE_LENGTH + 1) },
      AUTH
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid source / platform', async () => {
    const { scheduler } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig(), scheduler);
    expect(
      (await trigger.handleHttp({ channel: 'c1', message: 'hi', source: 'バツ' }, AUTH)).status
    ).toBe(400);
    expect(
      (await trigger.handleHttp({ channel: 'c1', message: 'hi', source: 'a'.repeat(65) }, AUTH))
        .status
    ).toBe(400);
    expect(
      (await trigger.handleHttp({ channel: 'c1', message: 'hi', platform: 'line' }, AUTH)).status
    ).toBe(400);
  });

  it('returns 503 when no agent runner is registered for the platform', async () => {
    const { scheduler } = makeFakeScheduler({ runner: null });
    const trigger = new EventTrigger(makeConfig(), scheduler);
    const res = await trigger.handleHttp({ channel: 'c1', message: 'hi' }, AUTH);
    expect(res.status).toBe(503);
  });
});

describe('EventTrigger firing', () => {
  it('fires agent turn with source header and returns 202 immediately', async () => {
    const { scheduler, runner, sender } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig(), scheduler);
    const res = await trigger.handleHttp(
      { channel: 'c1', message: 'build done', source: 'docker-build' },
      AUTH
    );
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.triggerId).toMatch(/^trg_/);
    expect(res.body.source).toBe('docker-build');
    await flush();
    expect(runner).toHaveBeenCalledOnce();
    const [prompt, channelId] = runner.mock.calls[0];
    expect(channelId).toBe('c1');
    expect(prompt).toContain('source=docker-build');
    expect(prompt).toContain('build done');
    expect(sender).toHaveBeenCalledWith('c1', '⚡ trigger: docker-build');
  });

  it('uses default source "external" and platform "discord"', async () => {
    const { scheduler, runner } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig(), scheduler);
    const res = await trigger.handleHttp({ channel: 'c1', message: 'hi' }, AUTH);
    expect(res.status).toBe(202);
    expect(res.body.source).toBe('external');
    expect(res.body.platform).toBe('discord');
    await flush();
    expect(runner).toHaveBeenCalledOnce();
  });

  it('routes Web triggers to the raw appSessionId', async () => {
    const { scheduler, runner, sender } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig(), scheduler);
    const res = await trigger.handleLocal({
      channel: 'web-chat:pane123',
      message: 'render finished',
      source: 'render',
      platform: 'web',
    });

    expect(res.status).toBe(202);
    expect(res.body.platform).toBe('web');
    await flush();
    expect(runner).toHaveBeenCalledWith(expect.stringContaining('render finished'), 'pane123');
    expect(sender).toHaveBeenCalledWith('pane123', '⚡ trigger: render');
  });

  it('rate limits same source within minIntervalMs', async () => {
    const { scheduler } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig({ minIntervalMs: 60_000 }), scheduler);
    const first = await trigger.handleHttp({ channel: 'c1', message: 'hi', source: 'ci' }, AUTH);
    expect(first.status).toBe(202);
    await flush();
    const second = await trigger.handleHttp(
      { channel: 'c1', message: 'hi again', source: 'ci' },
      AUTH
    );
    expect(second.status).toBe(429);
    expect(second.body.retryAfterMs).toBeGreaterThan(0);
    // 別 source はレート制限の影響を受けない
    const other = await trigger.handleHttp({ channel: 'c1', message: 'hi', source: 'other' }, AUTH);
    expect(other.status).toBe(202);
  });

  it('returns 409 while the same source turn is still running', async () => {
    let resolveRun: (v: string) => void = () => {};
    const pendingRunner = () =>
      new Promise<string>((resolve) => {
        resolveRun = resolve;
      });
    const { scheduler } = makeFakeScheduler({ runner: pendingRunner });
    const trigger = new EventTrigger(makeConfig(), scheduler);
    const first = await trigger.handleHttp({ channel: 'c1', message: 'hi', source: 'ci' }, AUTH);
    expect(first.status).toBe(202);
    const second = await trigger.handleHttp(
      { channel: 'c1', message: 'hi again', source: 'ci' },
      AUTH
    );
    expect(second.status).toBe(409);
    resolveRun('done');
    await flush();
    const third = await trigger.handleHttp(
      { channel: 'c1', message: 'after done', source: 'ci' },
      AUTH
    );
    expect(third.status).toBe(202);
  });

  it('keeps firing even when sender is missing (label is best-effort)', async () => {
    const { scheduler, runner } = makeFakeScheduler({ sender: null });
    const trigger = new EventTrigger(makeConfig(), scheduler);
    const res = await trigger.handleHttp({ channel: 'c1', message: 'hi' }, AUTH);
    expect(res.status).toBe(202);
    await flush();
    expect(runner).toHaveBeenCalledOnce();
  });
});

describe('EventTrigger.handleLocal', () => {
  it('requires enabled but not token', async () => {
    const { scheduler, runner } = makeFakeScheduler();
    const disabled = new EventTrigger(makeConfig({ enabled: false }), scheduler);
    expect((await disabled.handleLocal({ channel: 'c1', message: 'hi' })).status).toBe(404);

    const enabled = new EventTrigger(makeConfig({ token: undefined }), scheduler);
    const res = await enabled.handleLocal({ channel: 'c1', message: 'hi' });
    expect(res.status).toBe(202);
    await flush();
    expect(runner).toHaveBeenCalledOnce();
  });
});

describe('tool-server POST /api/trigger', () => {
  let serverUrl: string;

  beforeAll(() => {
    delete process.env.XANGI_TOOL_SERVER;
    const { scheduler } = makeFakeScheduler();
    const trigger = new EventTrigger(makeConfig(), scheduler);
    startToolServer({ eventTrigger: trigger });
    return new Promise<void>((resolve) => {
      const wait = () => {
        if (process.env.XANGI_TOOL_SERVER) {
          serverUrl = process.env.XANGI_TOOL_SERVER;
          resolve();
        } else {
          setTimeout(wait, 10);
        }
      };
      wait();
    });
  });

  afterAll(() => {
    stopToolServer();
  });

  it('returns 401 without bearer token', async () => {
    const res = await fetch(`${serverUrl}/api/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'c1', message: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 202 with valid token', async () => {
    const res = await fetch(`${serverUrl}/api/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: AUTH },
      body: JSON.stringify({ channel: 'c1', message: 'hi', source: 'http-test' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; triggerId: string };
    expect(body.ok).toBe(true);
    expect(body.triggerId).toMatch(/^trg_/);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${serverUrl}/api/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: AUTH },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('routes xangi-cmd trigger via /api/execute (local trust, no token)', async () => {
    const res = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'trigger',
        flags: { channel: 'c1', message: 'local fire', source: 'cli-test' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(body.ok).toBe(true);
    expect(body.result).toContain('トリガーを発火しました');
  });
});
