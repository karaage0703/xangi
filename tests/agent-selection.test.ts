import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ProjectCatalog } from '../src/project-catalog.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { BackendResolver } from '../src/backend-resolver.js';
import type { Config } from '../src/config.js';
import type { AgentRunner } from '../src/agent-runner.js';
import { initSessions, createSession, createSchedulerSession, clearSessions, getSessionEntry, getActiveSessionId, createWebSession, closeSession } from '../src/sessions.js';
import { ensureSessionWithWorkspace } from '../src/session-workspace.js';
import { registerAgentSelection, beginAgentChannelTurn, channelAgentSnapshot, changeChannelAgent, channelAgent, sessionAgent, removeRegisteredAgent } from '../src/agent-selection.js';
import { executeRuntimeSettingsCommand } from '../src/runtime-settings-command.js';
import { initSettings } from '../src/settings.js';
import { updateWebRuntimeSetting, webChannelRuntimeSettingsSnapshot } from '../src/web-runtime-settings.js';
import { selectModelForNextTurn } from '../src/models-command.js';
import { DynamicRunnerManager } from '../src/dynamic-runner.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-selection-'));
  // Session storage does not control BackendResolver's .env persistence path.
  vi.stubEnv('XANGI_ENV_PATH', join(root, '.env'));
  writeFileSync(join(root, '.env'), '');
  initSessions(root);
  initSettings(root);
});
afterEach(() => { clearSessions(); vi.unstubAllEnvs(); rmSync(root, {recursive: true, force: true}); });
async function setup() {
  const catalog = new ProjectCatalog(root);
  const registry = await WorkspaceRegistry.open({dataDir: join(root, 'state'), defaultWorkspacePath: root});
  const path = join(root, 'agent'); mkdirSync(path);
  const workspace = await registry.register('agent', path);
  const busy = vi.fn(() => false);
  const runner = { destroy: vi.fn(), getTimeoutState: () => ({active:false}) } as unknown as AgentRunner;
  registerAgentSelection(root, { catalog, registry, runner, busy });
  vi.stubEnv('ALLOWED_BACKENDS', 'codex,claude-code');
  vi.stubEnv('CHANNEL_OVERRIDES', '{}');
  const config = {agent: {backend:'codex', config:{model:'global-model', workdir:root}, allowedBackends:['codex','claude-code']}, claudeCode:{}} as unknown as Config;
  const resolver = new BackendResolver(config);
  const agent = catalog.saveAgent({name:'Reviewer',role:'Review code',prompt:'Find regressions',backend:'claude-code',workspaceId:workspace.id});
  return {catalog,registry,runner,busy,resolver,agent,workspace,config};
}
it.each(['discord','slack'])('uses an Agent bundle on %s, persists selection and restores previous individual settings', async platform => {
  const f = await setup();
  f.resolver.setChannelOverride('channel', {backend:'codex', model:'channel-model'});
  await f.registry.bind(platform,'channel','default');
  const opts = {registry:f.registry, platform, contextKey:platform === 'slack' ? 'channel:thread' : 'thread',bindingKey:'channel'};
  const old = await ensureSessionWithWorkspace(opts);
  await changeChannelAgent(platform,'channel',f.agent.id);
  expect(getActiveSessionId(opts.contextKey)).toBeUndefined();
  const next = await ensureSessionWithWorkspace(opts);
  expect(next.appSessionId).not.toBe(old.appSessionId);
  expect(next.workspace?.id).toBe(f.workspace.id);
  expect(getSessionEntry(next.appSessionId)?.selectedAgentId).toBe(f.agent.id);
  expect(f.resolver.resolve('channel')).toMatchObject({backend:'claude-code', model:undefined});
  expect(f.resolver.getChannelOverride('channel')?.model).toBe('channel-model');
  expect(()=>f.resolver.setChannelOverride('channel',{backend:'codex'})).toThrow('Agent指定中');
  expect(()=>f.resolver.clearChannelOverride(opts.contextKey)).toThrow('Agent指定中');
  await expect(f.registry.bind(platform,'channel','default')).rejects.toThrow('Agent指定中');
  registerAgentSelection(root, {...f});
  expect(channelAgent(platform,'channel')?.id).toBe(f.agent.id);
  await changeChannelAgent(platform,'channel');
  const restored = await ensureSessionWithWorkspace(opts);
  expect(restored.workspace?.id).toBe('default');
  expect(f.resolver.resolve('channel').model).toBe('channel-model');
  expect(getSessionEntry(old.appSessionId)).toBeDefined();
});
it('rejects a busy switch and deletion of a channel-bound Agent without losing settings', async () => {
  const f = await setup();
  const old = await ensureSessionWithWorkspace({registry:f.registry,platform:'discord',contextKey:'thread',bindingKey:'channel'});
  f.busy.mockReturnValue(true);
  await expect(changeChannelAgent('discord','channel',f.agent.id)).rejects.toThrow('処理中');
  expect(getActiveSessionId('thread')).toBe(old.appSessionId);
  expect(channelAgent('discord','channel')).toBeUndefined();
  f.busy.mockReturnValue(false);
  await changeChannelAgent('discord','channel',f.agent.id);
  expect(()=>removeRegisteredAgent(f.agent.id,f.catalog)).toThrow('discord:channel');
  await changeChannelAgent('discord','channel');
  removeRegisteredAgent(f.agent.id,f.catalog);
  expect(f.catalog.agent(f.agent.id)).toBeUndefined();
});
it('keeps an existing external session bundle consistent when the shared Agent is edited', async () => {
  const f=await setup(); await changeChannelAgent('slack','C1',f.agent.id);
  const opts={registry:f.registry,platform:'slack',contextKey:'C1:1',bindingKey:'C1'};
  const first=await ensureSessionWithWorkspace(opts);
  f.catalog.saveAgent({backend:'codex',workspaceId:'default',prompt:'changed'},f.agent.id);
  const same=await ensureSessionWithWorkspace(opts);
  expect(same.workspace?.id).toBe(f.workspace.id);
  expect(sessionAgent(first.appSessionId)).toMatchObject({backend:'claude-code',prompt:'Review code\n\nFind regressions'});
  closeSession(first.appSessionId);
  const next=await ensureSessionWithWorkspace(opts);
  expect(next.workspace?.id).toBe('default');
  expect(sessionAgent(next.appSessionId)?.backend).toBe('codex');
});
it('shares deletion rules for closed sessions and preserves conversation history', async()=>{
  const f=await setup();const id=createWebSession({selectedAgentId:f.agent.id});
  expect(()=>removeRegisteredAgent(f.agent.id,f.catalog)).toThrow('使用中');
  closeSession(id); removeRegisteredAgent(f.agent.id,f.catalog);
  expect(getSessionEntry(id)?.selectedAgentId).toBeUndefined();
  expect(getSessionEntry(id)).toBeDefined();
});
it('routes real DynamicRunner preparation using the session Agent and its instructions',async()=>{
  const f=await setup();
  f.resolver.setChannelOverride('C1',{backend:'codex',model:'wrong'});
  await changeChannelAgent('slack','C1',f.agent.id);
  const session=await ensureSessionWithWorkspace({registry:f.registry,platform:'slack',contextKey:'C1:1',bindingKey:'C1'});
  const manager=new DynamicRunnerManager(f.config,f.resolver);
  const run=vi.fn(async()=>({result:'ok',sessionId:'new-provider'}));
  const getRunner=vi.spyOn(manager as any,'getRunner').mockReturnValue({run});
  await manager.run('hello',{appSessionId:session.appSessionId,channelId:'C1:1',settingsChannelId:'C1',workdir:session.workspace!.path,platform:'slack'});
  expect(getRunner.mock.calls[0][1]).toMatchObject({backend:'claude-code',model:undefined});
  expect(run.mock.calls[0][0]).toContain('Find regressions');
  expect(run.mock.calls[0][1]).toMatchObject({workdir:f.workspace.path});
  manager.shutdown();
});
it('runtime setting selects and clears a channel Agent, rejects unknown IDs',async()=>{
  const f=await setup();const request={name:'agent',platform:'discord',channelId:'channel'};
  await expect(executeRuntimeSettingsCommand({...request,action:'set',value:'missing'},{resolver:f.resolver})).rejects.toThrow('見つかりません');
  expect(await executeRuntimeSettingsCommand({...request,action:'set',value:f.agent.id},{resolver:f.resolver})).toContain('Reviewer');
  expect(await executeRuntimeSettingsCommand({...request,action:'reset'},{resolver:f.resolver})).toContain('担当なし');
});

it('rejects switches while workspace resolution or a scheduler run is starting', async () => {
  const f=await setup(); const release=beginAgentChannelTurn('discord','channel');
  await expect(changeChannelAgent('discord','channel',f.agent.id)).rejects.toThrow('処理中');
  release(); await changeChannelAgent('discord','channel',f.agent.id);
  const snapshot=await channelAgentSnapshot('discord','channel',f.registry);
  createSchedulerSession('job','channel',{platform:'discord',title:'task',...snapshot});
  expect(getActiveSessionId('channel')).toBeUndefined();
  expect(sessionAgent('job')).toMatchObject({backend:'claude-code',prompt:'Review code\n\nFind regressions'});
  expect(getSessionEntry('job')?.workspacePath).toBe(f.workspace.path);
  f.busy.mockReturnValue(true);
  await expect(changeChannelAgent('discord','channel')).rejects.toThrow('処理中');
});

it('retires persistent runners even when only completed scheduler sessions reference the channel',async()=>{
  const f=await setup(); await changeChannelAgent('slack','channel',f.agent.id);
  createSchedulerSession('old-job','channel',{platform:'slack',title:'task',...await channelAgentSnapshot('slack','channel',f.registry)});
  closeSession('old-job');
  await changeChannelAgent('slack','channel');
  expect(f.runner.destroy).toHaveBeenCalledWith('channel');
  expect(getSessionEntry('old-job')).toBeDefined();
});

it('retires a legacy Discord thread provider before selecting its parent Agent',async()=>{
  const f=await setup(); const previous=createSession('legacy-thread',{platform:'discord',workspaceId:'default',workspacePath:root});
  await changeChannelAgent('discord','parent',f.agent.id);
  const next=await ensureSessionWithWorkspace({registry:f.registry,platform:'discord',contextKey:'legacy-thread',bindingKey:'parent'});
  expect(next.appSessionId).not.toBe(previous);
  expect(f.runner.destroy).toHaveBeenCalledWith('legacy-thread');
  expect(getSessionEntry(next.appSessionId)?.selectedAgentId).toBe(f.agent.id);
});

it('does not persist a selection whose backend is unavailable',async()=>{
  const f=await setup(); vi.spyOn(f.resolver,'isBackendSelectable').mockReturnValue(false);
  await expect(executeRuntimeSettingsCommand({name:'agent',platform:'discord',channelId:'channel',action:'set',value:f.agent.id},{resolver:f.resolver})).rejects.toThrow('利用できません');
  expect(channelAgent('discord','channel')).toBeUndefined();
});


it.each(['discord', 'slack'])('binds the reserved default agent on %s and restores individual settings on reset', async platform => {
  const f = await setup();
  f.resolver.setChannelOverride('C-default', { backend: 'claude-code', model: 'channel-model' });
  expect(readFileSync(join(root, '.env'), 'utf8')).toContain(
    'CHANNEL_OVERRIDES={"C-default":{"backend":"claude-code","model":"channel-model"}}'
  );
  await changeChannelAgent(platform, 'C-default', 'xangi:default');
  expect(channelAgent(platform, 'C-default')).toMatchObject({ id: 'xangi:default', workspaceId: 'default' });
  const snapshot = await channelAgentSnapshot(platform, 'C-default');
  expect(snapshot).toMatchObject({ workspaceId: 'default', workspacePath: root, selectedAgentId: 'xangi:default' });
  expect(f.resolver.resolve('C-default')).toMatchObject({ backend: 'codex', model: 'global-model' });
  registerAgentSelection(root, { catalog: f.catalog, registry: f.registry, runner: f.runner, busy: f.busy });
  expect(channelAgent(platform, 'C-default')?.id).toBe('xangi:default');
  await expect(changeChannelAgent(platform, 'other', 'xangi:default')).rejects.toThrow('最大1つ');
  f.busy.mockReturnValue(true);
  await expect(changeChannelAgent(platform, 'C-default')).rejects.toThrow('処理中');
  f.busy.mockReturnValue(false);
  await changeChannelAgent(platform, 'C-default');
  expect(channelAgent(platform, 'C-default')).toBeUndefined();
  expect(f.resolver.resolve('C-default')).toMatchObject({ backend: 'claude-code', model: 'channel-model' });
});

it('uses the renamed default workspace for new unassigned conversations and preserves channel overrides', async () => {
  const f = await setup();
  const first = await ensureSessionWithWorkspace({ registry: f.registry, platform: 'discord', contextKey: 'old', bindingKey: 'old' });
  f.catalog.saveDefaultAgent({ name: 'borot', workspaceId: f.workspace.id });
  expect(() => removeRegisteredAgent('xangi:default', f.catalog)).toThrow('削除できません');
  const next = await ensureSessionWithWorkspace({ registry: f.registry, platform: 'discord', contextKey: 'new', bindingKey: 'new' });
  expect(next.workspace?.id).toBe(f.workspace.id);
  const old = await ensureSessionWithWorkspace({ registry: f.registry, platform: 'discord', contextKey: 'old', bindingKey: 'old' });
  expect(old.workspace?.id).toBe('default');
  expect(old.appSessionId).toBe(first.appSessionId);
  await f.registry.bind('discord', 'override', 'default');
  const override = await ensureSessionWithWorkspace({ registry: f.registry, platform: 'discord', contextKey: 'override', bindingKey: 'override' });
  expect(override.workspace?.id).toBe('default');
  await changeChannelAgent('discord', 'bound', 'xangi:default');
  expect(channelAgent('discord', 'bound')?.name).toBe('borot');
});

it.each(['discord', 'slack'])('applies Projects only to explicit %s conversations and retains their snapshots', async platform => {
  const f = await setup();
  const opts = { registry: f.registry, platform, contextKey: 'old-thread', bindingKey: 'channel' };
  const old = await ensureSessionWithWorkspace(opts);
  const project = f.catalog.create({ name: 'Project', prompt: 'Shared instructions', defaultAgentId: f.agent.id });
  expect((await ensureSessionWithWorkspace(opts)).appSessionId).toBe(old.appSessionId);
  expect(getSessionEntry(old.appSessionId)?.projectId).toBeUndefined();
  const fresh = await ensureSessionWithWorkspace({ ...opts, contextKey: 'new-thread', project });
  expect(getSessionEntry(fresh.appSessionId)).toMatchObject({ projectId: project.id, selectedAgentId: f.agent.id, workspaceId: f.workspace.id });
  expect(sessionAgent(fresh.appSessionId)?.prompt).toBe('Shared instructions\n\nReview code\n\nFind regressions');
  f.catalog.update(project.id, { prompt: 'Changed', defaultAgentId: null });
  expect((await ensureSessionWithWorkspace({ ...opts, contextKey: 'new-thread' })).appSessionId).toBe(fresh.appSessionId);
  expect(sessionAgent(fresh.appSessionId)?.prompt).toContain('Shared instructions');
  expect(getSessionEntry((await ensureSessionWithWorkspace({ ...opts, contextKey: 'after-unlink' })).appSessionId)?.projectId).toBeUndefined();
});

it('keeps a project Team attached across turns and excludes secret sessions', async () => {
  const f = await setup();
  const team = f.catalog.saveTeam({ name: 'Review team', members: [{ agentId: f.agent.id, role: 'Review', dependsOn: [] }] });
  const project = f.catalog.create({ name: 'Project', defaultAgentId: `team:${team.id}` });
  const opts = { registry: f.registry, platform: 'discord', contextKey: 'team-thread', bindingKey: 'channel' };
  const first = await ensureSessionWithWorkspace({ ...opts, project });
  expect(getSessionEntry(first.appSessionId)?.projectId).toBe(project.id);
  expect(sessionAgent(first.appSessionId)?.team?.id).toBe(team.id);
  expect((await ensureSessionWithWorkspace(opts)).appSessionId).toBe(first.appSessionId);
  const secret = await ensureSessionWithWorkspace({ ...opts, contextKey: 'secret-thread', secret: true });
  expect(getSessionEntry(secret.appSessionId)?.projectId).toBeUndefined();
});

it('creates a Discord thread from Web and resolves its Project before the first turn', async () => {
  const { registerDiscordMessageHandlers } = await import('../src/discord/message-handler.js');
  const f = await setup();
  const project = f.catalog.create({ name: 'Development', defaultAgentId: f.agent.id });
  const create = vi.fn().mockResolvedValue({ id: 'new-discord-thread' });
  const fetch = vi.fn().mockResolvedValue({ type: 0, threads: { create } });
  const bridge = registerDiscordMessageHandlers({ client: { on: vi.fn(), channels: { fetch } } as never, config: { ...f.config, discord: {} } as Config, agentRunner: f.runner, workdir: root, workspaceRegistry: f.registry });
  const { sessionId } = await bridge.createSession!('parent', 'Development', project);
  expect(create).toHaveBeenCalledExactlyOnceWith({ name: 'Development', autoArchiveDuration: 1440 });
  expect(getSessionEntry(sessionId)).toMatchObject({ platform: 'discord', title: '', contextKey: 'new-discord-thread', projectId: project.id, selectedAgentId: f.agent.id });
  fetch.mockResolvedValueOnce({ type: 2, threads: { create } });
  await expect(bridge.createSession!('voice', 'Wrong')).rejects.toThrow('テキストチャンネル');
  expect(create).toHaveBeenCalledTimes(1);
});

it.each(['discord', 'slack'])('dedicated %s Bot pins its Agent and workspace across channels and scheduler snapshots', async platform => {
  const f = await setup();
  vi.stubEnv('XANGI_CONNECTION_AGENT_ID', f.agent.id);
  const first = await ensureSessionWithWorkspace({registry:f.registry,platform,contextKey:'thread-one',bindingKey:'same-channel'});
  const second = await ensureSessionWithWorkspace({registry:f.registry,platform,contextKey:'thread-two',bindingKey:'other-channel'});
  expect(getSessionEntry(first.appSessionId)).toMatchObject({selectedAgentId:f.agent.id,workspacePath:f.workspace.path,selectedAgentConfig:{prompt:f.agent.prompt}});
  expect(getSessionEntry(second.appSessionId)?.selectedAgentId).toBe(f.agent.id);
  expect(await channelAgentSnapshot(platform,'schedule-channel')).toMatchObject({selectedAgentId:f.agent.id,workspacePath:f.workspace.path});
  await expect(changeChannelAgent(platform,'same-channel')).rejects.toThrow('専用Bot');
  expect(f.resolver.resolve('thread-one').backend).toBe('claude-code');
});

it.each(['discord', 'slack'] as const)(
  'saves channel runtime edits to the assigned Agent on %s and refreshes the next turn',
  async (platform) => {
    const f = await setup();
    const deps = { ...f, agentRunner: f.runner, workspaceRegistry: f.registry };
    const channelId = 'channel';
    f.resolver.setChannelOverride(channelId, { backend: 'codex', model: 'channel-model' });
    await f.registry.bind(platform, channelId, f.workspace.id);
    await changeChannelAgent(platform, channelId, f.agent.id);
    const opts = { platform, contextKey: 'channel:thread', bindingKey: channelId };
    const before = await ensureSessionWithWorkspace(opts);
    f.busy.mockReturnValue(true);

    const request = { platform, channelId };
    await executeRuntimeSettingsCommand(
      { ...request, name: 'backend', action: 'set', backend: 'codex', model: 'agent-model' },
      deps
    );
    await updateWebRuntimeSetting(
      { ...request, name: 'workspace', action: 'set', value: 'default' },
      deps
    );
    expect(getActiveSessionId(opts.contextKey)).toBe(before.appSessionId);
    expect(sessionAgent(before.appSessionId)?.backend).toBe('claude-code');
    expect(f.runner.destroy).not.toHaveBeenCalled();
    expect(new ProjectCatalog(root).agent(f.agent.id)).toMatchObject({
      backend: 'codex', model: 'agent-model', workspaceId: 'default',
    });
    expect(webChannelRuntimeSettingsSnapshot(platform, channelId,
      { ...f.config, discord: {}, slack: {} } as Config, f.resolver, f.registry)).toMatchObject({
      backend: { value: 'codex', model: 'agent-model' }, workspace: { value: 'default' },
    });

    f.busy.mockReturnValue(false);
    const after = await ensureSessionWithWorkspace(opts);
    expect(after.appSessionId).not.toBe(before.appSessionId);
    expect(after.workspace?.path).toBe(root);
    expect(sessionAgent(after.appSessionId)).toMatchObject({
      backend: 'codex', model: 'agent-model', prompt: f.agent.prompt,
    });
    expect(getSessionEntry(before.appSessionId)?.lifecycle).toBe('closed');
    expect(f.registry.getBinding(platform, channelId)).toBe(f.workspace.id);
    expect(f.resolver.getChannelOverride(channelId)?.model).toBe('channel-model');

    await selectModelForNextTurn(
      { ...request, backend: 'codex', model: 'tool-model', effort: 'high' },
      f.resolver,
      async (backend) => ({
        backend, source: 'fixture', status: 'available',
        models: [{ id: 'tool-model', supportedEfforts: ['high'] }],
      })
    );
    expect(f.catalog.agent(f.agent.id)).toMatchObject({ model: 'tool-model', effort: 'high' });
    await executeRuntimeSettingsCommand({ ...request, name: 'backend', action: 'reset' }, deps);
    expect(f.catalog.agent(f.agent.id)?.backend).toBeUndefined();
    expect(f.resolver.getChannelOverride(channelId)?.model).toBe('channel-model');
  }
);

it('updates the bound default Agent workspace without saving separate AI defaults', async () => {
  const f = await setup();
  const deps = { ...f, agentRunner: f.runner, workspaceRegistry: f.registry };
  const request = { platform: 'discord', channelId: 'default-channel' };
  await changeChannelAgent('discord', request.channelId, 'xangi:default');
  const opts = { platform: 'discord', contextKey: 'default-thread', bindingKey: request.channelId };
  const before = await ensureSessionWithWorkspace(opts);

  await updateWebRuntimeSetting(
    { ...request, name: 'workspace', action: 'set', value: f.workspace.id },
    deps
  );
  const next = await ensureSessionWithWorkspace(opts);
  expect(next.appSessionId).not.toBe(before.appSessionId);
  expect(next.workspace?.id).toBe(f.workspace.id);
  await expect(executeRuntimeSettingsCommand(
    { ...request, name: 'backend', action: 'set', backend: 'claude-code' },
    deps
  )).rejects.toThrow('全体設定');
  expect(f.resolver.getDefault().backend).toBe('codex');
});
