import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { AgentConnectionRuntimes } from '../src/agent-connection-runtime.js';
import { AgentConnectionStore, agentConnectionStatus } from '../src/agent-connections.js';
import { changeChannelAgent, registerAgentSelection } from '../src/agent-selection.js';
import type { AgentRunner } from '../src/agent-runner.js';
import { BackendResolver } from '../src/backend-resolver.js';
import type { Config } from '../src/config.js';
import { ProjectCatalog } from '../src/project-catalog.js';
import { clearSessions, initSessions } from '../src/sessions.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

let root: string | undefined;
let runtimes: AgentConnectionRuntimes | undefined;
afterEach(async () => {
  await runtimes?.stop();
  clearSessions();
  agentConnectionStatus.clear();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('applies dedicated Discord Bot Agent settings on the next turn and restores its private defaults after restart', async () => {
  root = await mkdtemp(join(tmpdir(), 'dedicated-backend-settings-'));
  vi.stubEnv('XANGI_CONNECTION_AGENT_ID', '');
  vi.stubEnv('XANGI_AGENT_CONNECTION_ID', '');
  vi.stubEnv('ALLOWED_BACKENDS', 'codex,claude-code,local-llm');
  vi.stubEnv('CHANNEL_OVERRIDES', '{}');
  vi.stubEnv('XANGI_ENV_PATH', join(root, '.env'));
  vi.stubEnv('AGENT_BACKEND', 'codex');
  vi.stubEnv('AGENT_MODEL', 'default-model');
  vi.stubEnv('AGENT_EFFORT', 'medium');
  vi.stubEnv('RESPOND_TO_BOTS_ENABLED', 'false');
  const dataDir = join(root, 'data');
  const workdir = join(root, 'workspace');
  await mkdir(workdir);
  initSessions(dataDir);
  const registry = await WorkspaceRegistry.open({ dataDir, defaultWorkspacePath: workdir });
  const catalog = new ProjectCatalog(dataDir);
  const agentPath = join(workdir, 'agent');
  const newPath = join(workdir, 'new-workspace');
  await Promise.all([mkdir(agentPath), mkdir(newPath)]);
  const workspace = await registry.register('agent', agentPath);
  const agent = catalog.saveAgent({
    name: 'fixture-agent',
    prompt: 'keep instructions',
    backend: 'codex',
    workspaceId: workspace.id,
  });
  const other = catalog.saveAgent({ name: 'other', backend: 'codex' });
  const runner = {} as AgentRunner;
  const config = {
    agent: {
      backend: 'codex',
      config: { workdir, model: 'default-model' },
      effort: 'medium',
      allowedBackends: ['codex', 'claude-code', 'local-llm'],
    },
    claudeCode: {},
    discord: { allowedUsers: ['123'] },
  } as Config;
  const resolver = new BackendResolver(config);
  registerAgentSelection(dataDir, { catalog, registry, runner });
  await changeChannelAgent('discord', 'work-channel', agent.id);
  await changeChannelAgent('discord', 'other-channel', other.id);
  await new AgentConnectionStore(dataDir).save(agent.id, {
    platform: 'discord',
    botToken: 'discord-fixture',
    allowedUsers: '123',
  });
  const worker = join(root, 'worker.mjs');
  const output = join(root, 'output.json');
  const restarted = join(root, 'restarted.json');
  const module = (name: string) => JSON.stringify(pathToFileURL(resolve('src', name)).href);
  await writeFile(worker, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { buildSlashCommands, createInteractionHandler } from ${module('discord/slash-commands.ts')};
    import { installDedicatedAgentSettingsReceiver, requestDedicatedAgentSettings } from ${module('agent-connection-settings.ts')};
    import { registerAgentSelection, resolveAgentBackend, sessionAgent } from ${module('agent-selection.ts')};
    import { ProjectCatalog } from ${module('project-catalog.ts')};
    import { WorkspaceRegistry } from ${module('workspace-registry.ts')};
    import { ensureSessionWithWorkspace } from ${module('session-workspace.ts')};
    import { initSessions } from ${module('sessions.ts')};
    import { BackendResolver } from ${module('backend-resolver.ts')};
    process.on('SIGTERM', () => process.exit(0));
    const dataDir = process.env.DATA_DIR;
    const workdir = process.env.WORKSPACE_PATH;
    initSessions(dataDir);
    const registry = await WorkspaceRegistry.open({ dataDir, defaultWorkspacePath: workdir });
    const catalog = new ProjectCatalog(dataDir);
    const agentRunner = {
      switchBackend: () => { throw new Error('must keep the active turn'); },
      switchDefaultBackend() {},
    };
    const config = ${JSON.stringify(config)};
    const resolver = new BackendResolver(config);
    registerAgentSelection(dataDir, { catalog, registry, runner: agentRunner });
    installDedicatedAgentSettingsReceiver();
    const discoverModels = async (backend) => ({
      backend, status: 'available', source: 'fixture', models: [{ id: 'fixture-model' }],
    });
    const handler = createInteractionHandler({ config, resolver, agentRunner, workdir, workspaceRegistry: registry, discoverModels });
    function slash(action, parentId = 'work-channel', userId = '123', inThread = true, scope = null) {
      const values = action === 'set'
        ? { type: 'claude-code', model: 'fixture-model', effort: 'high', scope }
        : { scope };
      return interact('backend', action, values, { parentId, userId, inThread });
    }
    async function interact(commandName, action, values, { parentId = 'work-channel', userId = '123', inThread = true } = {}) {
      let response;
      const save = (value) => { response = value?.content || value; };
      const interaction = {
        commandName, channelId: inThread ? 'thread-42' : parentId,
        channel: { isThread: () => inThread, parentId: inThread ? parentId : null },
        user: { id: userId }, isAutocomplete: () => false, isButton: () => false, isChatInputCommand: () => true,
        options: { getSubcommand: () => action, getString: (key) => values[key] ?? null },
        reply: async (value) => { if (interaction.deferred) throw Error('Already deferred'); save(value); },
        deferReply: async () => { interaction.deferred = true; },
        editReply: async (value) => { if (!interaction.deferred) throw Error('Not deferred'); save(value); },
      };
      await handler(interaction);
      return response;
    }
    process.send({ type: 'agent-connection-ready' });
    if (existsSync(${JSON.stringify(output)})) {
      writeFileSync(${JSON.stringify(restarted)}, JSON.stringify({
        backend: process.env.AGENT_BACKEND, model: process.env.AGENT_MODEL ?? null,
        effort: process.env.AGENT_EFFORT ?? null, respondToBots: process.env.RESPOND_TO_BOTS_ENABLED,
        workspace: registry.getByName('new-workspace'),
      }));
    } else try {
      const commands = buildSlashCommands(config, []).find(command => command.name === 'backend');
      const subcommands = commands.options.map(option => option.name);
      const models = await slash('models');
      const options = { platform: 'discord', contextKey: 'thread-42', bindingKey: 'work-channel' };
      const before = await ensureSessionWithWorkspace(options);
      const unauthorized = await slash('set', 'work-channel', '555');
      const directUnauthorized = await requestDedicatedAgentSettings({
        name: 'backend', action: 'set', channelId: 'work-channel', userId: '555', backend: 'claude-code'
      }).catch(error => error.message);
      const wrongChannel = await slash('set', 'other-channel');
      const saved = await slash('set');
      const status = await slash('status');
      const after = await ensureSessionWithWorkspace(options);
      const persistedAfterSet = new ProjectCatalog(${JSON.stringify(dataDir)}).agent(${JSON.stringify(agent.id)});
      const wrongChannelReset = await slash('reset', 'other-channel');
      const unauthorizedReset = await slash('reset', 'work-channel', '555');
      const reset = await slash('reset', 'work-channel', '123', false);
      const resetStatus = await slash('status');
      const afterReset = await ensureSessionWithWorkspace(options);
      const resetBackend = resolveAgentBackend(resolver, sessionAgent(afterReset.appSessionId));
      const repeatReset = await slash('reset');
      const globalStatus = await slash('status', 'work-channel', '123', true, 'global');
      const newPath = ${JSON.stringify(newPath)};
      const deniedWorkspace = await interact('workspace', 'set', { name: 'denied', path: newPath },
        { parentId: 'other-channel' });
      const initialWorkspace = await interact('workspace', 'reset', {});
      const setWorkspace = await interact('workspace', 'set', { name: 'new-workspace', path: newPath });
      const newWorkspacePath = (await ensureSessionWithWorkspace(options)).workspace?.path;
      const workspaceList = await interact('workspace', 'list', {});
      const useWorkspace = await interact('workspace', 'use', { name: 'agent' });
      const usedWorkspacePath = (await ensureSessionWithWorkspace(options)).workspace?.path;
      const resetWorkspace = await interact('workspace', 'reset', {});
      const defaultWorkspacePath = (await ensureSessionWithWorkspace(options)).workspace?.path;
      const localBackend = await interact('backend', 'set', { type: 'local-llm' });
      const llmMode = await interact('settings', null, { item: 'llmmode', value: 'chat' });
      const llmEffort = await interact('settings', null, { item: 'llmeffort', value: 'high' });
      const localSnapshot = sessionAgent((await ensureSessionWithWorkspace(options)).appSessionId);
      const resetLlmMode = await interact('settings', null, { item: 'llmmode', value: 'default' });
      const resetLlmEffort = await interact('settings', null, { item: 'llmeffort', value: 'default' });
      const clearedLocalSnapshot = sessionAgent((await ensureSessionWithWorkspace(options)).appSessionId);
      await slash('reset');
      const privateSet = await slash('set', 'work-channel', '123', true, 'global');
      const privateReset = await slash('reset', 'work-channel', '123', true, 'global');
      const respondToBots = await interact('settings', null, { item: 'respondtobots', value: 'on' });
      writeFileSync(${JSON.stringify(output)}, JSON.stringify({
        subcommands, models, unauthorized, directUnauthorized, wrongChannel, saved, status,
        oldBackend: sessionAgent(before.appSessionId)?.backend,
        newBackend: sessionAgent(after.appSessionId)?.backend,
        newSession: before.appSessionId !== after.appSessionId,
        persistedAfterSet, wrongChannelReset, unauthorizedReset, reset, resetStatus, repeatReset,
        globalStatus,
        resetBackend,
        resetWorkspace: afterReset.workspace?.path,
        resetSession: after.appSessionId !== afterReset.appSessionId,
        deniedWorkspace, initialWorkspace, setWorkspace, newWorkspacePath, workspaceList,
        useWorkspace, usedWorkspacePath, resetWorkspaceResult: resetWorkspace, defaultWorkspacePath,
        localBackend, llmMode, llmEffort, localSnapshot, resetLlmMode, resetLlmEffort, clearedLocalSnapshot,
        privateSet, privateReset, respondToBots,
      }));
    } catch (error) {
      writeFileSync(${JSON.stringify(output)}, JSON.stringify({ error: String(error) }));
    }
  `);

  async function startWorker() {
    runtimes = new AgentConnectionRuntimes(dataDir, workdir, registry, {
      entry: worker,
      runtimeSettings: { config, resolver, agentRunner: runner },
    });
    const previous = process.execArgv;
    try {
      process.execArgv = ['--import', createRequire(import.meta.url).resolve('tsx')];
      await runtimes.start();
    } finally {
      process.execArgv = previous;
    }
  }
  await startWorker();

  const result = await vi.waitFor(async () => JSON.parse(await readFile(output, 'utf8')), {
    timeout: 7_000,
  });
  expect(result.reset).toContain('fixture-agent のAI設定を全体設定の継承に戻しました');
  expect(result.subcommands.sort()).toEqual(['models', 'reset', 'set', 'status']);
  expect(result.models).toContain('利用可能なモデル');
  expect(result.models).toContain('fixture-model');
  expect(result).toMatchObject({
    unauthorized: expect.stringContaining('許可されていない'),
    directUnauthorized: expect.stringContaining('許可されていない'),
    wrongChannel: expect.stringContaining('作業チャンネル'),
    saved: expect.stringContaining('fixture-agent のバックエンド設定を保存'),
    status: expect.stringContaining('source: fixture-agent'),
    oldBackend: 'codex',
    newBackend: 'claude-code',
    newSession: true,
    persistedAfterSet: {
      backend: 'claude-code',
      model: 'fixture-model',
      effort: 'high',
      prompt: 'keep instructions',
      workspaceId: workspace.id,
    },
    wrongChannelReset: expect.stringContaining('作業チャンネル'),
    unauthorizedReset: expect.stringContaining('許可されていない'),
    resetStatus: expect.stringContaining('source: fixture-agent'),
    repeatReset: expect.stringContaining('fixture-agent のAI設定を全体設定の継承に戻しました'),
    globalStatus: expect.stringContaining('scope: global'),
    resetBackend: { backend: 'codex', model: 'default-model', effort: 'medium' },
    resetWorkspace: agentPath,
    resetSession: true,
    deniedWorkspace: expect.stringContaining('作業チャンネル'),
    initialWorkspace: expect.stringContaining('次のターンから適用'),
    setWorkspace: expect.stringContaining('次のターンから適用'),
    newWorkspacePath: newPath,
    workspaceList: expect.stringContaining('new-workspace'),
    useWorkspace: expect.stringContaining('次のターンから適用'),
    usedWorkspacePath: agentPath,
    resetWorkspaceResult: expect.stringContaining('次のターンから適用'),
    defaultWorkspacePath: workdir,
    localBackend: expect.stringContaining('保存しました'),
    llmMode: expect.stringContaining('動作モードを chat'),
    llmEffort: expect.stringContaining('保存しました'),
    localSnapshot: { localLlmMode: 'chat', localLlmReasoningEffort: 'high' },
    resetLlmMode: expect.stringContaining('動作モードを 既定'),
    resetLlmEffort: expect.stringContaining('保存しました'),
    privateSet: expect.stringContaining('全体の既定バックエンド設定を保存'),
    privateReset: expect.stringContaining('全体の既定バックエンド設定を保存'),
    respondToBots: expect.stringContaining('永続化済み'),
  });
  expect(result.clearedLocalSnapshot?.localLlmMode).toBeUndefined();
  expect(result.clearedLocalSnapshot?.localLlmReasoningEffort).toBeUndefined();
  expect(registry.getByName('denied')).toBeUndefined();
  expect(registry.getByName('new-workspace')?.path).toBe(newPath);
  expect(result.status).toContain('fixture-model');
  expect(result.status).toContain('effort (設定): high');
  expect(result.resetStatus).toContain('backend: Codex');
  expect(result.resetStatus).toContain('model (設定): default-model');
  expect(result.resetStatus).toContain('effort (設定): medium');
  const persistedAfterReset = new ProjectCatalog(dataDir).agent(agent.id);
  expect(persistedAfterReset).toMatchObject({
    prompt: 'keep instructions',
    workspaceId: 'default',
  });
  expect(persistedAfterReset?.backend).toBeUndefined();
  expect(persistedAfterReset?.model).toBeUndefined();
  expect(persistedAfterReset?.effort).toBeUndefined();
  expect(catalog.agent(other.id)?.backend).toBe('codex');
  expect(resolver.getDefault()).toMatchObject({
    backend: 'codex', model: 'default-model', effort: 'medium',
  });
  expect(process.env.RESPOND_TO_BOTS_ENABLED).toBe('false');
  await runtimes?.stop();
  await startWorker();
  const restored = await vi.waitFor(async () => JSON.parse(await readFile(restarted, 'utf8')), {
    timeout: 7_000,
  });
  expect(restored).toMatchObject({
    backend: 'claude-code', model: null, effort: null, respondToBots: 'true',
    workspace: { id: registry.getByName('new-workspace')?.id, path: newPath },
  });
}, 15_000);
