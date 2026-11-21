import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AgentConnectionRuntimes } from '../src/agent-connection-runtime.js';
import { AgentConnectionStore, agentConnectionStatus } from '../src/agent-connections.js';
import { relayAgentConnectionSchedule } from '../src/agent-connection-schedules.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { ProjectCatalog } from '../src/project-catalog.js';

let root: string;
let runtimes: AgentConnectionRuntimes | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dedicated-schedules-'));
  vi.stubEnv('XANGI_AGENT_CONNECTION_ID', '');
});
afterEach(async () => {
  await runtimes?.stop();
  runtimes = undefined;
  agentConnectionStatus.clear();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const dataDir = join(root, 'state');
  const registry = await WorkspaceRegistry.open({ dataDir, defaultWorkspacePath: workspace });
  const catalog = new ProjectCatalog(dataDir);
  const agent = catalog.saveAgent({ name: 'Dedicated', workspaceId: 'default' });
  const store = new AgentConnectionStore(dataDir);
  const worker = join(root, 'worker.mjs');
  const module = pathToFileURL(resolve('src/agent-connection-schedules.ts')).href;
  await writeFile(
    worker,
    `
    import { installAgentConnectionScheduleWorker } from ${JSON.stringify(module)};
    const platform = process.env.DISCORD_TOKEN ? 'discord' : 'slack';
    installAgentConnectionScheduleWorker({getAgentRunner: requested => requested !== platform ? undefined : async(prompt, destination, schedule, context) => {
      context?.onStart?.();
      if (prompt === 'reject') throw new Error('fixture rejection');
      if (prompt === 'exit') process.exit(7);
      context?.onDelivery?.({platform, destinationId: destination, messageIds: ['child-message']});
      return process.env.XANGI_CONNECTION_AGENT_ID + ':' + platform + ':' + prompt;
    }}, platform);
    setTimeout(() => process.send({type:'agent-connection-ready'}), 50);
    process.on('SIGTERM', () => process.exit(0));
    process.on('disconnect', () => process.exit(0));
  `
  );
  async function start() {
    runtimes = new AgentConnectionRuntimes(dataDir, workspace, registry, { entry: worker });
    const previous = process.execArgv;
    try {
      process.execArgv = ['--import', createRequire(import.meta.url).resolve('tsx')];
      await runtimes.start();
    } finally {
      process.execArgv = previous;
    }
  }
  return { agent, store, dataDir, start };
}

it('relays existing scheduled tasks through the matching Discord/Slack child, including start and receipt events', async () => {
  const f = await fixture();
  await f.store.save(f.agent.id, {
    platform: 'discord',
    botToken: 'dedicated-discord',
    allowedUsers: '123',
  });
  await f.store.save(f.agent.id, {
    platform: 'slack',
    botToken: 'xoxb-dedicated',
    appToken: 'xapp-dedicated',
    allowedUsers: 'U123',
  });
  const originalSchedules = '[{"id":"existing-schedule","message":"existing instructions"}]';
  await writeFile(join(f.dataDir, 'schedules.json'), originalSchedules);
  await f.start();
  expect(
    relayAgentConnectionSchedule('other-agent', 'discord', 'prompt', 'same-channel')
  ).toBeUndefined();
  // Calls made before the child's ready message must wait for readiness.
  for (const platform of ['discord', 'slack'] as const) {
    const onStart = vi.fn(),
      onDelivery = vi.fn();
    const destination = platform === 'slack' ? 'same-channel:thread-id' : 'same-channel';
    const result = await relayAgentConnectionSchedule(
      f.agent.id,
      platform,
      'prompt',
      destination,
      undefined,
      { onStart, onDelivery }
    );
    expect(result).toBe(`${f.agent.id}:${platform}:prompt`);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onDelivery).toHaveBeenCalledWith({
      platform,
      destinationId: destination,
      messageIds: ['child-message'],
    });
  }
  expect(await readFile(join(f.dataDir, 'schedules.json'), 'utf8')).toBe(originalSchedules);
  await expect(
    relayAgentConnectionSchedule(f.agent.id, 'discord', 'reject', 'same-channel')
  ).rejects.toThrow();
  await expect(
    relayAgentConnectionSchedule(f.agent.id, 'discord', 'exit', 'same-channel')
  ).rejects.toThrow('接続が終了');
}, 15000);

it('does not use a shared Bot when dedicated connections are disabled or ambiguous', async () => {
  const f = await fixture();
  await f.store.save(f.agent.id, {
    platform: 'discord',
    botToken: 'disabled',
    allowedUsers: '123',
    enabled: false,
  });
  await f.store.save(f.agent.id, {
    platform: 'slack',
    botToken: 'one',
    appToken: 'app-one',
    allowedUsers: 'U123',
  });
  await f.store.save(f.agent.id, {
    platform: 'slack',
    botToken: 'two',
    appToken: 'app-two',
    allowedUsers: 'U123',
  });
  await f.start();
  await expect(
    relayAgentConnectionSchedule(f.agent.id, 'discord', 'prompt', 'channel')
  ).rejects.toThrow('無効');
  await expect(
    relayAgentConnectionSchedule(f.agent.id, 'slack', 'prompt', 'channel')
  ).rejects.toThrow('複数');
  await runtimes!.stop();
  expect(relayAgentConnectionSchedule(f.agent.id, 'discord', 'prompt', 'channel')).toBeUndefined();
});
