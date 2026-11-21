import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentConnectionStore, agentConnectionStatus } from '../src/agent-connections.js';
import {
  AgentConnectionRuntimes,
  connectionEnvironment,
  connectionExecArgv,
} from '../src/agent-connection-runtime.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { ProjectCatalog } from '../src/project-catalog.js';

let root: string;
let store: AgentConnectionStore;
let runtimes: AgentConnectionRuntimes | undefined;
const discord = {
  name: '専用Discord',
  platform: 'discord',
  botToken: 'private-discord-token',
  allowedUsers: '123,456',
};
const slack = {
  name: '専用Slack',
  platform: 'slack',
  botToken: 'xoxb-private',
  appToken: 'xapp-private',
  allowedUsers: 'U123,U456',
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-connections-'));
  store = new AgentConnectionStore(root);
  vi.stubEnv('DISCORD_TOKEN', 'common-discord');
  vi.stubEnv('SLACK_BOT_TOKEN', 'common-slack');
  vi.stubEnv('SLACK_APP_TOKEN', 'common-app');
});
afterEach(async () => {
  await runtimes?.stop();
  runtimes = undefined;
  agentConnectionStatus.clear();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('persists both platforms privately and never returns credentials', async () => {
  const [d, s] = await Promise.all([store.save('agent', discord), store.save('agent', slack)]);
  const listed = await new AgentConnectionStore(root).list('agent');
  expect(listed.map((c) => c.id).sort()).toEqual([d.id, s.id].sort());
  expect(JSON.stringify(listed)).not.toMatch(/private|xapp|botToken|appToken/);
  expect(await store.list('other')).toEqual([]);
  expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  await store.save('agent', { name: '改名', botToken: '', appToken: '', enabled: false }, s.id);
  expect((await store.read()).find((c) => c.id === s.id)).toMatchObject({
    ...slack,
    name: '改名',
    enabled: false,
  });
  await store.remove('agent', d.id);
  await expect(store.remove('other', s.id)).rejects.toThrow('見つかりません');
  expect((await store.list('agent')).map((c) => c.id)).toEqual([s.id]);
});

it('rejects missing allow lists, invalid IDs and duplicate/common credentials without overwriting state', async () => {
  for (const bad of [
    { ...discord, allowedUsers: '' },
    { ...discord, allowedUsers: '*' + ',123' },
    { ...slack, allowedUsers: '123' },
    { ...slack, appToken: '' },
    { ...discord, botToken: {} },
    { ...discord, enabled: 'true' },
    { ...discord, platform: 'other' },
  ]) {
    await expect(store.save('agent', bad)).rejects.toThrow();
  }
  await store.save('agent', discord);
  await store.save('agent', slack);
  await expect(store.save('other', discord)).rejects.toThrow('専用Bot');
  await expect(
    store.save('other', { ...slack, botToken: 'another', appToken: slack.appToken })
  ).rejects.toThrow('専用Bot');
  await expect(store.save('agent', { ...discord, botToken: 'common-discord' })).rejects.toThrow(
    '専用Bot'
  );
  await expect(
    store.save('agent', { ...slack, botToken: 'common-slack', appToken: 'other' })
  ).rejects.toThrow('専用Bot');
  await expect(store.save('agent', {}, 'missing')).rejects.toThrow('見つかりません');
  expect(await store.read()).toHaveLength(2);
  await writeFile(
    store.path,
    JSON.stringify({
      version: 1,
      connections: [{ ...discord, id: '../outside', agentId: 'agent' }],
    })
  );
  await expect(store.read()).rejects.toThrow('ID');
});

it.each(['discord', 'slack'] as const)(
  'isolates %s credentials, control endpoints and state while preserving backend settings',
  async (platform) => {
    const saved = await store.save('agent', platform === 'discord' ? discord : slack);
    const connection = (await store.read())[0];
    const env = connectionEnvironment(connection, '/state/own', '/workspace', {
      DISCORD_TOKEN: 'parent',
      SLACK_BOT_TOKEN: 'parent',
      SLACK_USER_TOKEN: 'parent-user',
      LINE_CHANNEL_SECRET: 'parent',
      LINE_CHANNEL_ACCESS_TOKEN: 'parent',
      TELEGRAM_BOT_TOKEN: 'parent',
      XANGI_TOOL_SERVER: 'http://parent',
      XANGI_TOOL_SERVER_PORT: '9999',
      XANGI_SETUP_CONFIG_PATH: '/parent',
      XANGI_REMOTE_WORKER_PORT: '9998',
      XANGI_INTER_CHAT_ENABLED: 'true',
      XANGI_REMOTE_PLATFORM_ENABLED: 'true',
      WEB_CHAT_ENABLED: 'true',
      AGENT_BACKEND: 'codex',
      OPENAI_API_KEY: 'backend-auth',
    });
    expect(env).toMatchObject({
      DATA_DIR: '/state/own',
      WORKSPACE_PATH: '/workspace',
      WEB_CHAT_ENABLED: 'false',
      AGENT_BACKEND: 'codex',
      OPENAI_API_KEY: 'backend-auth',
      XANGI_AGENT_CONNECTION_ID: saved.id,
      XANGI_CONNECTION_AGENT_ID: 'agent',
    });
    expect(env.XANGI_TOOL_SERVER).toBeUndefined();
    expect(env.XANGI_SETUP_CONFIG_PATH).toBeUndefined();
    expect(env.XANGI_REMOTE_PLATFORM_ENABLED).toBeUndefined();
    expect(env.SLACK_USER_TOKEN).toBeUndefined();
    expect(env.LINE_CHANNEL_SECRET).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(platform === 'discord' ? env.SLACK_BOT_TOKEN : env.DISCORD_TOKEN).toBeUndefined();
    expect(env[platform === 'discord' ? 'DISCORD_TOKEN' : 'SLACK_BOT_TOKEN']).toBe(
      connection.botToken
    );
  }
);

it('runs two real isolated child processes, tracks readiness, preserves histories, and stops both', async () => {
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const dataDir = join(root, 'state');
  const registry = await WorkspaceRegistry.open({ dataDir, defaultWorkspacePath: workspace });
  const catalog = new ProjectCatalog(dataDir);
  const agent = catalog.saveAgent({
    name: 'Worker',
    prompt: 'dedicated instructions',
    workspaceId: 'default',
  });
  const connections = new AgentConnectionStore(dataDir);
  const a = await connections.save(agent.id, discord);
  const b = await connections.save(agent.id, slack);
  const fixture = join(root, 'worker.cjs');
  await writeFile(
    fixture,
    `
    const fs = require('node:fs'); const path = require('node:path');
    const dir = process.env.DATA_DIR;
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'project-catalog.json')));
    if (!catalog.agents.some(a => a.id === process.env.XANGI_CONNECTION_AGENT_ID)) process.exit(2);
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({channel: 'same-channel', agent: process.env.XANGI_CONNECTION_AGENT_ID, pid: process.pid}));
    process.send({type: 'agent-connection-ready'});
    process.on('SIGTERM', () => { fs.writeFileSync(path.join(dir, 'stopped'), 'yes'); process.exit(0); });
    process.on('disconnect', () => process.exit(0));
  `
  );
  runtimes = new AgentConnectionRuntimes(dataDir, workspace, registry, { entry: fixture });
  await runtimes.start();
  await vi.waitFor(() => {
    expect(agentConnectionStatus.get(a.id)).toBe('ready');
    expect(agentConnectionStatus.get(b.id)).toBe('ready');
  });
  const dirA = join(dataDir, 'agent-connections', a.id),
    dirB = join(dataDir, 'agent-connections', b.id);
  const historyA = JSON.parse(await readFile(join(dirA, 'sessions.json'), 'utf8'));
  const historyB = JSON.parse(await readFile(join(dirB, 'sessions.json'), 'utf8'));
  expect(historyA.pid).not.toBe(historyB.pid);
  expect(historyA.agent).toBe(agent.id);
  expect(historyB.channel).toBe(historyA.channel);
  await runtimes.stop();
  expect(await readFile(join(dirA, 'stopped'), 'utf8')).toBe('yes');
  expect(await readFile(join(dirB, 'stopped'), 'utf8')).toBe('yes');
  expect(await readFile(join(dirA, 'sessions.json'), 'utf8')).toContain('same-channel');
  expect(agentConnectionStatus.get(a.id)).toBe('stopped');
});

it('recovers a temporary worker lock without restarting the main runtime', async () => {
  const { acquireDataDirLock } = await import('../src/data-dir-lock.js');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const dataDir = join(root, 'state');
  const registry = await WorkspaceRegistry.open({ dataDir, defaultWorkspacePath: workspace });
  const catalog = new ProjectCatalog(dataDir);
  const agent = catalog.saveAgent({ name: 'Locked worker', workspaceId: 'default' });
  const connection = await new AgentConnectionStore(dataDir).save(agent.id, discord);
  const workerDir = join(dataDir, 'agent-connections', connection.id);
  const release = await acquireDataDirLock(workerDir);
  const fixture = join(root, 'retry-worker.cjs');
  await writeFile(
    fixture,
    `process.send({type:'agent-connection-ready'}); process.on('SIGTERM',()=>process.exit(0)); process.on('disconnect',()=>process.exit(0));`
  );
  runtimes = new AgentConnectionRuntimes(dataDir, workspace, registry, { entry: fixture });
  try {
    await runtimes.start();
    expect(agentConnectionStatus.get(connection.id)).toBe('failed');
  } finally {
    await release();
  }
  await vi.waitFor(() => expect(agentConnectionStatus.get(connection.id)).toBe('ready'), {
    timeout: 8000,
    interval: 50,
  });
}, 10000);

it('keeps TypeScript loaders but strips both Node env-file argument forms', () => {
  expect(
    connectionExecArgv([
      '--import',
      'tsx',
      '--env-file=/parent/.env',
      '--env-file-if-exists',
      '/parent/extra.env',
      '--conditions',
      'node',
    ])
  ).toEqual(['--import', 'tsx', '--conditions', 'node']);
});

it.each(['discord', 'slack'] as const)(
  'allows omitted and empty %s names while preserving existing aliases on unrelated edits',
  async (platform) => {
    const { name: _name, ...input } = platform === 'discord' ? discord : slack;
    const created = await store.save('agent', input);
    expect(created.name).toBe('');
    expect((await new AgentConnectionStore(root).list('agent'))[0].name).toBe('');
    await store.save('agent', { name: '任意の別名' }, created.id);
    expect((await store.save('agent', { enabled: false }, created.id)).name).toBe('任意の別名');
    expect((await store.save('agent', { name: '   ' }, created.id)).name).toBe('');
    expect((await store.read())[0]).toMatchObject({ name: '', botToken: input.botToken });
    await expect(store.save('agent', { name: 123 }, created.id)).rejects.toThrow();
    await expect(store.save('agent', { name: 'a'.repeat(81) }, created.id)).rejects.toThrow();
  }
);
