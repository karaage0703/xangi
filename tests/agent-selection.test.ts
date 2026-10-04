import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
import { DynamicRunnerManager } from '../src/dynamic-runner.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agent-selection-')); initSessions(root); });
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
