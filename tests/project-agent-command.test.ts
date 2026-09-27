import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ProjectCatalog } from '../src/project-catalog.js';
import { AgentRunStore } from '../src/agent-runs.js';
import { executeProjectAgentCommand } from '../src/project-agent-command.js';
import { initSessions, createWebSession } from '../src/sessions.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delegation-'));
  initSessions(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function setup() {
  const catalog = new ProjectCatalog(root);
  const runs = AgentRunStore.fromDataDir(root);
  const writer = catalog.saveAgent({ name: 'Writer', prompt: 'write' });
  const reviewer = catalog.saveAgent({
    name: 'Reviewer',
    role: 'review code',
    prompt: 'check bugs',
    backend: 'codex',
  });
  const project = catalog.create({
    name: 'Work',
    prompt: 'shared context',
  });
  const parent = `web-chat:${createWebSession({ projectId: project.id, selectedAgentId: writer.id })}`;
  const start = vi.fn(async (body: Record<string, unknown>) =>
    runs.create({
      ...body,
      task: String(body.task),
      backend: 'codex',
      workspaceId: 'default',
      workspacePath: root,
      appSessionId: createWebSession({}),
    })
  );
  const deps = { catalog, runs, start };
  const call = (flags: Record<string, string>, channelId = parent) =>
    executeProjectAgentCommand(flags, { channelId }, deps).then(JSON.parse);
  return { catalog, runs, writer, reviewer, project, parent, start, call };
}
it('discovers all agents without loading their full prompts, and returns persisted results', async () => {
  const { catalog, reviewer, call, start, runs } = setup();
  catalog.saveAgent({ name: 'Outside', prompt: 'private instructions' });
  const list = await call({ action: 'list' });
  expect(list.agents).toHaveLength(3);
  expect(list.agents[1]).toMatchObject({ description: 'review code' });
  expect(JSON.stringify(list)).not.toContain('check bugs');
  const run = await call({ action: 'run', agent: reviewer.id, task: 'review the patch' });
  expect(start.mock.calls[0][0]).toMatchObject({
    agentId: reviewer.id,
    backend: 'codex',
    instruction: 'review code\n\ncheck bugs',
  });
  expect(start.mock.calls[0][0].instruction).not.toContain('xangi agent');
  runs.markSucceeded(run.id, { result: 'found a bug', sessionId: 'provider' });
  expect(await call({ action: 'wait', id: run.id })).toMatchObject({
    status: 'succeeded',
    result: 'found a bug',
  });
  expect(AgentRunStore.fromDataDir(root).get(run.id)?.projectId).toBeUndefined();
});
it('rejects unknown agents, self-delegation, duplicate work, other-parent result access and nested delegation', async () => {
  const { writer, reviewer, call, runs } = setup();
  await expect(call({ action: 'run', agent: 'outside', task: 'test' })).rejects.toThrow(
    '見つかりません'
  );
  await expect(call({ action: 'run', agent: writer.id, task: 'test' })).rejects.toThrow('自分');
  const run = await call({ action: 'run', agent: reviewer.id, task: 'test' });
  await expect(call({ action: 'run', agent: reviewer.id, task: 'test' })).rejects.toThrow('実行中');
  await expect(call({ action: 'status', id: run.id }, 'other-parent')).rejects.toThrow(
    '見つかりません'
  );
  await expect(call({ action: 'list' }, `web-chat:${run.appSessionId}`)).rejects.toThrow('再委譲');
  runs.markFailed(run.id, new Error('backend unavailable'));
  expect(await call({ action: 'wait', id: run.id })).toMatchObject({
    status: 'failed',
    error: 'backend unavailable',
  });
});
it('rejects cross-project access and missing tasks before creating a child', async () => {
  const { reviewer, call, start } = setup();
  await expect(call({ action: 'list', project: 'other' })).rejects.toThrow('不要');
  await expect(call({ action: 'run', agent: reviewer.id })).rejects.toThrow('task');
  expect(start).not.toHaveBeenCalled();
});

it('uses the child workspace instead of the parent snapshot or project workspace', async () => {
  const { catalog, project, reviewer, start, call } = setup();
  const parent = createWebSession({
    projectId: project.id,
    workspaceId: 'original',
    workspacePath: '/original',
  });
  catalog.update(project.id, { workspaceId: 'changed' });
  catalog.saveAgent({ workspaceId: 'child-workspace' }, reviewer.id);
  await call({ action: 'run', agent: reviewer.id, task: 'work' }, `web-chat:${parent}`);
  expect(start.mock.calls[0][0]).toMatchObject({
    workspaceId: 'child-workspace',
  });
  expect(start.mock.calls[0][0].workspacePath).toBeUndefined();
});

it('creates a development agent in its own existing workspace without changing the current project', async () => {
  const { catalog, runs, project, parent, start } = setup();
  const parentPath = join(root, 'parent');
  const childPath = join(root, 'child');
  mkdirSync(parentPath);
  mkdirSync(childPath);
  const workspaces = await WorkspaceRegistry.open({
    dataDir: join(root, 'state'),
    defaultWorkspacePath: parentPath,
  });
  const created = JSON.parse(
    await executeProjectAgentCommand(
      { action: 'create', name: 'Developer', workspace: childPath, role: 'implement code' },
      { channelId: parent },
      { catalog, runs, start, workspaces }
    )
  );
  expect(created.agent).toMatchObject({ name: 'Developer', workspaceId: created.workspace.id });
  expect(created.workspace.path).toBe(childPath);
  expect(catalog.get(project.id)).not.toHaveProperty('agentIds');
  await expect(
    executeProjectAgentCommand(
      { action: 'create', name: 'Wrong', workspace: parentPath },
      { channelId: parent },
      { catalog, runs, start, workspaces }
    )
  ).rejects.toThrow('親Workspaceの外');
  await executeProjectAgentCommand(
    { action: 'run', agent: created.agent.id, task: 'implement' },
    { channelId: parent },
    { catalog, runs, start, workspaces }
  );
  expect(start.mock.calls.at(-1)?.[0].workspaceId).toBe(created.workspace.id);
});

it('rejects creating a child in the Discord parent non-default workspace', async () => {
  const { catalog, runs, start } = setup();
  const defaultPath = join(root, 'default');
  const parentPath = join(root, 'discord-parent');
  const nestedPath = join(parentPath, 'nested-child');
  mkdirSync(defaultPath);
  mkdirSync(parentPath);
  mkdirSync(nestedPath);
  const workspaces = await WorkspaceRegistry.open({
    dataDir: join(root, 'state'),
    defaultWorkspacePath: defaultPath,
  });
  const parentWorkspace = await workspaces.register('discord-parent', parentPath);
  const channelId = '123456789012345678';
  await workspaces.bind('discord', channelId, parentWorkspace.id);
  const agentsBefore = catalog.agents();
  const projectsBefore = catalog.list();
  const workspacesBefore = workspaces.list();

  await expect(
    executeProjectAgentCommand(
      {
        action: 'create',
        name: 'Developer',
        workspace: parentPath,
      },
      { channelId, platform: 'discord' },
      { catalog, runs, start, workspaces }
    )
  ).rejects.toThrow('親Workspaceの外');
  await expect(
    executeProjectAgentCommand(
      {
        action: 'create',
        name: 'Nested',
        workspace: nestedPath,
      },
      { channelId, platform: 'discord' },
      { catalog, runs, start, workspaces }
    )
  ).rejects.toThrow('親Workspaceの外');
  expect(catalog.agents()).toEqual(agentsBefore);
  expect(catalog.list()).toEqual(projectsBefore);
  expect(workspaces.list()).toEqual(workspacesBefore);
  expect(start).not.toHaveBeenCalled();
});

it('creates and calls an agent outside Web Chat without a project', async () => {
  const { catalog, runs, start } = setup();
  const parentPath = join(root, 'parent');
  const childPath = join(root, 'child');
  mkdirSync(parentPath);
  mkdirSync(childPath);
  const workspaces = await WorkspaceRegistry.open({
    dataDir: join(root, 'state'),
    defaultWorkspacePath: parentPath,
  });
  const channelId = 'discord:development-thread';
  const deps = { catalog, runs, start, workspaces };
  const created = JSON.parse(
    await executeProjectAgentCommand(
      {
        action: 'create',
        name: 'Developer',
        workspace: childPath,
      },
      { channelId },
      deps
    )
  );
  expect(created).not.toHaveProperty('project');
  expect(catalog.list()).toHaveLength(1);
  expect(
    JSON.parse(await executeProjectAgentCommand({ action: 'list' }, { channelId }, deps)).agents
  ).toHaveLength(3);
  await executeProjectAgentCommand(
    { action: 'run', agent: created.agent.id, task: 'implement' },
    { channelId },
    deps
  );
  expect(start.mock.calls.at(-1)?.[0]).toMatchObject({
    agentId: created.agent.id,
    workspaceId: created.workspace.id,
  });
  await expect(
    executeProjectAgentCommand(
      { action: 'create', name: 'Developer', workspace: childPath },
      { channelId },
      deps
    )
  ).rejects.toThrow('既にあります');
});

it('lists all agents without a conversation or project', async () => {
  const { catalog, runs, start, writer, reviewer } = setup();
  const result = JSON.parse(
    await executeProjectAgentCommand({ action: 'list' }, undefined, { catalog, runs, start })
  );
  expect(result.agents.map((agent: { id: string }) => agent.id)).toEqual([writer.id, reviewer.id]);
  expect(result).not.toHaveProperty('project');
});
