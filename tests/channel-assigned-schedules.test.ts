import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Client } from 'discord.js';
import type { WebClient } from '@slack/web-api';
import type { AgentRunner } from '../src/agent-runner.js';
import type { Config } from '../src/config.js';
import { Scheduler, type Schedule } from '../src/scheduler.js';
import { ProjectCatalog } from '../src/project-catalog.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { registerAgentSelection, changeChannelAgent } from '../src/agent-selection.js';
import { registerAgentConnectionScheduleRelay } from '../src/agent-connection-schedules.js';
import { registerDiscordSchedulerBridge } from '../src/discord/scheduler-bridge.js';
import { registerSlackSchedulerBridge } from '../src/slack.js';
import { initSessions, clearSessions, getSessionEntry } from '../src/sessions.js';
import { initSettings, clearSettingsCache } from '../src/settings.js';

let root: string;
let unregister: (() => void) | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'channel-schedule-rule-'));
  vi.stubEnv('WORKSPACE_PATH', root);
  vi.stubEnv('DATA_DIR', join(root, 'state'));
  vi.stubEnv('XANGI_ENV_PATH', join(root, '.env'));
  vi.stubEnv('XANGI_CONNECTION_AGENT_ID', '');
  vi.stubEnv('XANGI_AGENT_CONNECTION_ID', '');
  await writeFile(join(root, '.env'), '');
  initSessions(join(root, 'state'));
  initSettings(join(root, 'state'));
});
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  clearSessions();
  clearSettingsCache();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it.each(['discord', 'slack'] as const)(
  'resolves every %s schedule from its channel assignment at execution time',
  async (platform) => {
    const catalog = new ProjectCatalog(join(root, 'state'));
    const registry = await WorkspaceRegistry.open({
      dataDir: join(root, 'state'),
      defaultWorkspacePath: root,
    });
    const agents = [];
    for (const name of ['Alpha', 'Beta']) {
      const path = join(root, name);
      await mkdir(path);
      const workspace = await registry.register(name, path);
      agents.push(
        catalog.saveAgent({ name, prompt: `${name} instructions`, workspaceId: workspace.id })
      );
    }
    const runStream = vi.fn(
      async (_prompt: string, _callbacks: unknown, _options: { appSessionId?: string }) => ({
        result: 'normal reply',
        sessionId: 'provider',
      })
    );
    const agentRunner = {
      runStream,
      destroy: vi.fn(),
      getTimeoutState: () => ({ active: false }),
    } as unknown as AgentRunner;
    registerAgentSelection(join(root, 'state'), {
      catalog,
      registry,
      runner: agentRunner,
      busy: () => false,
    });
    await changeChannelAgent(platform, 'channel-a', agents[0].id);
    await changeChannelAgent(platform, 'channel-b', agents[1].id);
    const scheduler = new Scheduler(join(root, 'state'), { quiet: true });
    const send = vi.fn(async () => ({
      id: 'message-id',
      edit: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    }));
    const postMessage = vi.fn(async () => ({ ts: 'message-id' }));
    const config = {
      agent: { backend: 'codex', config: {} },
      discord: { injectTimestamp: false },
    } as Config;
    if (platform === 'discord')
      registerDiscordSchedulerBridge({
        scheduler,
        config,
        agentRunner,
        workspaceRegistry: registry,
        client: {
          channels: { fetch: vi.fn(async () => ({ send, isThread: () => false })) },
        } as unknown as Client,
      });
    else
      registerSlackSchedulerBridge({
        scheduler,
        config,
        agentRunner,
        client: { chat: { postMessage, update: vi.fn(async () => {}) } } as unknown as WebClient,
      });
    const relay = vi.fn(async (agentId: string) => `reply from ${agentId}`);
    unregister = registerAgentConnectionScheduleRelay(relay);
    const schedule: Schedule = {
      id: 'same-existing-schedule',
      type: 'cron',
      expression: '0 9 * * *',
      message: 'same instructions',
      channelId: 'channel-a',
      platform,
      createdAt: new Date().toISOString(),
      enabled: true,
    };
    const before = JSON.stringify(schedule);
    const runner = scheduler.getAgentRunner(platform)!;
    expect(await runner(schedule.message, 'channel-a', schedule)).toBe(
      `reply from ${agents[0].id}`
    );
    expect(
      await runner(schedule.message, 'channel-b', { ...schedule, channelId: 'channel-b' })
    ).toBe(`reply from ${agents[1].id}`);
    // Change the channel setting, keeping the existing schedule unchanged.
    await changeChannelAgent(platform, 'channel-b');
    await changeChannelAgent(platform, 'channel-a', agents[1].id);
    expect(await runner(schedule.message, 'channel-a', schedule)).toBe(
      `reply from ${agents[1].id}`
    );
    expect(JSON.stringify(schedule)).toBe(before);
    expect(send).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(runStream).not.toHaveBeenCalled();
    // An Agent without dedicated transport still runs with its own instructions/workspace.
    unregister();
    unregister = undefined;
    expect(await runner(schedule.message, 'channel-a', schedule)).toBe('normal reply');
    const options = runStream.mock.calls[0][2];
    expect(getSessionEntry(options.appSessionId!)).toMatchObject({
      selectedAgentId: agents[1].id,
      selectedAgentConfig: { prompt: 'Beta instructions' },
      workspacePath: join(root, 'Beta'),
    });
  }
);
