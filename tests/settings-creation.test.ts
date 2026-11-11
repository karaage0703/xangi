import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { ProjectCatalog } from '../src/project-catalog.js';
import { AgentRunStore } from '../src/agent-runs.js';
import { executeWorkspaceCommand, executeProjectAgentCommand, executeTeamCommand } from '../src/project-agent-command.js';
import { clearSessions, initSessions, createWebSession } from '../src/sessions.js';

const roots: string[] = [];
afterEach(async () => {
  clearSessions();
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'settings-creation-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  const dataDir = join(workspace, 'state');
  await mkdir(workspace); await mkdir(outside);
  initSessions(dataDir);
  const workspaces = await WorkspaceRegistry.open({dataDir, defaultWorkspacePath: workspace});
  const catalog = new ProjectCatalog(dataDir);
  const runs = AgentRunStore.fromDataDir(dataDir);
  const start = vi.fn();
  return {root, workspace, outside, dataDir, deps: {workspaces, catalog, runs, start}};
}

it('uses Settings path restrictions and keeps successful registrations after a later failure', async () => {
  const f = await fixture();
  const context = {channelId: 'parent'};
  const flags = {action: 'create', name: '資料用', path: f.workspace};
  const created = JSON.parse(await executeWorkspaceCommand(flags, context, f.deps));
  const outside = JSON.parse(await executeWorkspaceCommand({...flags, name: '外部', path: f.outside}, context, f.deps));
  expect(outside.workspace.path).toBe(f.outside);
  for (const path of [f.dataDir, 'relative', join(f.workspace, 'missing')]) {
    await expect(executeWorkspaceCommand({...flags, name: 'invalid', path}, context, f.deps)).rejects.toThrow();
  }
  expect(f.deps.workspaces.list()).toContainEqual(created.workspace);
  expect(JSON.parse(await executeWorkspaceCommand(flags, context, f.deps))).toEqual(created);
  await expect(executeWorkspaceCommand(flags, context, {...f.deps, workspaceSwitching: false})).rejects.toThrow('disabled');
  await expect(executeProjectAgentCommand({action: 'create', name: '担当', 'workspace-id': 'default'}, context, {...f.deps, workspaceSwitching: false})).rejects.toThrow('disabled');
  expect(f.deps.start).not.toHaveBeenCalled();
});

it('rejects workspace creation without a parent conversation or from a delegated worker', async () => {
  const f = await fixture();
  const flags = {action: 'create', name: '資料用', path: f.workspace};
  await expect(executeWorkspaceCommand(flags, undefined, f.deps)).rejects.toThrow('現在の会話');
  const appSessionId = createWebSession({});
  f.deps.runs.create({task: 'work', backend: 'codex', workspaceId: 'default', workspacePath: f.workspace, appSessionId, parentContextKey: 'parent'});
  await expect(executeWorkspaceCommand(flags, {channelId: `web-chat:${appSessionId}`}, f.deps)).rejects.toThrow('子エージェント');
  expect(f.deps.workspaces.list()).toHaveLength(1);
});

it('rejects malformed team options without saving or starting work', async () => {
  const f = await fixture();
  const flags = {action: 'create', name: '資料チーム', 'members-json': '[{"agentId":"xangi:default"}]'};
  for (const extra of [
    {'members-json': 'invalid'}, {'members-json': '{}'}, {'members-json': '[]'},
    {'members-json': '[{"agentId":"missing"}]'},
    {'members-json': '[{"agentId":"xangi:default","memberId":"a"},{"agentId":"xangi:default","memberId":"a"}]'},
    {'leader-agent-id': 'missing'}, {'max-concurrency': '0'}, {'serialize-workspaces': 'sometimes'},
  ]) {
    await expect(executeTeamCommand({...flags, ...extra}, {channelId: 'parent'}, f.deps)).rejects.toThrow();
  }
  expect(f.deps.catalog.teams()).toEqual([]);
  expect(f.deps.start).not.toHaveBeenCalled();
});


it('deletes Team, Agent and Workspace in dependency order, retaining files and persistence', async () => {
  const f = await fixture();
  const context = {channelId: 'parent'};
  const path = join(f.workspace, 'writing');
  await mkdir(path);
  await writeFile(join(path, 'keep.txt'), 'keep');
  const workspace = await f.deps.workspaces.register('writing', path);
  const agent = f.deps.catalog.saveAgent({name: 'Writer', workspaceId: workspace.id, prompt: 'write'});
  const team = f.deps.catalog.saveTeam({name: 'Writing', members: [{agentId: agent.id}], prompt: ''});
  await expect(executeWorkspaceCommand({action: 'delete', workspace: workspace.id}, context, f.deps)).rejects.toThrow('使用中');
  await expect(executeProjectAgentCommand({action: 'delete', agent: agent.id}, context, f.deps)).rejects.toThrow('Team');
  expect(JSON.parse(await executeTeamCommand({action: 'delete', team: team.name}, context, f.deps))).toMatchObject({ok: true, team: {id: team.id}});
  expect(f.deps.catalog.agent(agent.id)).toBeDefined();
  await executeProjectAgentCommand({action: 'delete', agent: agent.id}, context, f.deps);
  expect(JSON.parse(await executeWorkspaceCommand({action: 'delete', workspace: workspace.id}, context, f.deps))).toMatchObject({ok: true, filesPreserved: true});
  expect(await readFile(join(path, 'keep.txt'), 'utf8')).toBe('keep');
  const reopened = await WorkspaceRegistry.open({dataDir: f.dataDir, defaultWorkspacePath: f.workspace});
  expect(reopened.getById(workspace.id)).toBeUndefined();
  expect(new ProjectCatalog(f.dataDir).team(team.id)).toBeUndefined();
  expect(new ProjectCatalog(f.dataDir).agent(agent.id)).toBeUndefined();
});

it('rejects default, unknown, session-referenced and channel-bound Workspace deletion', async () => {
  const f = await fixture();
  const context = {channelId: 'parent'};
  const remove = (id: string) => executeWorkspaceCommand({action: 'delete', workspace: id}, context, f.deps);
  await expect(remove('default')).rejects.toThrow('default');
  await expect(remove('missing')).rejects.toThrow('見つかりません');
  await expect(remove('')).rejects.toThrow('ID');
  const workspace = await f.deps.workspaces.register('extra', f.workspace);
  await f.deps.workspaces.bind('discord', 'channel', workspace.id);
  await expect(remove(workspace.id)).rejects.toThrow('binding');
  await f.deps.workspaces.resetBinding('discord', 'channel');
  createWebSession({workspaceId: workspace.id, workspacePath: f.workspace});
  await expect(remove(workspace.id)).rejects.toThrow('会話');
  expect(f.deps.workspaces.getById(workspace.id)).toBeDefined();
});

it('rejects deletion without conversation and by delegated workers, and preserves active Teams', async () => {
  const f = await fixture();
  const team = f.deps.catalog.saveTeam({name: 'Keep', members: [{agentId: 'xangi:default'}], prompt: ''});
  const workspace = await f.deps.workspaces.register('extra', f.workspace);
  const w = {action: 'delete', workspace: workspace.id};
  const t = {action: 'delete', team: team.id};
  await expect(executeWorkspaceCommand(w, undefined, f.deps)).rejects.toThrow('現在の会話');
  await expect(executeTeamCommand(t, undefined, f.deps)).rejects.toThrow('現在の会話');
  const appSessionId = createWebSession({});
  f.deps.runs.create({task: 'work', backend: 'codex', workspaceId: 'default', workspacePath: f.workspace, appSessionId, parentContextKey: 'parent', teamId: team.id});
  const child = {channelId: `web-chat:${appSessionId}`};
  await expect(executeWorkspaceCommand(w, child, f.deps)).rejects.toThrow('子エージェント');
  await expect(executeTeamCommand(t, child, f.deps)).rejects.toThrow('子エージェント');
  await expect(executeTeamCommand(t, {channelId: 'parent'}, f.deps)).rejects.toThrow('使用中');
  await expect(executeTeamCommand({...t, team: 'missing'}, {channelId: 'parent'}, f.deps)).rejects.toThrow('見つかりません');
  expect(f.deps.catalog.team(team.id)).toBeDefined();
  expect(f.deps.workspaces.getById(workspace.id)).toBeDefined();
});

it('preserves a Team selected by an open conversation', async () => {
  const f = await fixture();
  const team = f.deps.catalog.saveTeam({name: 'Keep', members: [{agentId: 'xangi:default'}], prompt: ''});
  createWebSession({selectedAgentId: `team:${team.id}`});
  await expect(executeTeamCommand({action: 'delete', team: team.id}, {channelId: 'parent'}, f.deps)).rejects.toThrow('使用中');
  expect(f.deps.catalog.team(team.id)).toBeDefined();
});
