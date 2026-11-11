import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ProjectCatalog } from '../src/project-catalog.js';
import { AgentRunStore } from '../src/agent-runs.js';
import { executeProjectAgentCommand } from '../src/project-agent-command.js';
import { initSessions, createWebSession, getSessionEntry } from '../src/sessions.js';
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
    model: 'gpt-6.1-sol',
    effort: 'high',
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

it('updates an agent name and workspace while preserving IDs, references and existing sessions', async () => {
  const { catalog, runs, reviewer, parent, start, call, project } = setup();
  catalog.update(project.id, { defaultAgentId: reviewer.id });
  const team = catalog.saveTeam({ name: 'Editors', members: [{ agentId: reviewer.id }] });
  const existing = createWebSession({
    selectedAgentId: reviewer.id,
    workspaceId: 'default',
    workspacePath: root,
  });
  const workspaces = await WorkspaceRegistry.open({
    dataDir: join(root, 'state'),
    defaultWorkspacePath: root,
  });
  const path = join(root, 'new');
  mkdirSync(path);
  const workspace = await workspaces.register('New', path);
  const result = JSON.parse(
    await executeProjectAgentCommand(
      { action: 'update', agent: reviewer.id, name: '情報整理', 'workspace-id': workspace.id },
      { channelId: parent },
      { catalog, runs, start, workspaces }
    )
  );
  expect(result).toMatchObject({
    agent: {
      ...JSON.parse(JSON.stringify(reviewer)),
      name: '情報整理',
      workspaceId: workspace.id,
      updatedAt: expect.any(String),
    },
    existingSessionsPreserved: true,
  });
  expect(JSON.parse(JSON.stringify(new ProjectCatalog(root).agent(reviewer.id)))).toEqual(
    result.agent
  );
  expect(catalog.get(project.id)?.defaultAgentId).toBe(reviewer.id);
  expect(catalog.team(team.id)).toEqual(team);
  expect(getSessionEntry(existing)).toMatchObject({
    selectedAgentId: reviewer.id,
    workspacePath: root,
    workspaceId: 'default',
  });
  await call({ action: 'run', agent: reviewer.id, task: 'work' });
  expect(start.mock.calls.at(-1)?.[0]).toMatchObject({
    agentId: reviewer.id,
    workspaceId: workspace.id,
  });
});

it('renames without a workspace registry and supports the reserved default ID', async () => {
  const { catalog, reviewer, call } = setup();
  expect(await call({ action: 'update', agent: reviewer.id, name: 'Reader' })).toMatchObject({
    agent: { id: reviewer.id, name: 'Reader', prompt: reviewer.prompt, backend: reviewer.backend },
  });
  expect(await call({ action: 'update', agent: 'default', name: 'Assistant' })).toMatchObject({
    agent: { id: 'xangi:default', name: 'Assistant' },
  });
  expect(catalog.defaultAgent().name).toBe('Assistant');
  expect(await call({ action: 'update', agent: 'xangi:default', name: 'borot' })).toMatchObject({
    agent: { id: 'xangi:default', name: 'borot' },
  });
});

it('rejects invalid edits without changing the catalog or creating unknown agents', async () => {
  const { catalog, runs, reviewer, parent, start } = setup();
  const workspaces = await WorkspaceRegistry.open({
    dataDir: join(root, 'state'),
    defaultWorkspacePath: root,
  });
  const before = catalog.teamAgents();
  for (const flags of [
    { name: '' },
    { name: '   ' },
    { name: 'x'.repeat(81) },
    { name: 'Writer' },
    { name: catalog.defaultAgent().name },
    { 'workspace-id': 'missing', name: 'Changed' },
    { 'workspace-id': '' },
    {},
    { agent: 'missing', name: 'Created by mistake' },
    { agent: '', name: 'No ID' },
    { workspace: root },
    { prompt: 'unrequested change', name: 'Changed' },
    { agent: 'self', name: 'Changed' },
  ]) {
    await expect(
      executeProjectAgentCommand(
        { action: 'update', agent: reviewer.id, ...flags },
        { channelId: parent },
        { catalog, runs, start, workspaces }
      )
    ).rejects.toThrow();
    expect(catalog.teamAgents()).toEqual(before);
  }
  await expect(
    executeProjectAgentCommand(
      { action: 'update', agent: reviewer.id, 'workspace-id': 'default' },
      { channelId: parent },
      { catalog, runs, start, workspaces, workspaceSwitching: false }
    )
  ).rejects.toThrow('disabled');
  expect(catalog.teamAgents()).toEqual(before);
});

it('allows renaming when workspace switching is disabled but rejects worker edits', async () => {
  const { catalog, runs, reviewer, parent, start, call } = setup();
  const run = await call({ action: 'run', agent: reviewer.id, task: 'work' });
  await expect(
    call(
      { action: 'update', agent: reviewer.id, name: 'Worker edit' },
      `web-chat:${run.appSessionId}`
    )
  ).rejects.toThrow('再委譲');
  expect(catalog.agent(reviewer.id)).toEqual(reviewer);
  const result = JSON.parse(
    await executeProjectAgentCommand(
      { action: 'update', agent: reviewer.id, name: 'Reader' },
      { channelId: parent },
      { catalog, runs, start, workspaceSwitching: false }
    )
  );
  expect(result.agent.name).toBe('Reader');
});

it('changes the default agent workspace without changing saved sessions or requiring a rename', async () => {
  const { catalog, runs, parent, start } = setup();
  const workspaces = await WorkspaceRegistry.open({
    dataDir: join(root, 'state'),
    defaultWorkspacePath: root,
  });
  const path = join(root, 'default-next');
  mkdirSync(path);
  const workspace = await workspaces.register('Default next', path);
  const before = catalog.defaultAgent();
  const result = JSON.parse(
    await executeProjectAgentCommand(
      { action: 'update', agent: 'default', 'workspace-id': workspace.id },
      { channelId: parent },
      { catalog, runs, start, workspaces }
    )
  );
  expect(result.agent).toMatchObject({
    id: before.id,
    name: before.name,
    workspaceId: workspace.id,
  });
  expect(new ProjectCatalog(root).defaultAgent().workspaceId).toBe(workspace.id);
  await expect(
    executeProjectAgentCommand(
      { action: 'update', agent: 'default', 'workspace-id': 'default' },
      { channelId: parent },
      { catalog, runs, start }
    )
  ).rejects.toThrow('registry');
  await expect(
    executeProjectAgentCommand(
      { action: 'update', agent: 'default', name: 'No context' },
      undefined,
      { catalog, runs, start, workspaces }
    )
  ).rejects.toThrow('会話');
  expect(catalog.defaultAgent()).toMatchObject(result.agent);
});
