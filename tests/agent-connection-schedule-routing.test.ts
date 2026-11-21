import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAgentConnectionScheduleRelay } from '../src/agent-connection-schedules.js';
import { registerDiscordSchedulerBridge } from '../src/discord/scheduler-bridge.js';
import { registerSlackSchedulerBridge } from '../src/slack.js';
import { Scheduler } from '../src/scheduler.js';
import { initSessions, clearSessions } from '../src/sessions.js';
import type { AgentRunner } from '../src/agent-runner.js';
import type { Config } from '../src/config.js';
import type { Client } from 'discord.js';
import type { WebClient } from '@slack/web-api';

vi.mock('../src/agent-selection.js', async (original) => ({
  ...(await original<typeof import('../src/agent-selection.js')>()),
  channelAgent: (_platform: string, channel: string) =>
    channel === 'channel-id' ? { id: 'dedicated-agent' } : undefined,
  channelAgentSnapshot: async () => ({ selectedAgentId: 'dedicated-agent' }),
}));
let root: string;
let unregister: (() => void) | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'connection-routing-'));
  initSessions(root);
  vi.stubEnv('XANGI_AGENT_CONNECTION_ID', '');
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
  clearSessions();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it.each(['discord', 'slack'] as const)(
  'uses the %s dedicated Agent runner without posting from the parent Bot',
  async (platform) => {
    const relay = vi.fn(async () => 'dedicated reply');
    unregister = registerAgentConnectionScheduleRelay(relay);
    const scheduler = new Scheduler(root, { quiet: true });
    const send = vi.fn(),
      runStream = vi.fn();
    const fetchChannel = vi.fn(async () => {
      throw new Error('parent Bot has no channel access');
    });
    const config = { discord: {}, agent: { config: {} } } as Config;
    const agentRunner = { runStream } as unknown as AgentRunner;
    if (platform === 'discord')
      registerDiscordSchedulerBridge({
        scheduler,
        config,
        agentRunner,
        client: { channels: { fetch: fetchChannel } } as unknown as Client,
      });
    else
      registerSlackSchedulerBridge({
        scheduler,
        config,
        agentRunner,
        client: { chat: { postMessage: send } } as unknown as WebClient,
      });
    const context = { onStart: vi.fn(), onDelivery: vi.fn() };
    const destination = platform === 'slack' ? 'C1:thread-id' : 'channel-id';
    expect(
      await scheduler.getAgentRunner(platform)!(
        'scheduled content',
        destination,
        undefined,
        context
      )
    ).toBe('dedicated reply');
    expect(relay).toHaveBeenCalledWith(
      'dedicated-agent',
      platform,
      'scheduled content',
      destination,
      undefined,
      context
    );
    expect(fetchChannel).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(runStream).not.toHaveBeenCalled();
    expect(context.onStart).not.toHaveBeenCalled();
  }
);

it('reports unavailable dedicated delivery instead of falling back to the parent', async () => {
  unregister = registerAgentConnectionScheduleRelay(() =>
    Promise.reject(new Error('dedicated unavailable'))
  );
  const scheduler = new Scheduler(root, { quiet: true });
  const send = vi.fn(),
    runStream = vi.fn();
  registerDiscordSchedulerBridge({
    scheduler,
    config: { agent: { config: {} } } as Config,
    agentRunner: { runStream } as unknown as AgentRunner,
    client: { channels: { fetch: vi.fn(async () => ({ send })) } } as unknown as Client,
  });
  await expect(scheduler.getAgentRunner('discord')!('prompt', 'channel')).rejects.toThrow(
    'dedicated unavailable'
  );
  expect(send).not.toHaveBeenCalled();
  expect(runStream).not.toHaveBeenCalled();
});

it('uses the parent channel assignment for an existing Discord thread while retaining its destination', async () => {
  const relay = vi.fn(async () => 'dedicated thread reply');
  unregister = registerAgentConnectionScheduleRelay(relay);
  const scheduler = new Scheduler(root, { quiet: true });
  const send = vi.fn();
  registerDiscordSchedulerBridge({
    scheduler,
    config: { agent: { config: {} } } as Config,
    agentRunner: { runStream: vi.fn() } as unknown as AgentRunner,
    client: {
      channels: {
        fetch: vi.fn(async () => ({ send, isThread: () => true, parentId: 'channel-id' })),
      },
    } as unknown as Client,
  });
  expect(await scheduler.getAgentRunner('discord')!('prompt', 'thread-id')).toBe(
    'dedicated thread reply'
  );
  expect(relay).toHaveBeenCalledWith(
    'dedicated-agent',
    'discord',
    'prompt',
    'thread-id',
    undefined,
    undefined
  );
  expect(send).not.toHaveBeenCalled();
});
