import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ProjectCatalog } from '../src/project-catalog.js';
import { AgentRunStore } from '../src/agent-runs.js';
import { executeProjectAgentCommand } from '../src/project-agent-command.js';
import { initSessions, createWebSession, getSessionLifecycle } from '../src/sessions.js';
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
  expect(list.agents).toHaveLength(4);
  expect(list.agents[2]).toMatchObject({ description: 'review code' });
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
it('allows concurrent work while rejecting unknown agents, other-parent result access and nested delegation', async () => {
  const { writer, reviewer, call, runs } = setup();
  await expect(call({ action: 'run', agent: 'outside', task: 'test' })).rejects.toThrow(
    '見つかりません'
  );
  const run = await call({ action: 'run', agent: reviewer.id, task: 'test' });
  expect((await call({ action: 'run', agent: reviewer.id, task: 'test' })).id).not.toBe(run.id);
  await expect(call({ action: 'status', id: run.id }, 'other-parent')).rejects.toThrow(
    '見つかりません'
  );
  await expect(call({ action: 'run', agent: writer.id, task: 'nested' }, `web-chat:${run.appSessionId}`)).rejects.toThrow('再委譲');
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
  await executeProjectAgentCommand(
    { action: 'run', agent: created.agent.id, task: 'implement' },
    { channelId: parent },
    { catalog, runs, start, workspaces }
  );
  expect(start.mock.calls.at(-1)?.[0].workspaceId).toBe(created.workspace.id);
});

it.each(['discord', 'slack'] as const)(
  'allows shared and nested workspaces for %s delegation',
  async (platform) => {
    const { catalog, runs, start } = setup();
    const parentPath = join(root, 'parent');
    const nestedPath = join(parentPath, 'nested');
    mkdirSync(nestedPath, { recursive: true });
    const workspaces = await WorkspaceRegistry.open({
      dataDir: join(root, 'state'),
      defaultWorkspacePath: parentPath,
    });
    const channelId = '123456789012345678';
    for (const [name, workspace] of [
      ['Shared', parentPath],
      ['Nested', nestedPath],
    ]) {
      const created = JSON.parse(
        await executeProjectAgentCommand(
          { action: 'create', name, workspace },
          { channelId, platform },
          { catalog, runs, start, workspaces }
        )
      );
      await executeProjectAgentCommand(
        { action: 'run', agent: created.agent.id, task: 'answer a question' },
        { channelId, platform },
        { catalog, runs, start, workspaces }
      );
      expect(created.workspace.path).toBe(workspace);
      expect(start.mock.calls.at(-1)?.[0].workspaceId).toBe(created.workspace.id);
    }
    expect(start).toHaveBeenCalledTimes(2);
  }
);

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
  ).toHaveLength(4);
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
  expect(result.agents.map((agent: { id: string }) => agent.id)).toEqual(['xangi:default', writer.id, reviewer.id]);
  expect(result).not.toHaveProperty('project');
});


it('discovers and consults default, normalizes aliases, and restricts result access', async () => {
  const { call, start, runs } = setup();
  expect((await call({ action: 'list' })).agents[0]).toMatchObject({ id: 'xangi:default', current: false });
  const run = await call({ action: 'run', agent: 'default', task: 'find the existing avatar' });
  expect(start.mock.calls[0][0]).toMatchObject({ agentId: 'xangi:default', workspaceId: 'default' });
  expect(start.mock.calls[0][0].backend).toBeUndefined();
  expect((await call({ action: 'run', agent: 'xangi:default', task: 'another task' })).id).not.toBe(run.id);
  runs.markSucceeded(run.id, { result: 'avatar path', sessionId: 'provider' });
  expect(await call({ action: 'wait', id: run.id })).toMatchObject({ result: 'avatar path' });
  await expect(call({ action: 'status', id: run.id }, 'unrelated')).rejects.toThrow('見つかりません');
});

it('lets a delegated worker consult default and read the answer without further delegation', async () => {
  const { call, reviewer, runs } = setup();
  const worker = await call({ action: 'run', agent: reviewer.id, task: 'work' });
  const childContext = `web-chat:${worker.appSessionId}`;
  expect((await call({ action: 'list' }, childContext)).agents[0].id).toBe('xangi:default');
  const question = await call({ action: 'run', agent: 'default', task: 'question' }, childContext);
  expect(question.nextStep).toContain(`wait --id ${question.id}`);
  await expect(call({ action: 'run', agent: reviewer.id, task: 'recurse' }, `web-chat:${question.appSessionId}`)).rejects.toThrow('再委譲');
  await expect(call({ action: 'run', agent: 'default', task: 'recurse' }, `web-chat:${question.appSessionId}`)).rejects.toThrow('再委譲');
  runs.markSucceeded(question.id, { result: 'answer', sessionId: 'provider' });
  expect(await call({ action: 'wait', id: question.id }, childContext)).toMatchObject({ result: 'answer' });
  await expect(call({ action: 'status', id: question.id })).rejects.toThrow('見つかりません');
});

it.each(['default', 'xangi:default', 'named'])('allows ordinary self-request %s but blocks all child delegation', async (target) => {
  const { call, writer, reviewer, runs } = setup();
  const context = `web-chat:${createWebSession(target === 'named' ? { selectedAgentId: writer.id } : {})}`;
  const agent = target === 'named' ? writer.id : target;
  const run = await call({ action: 'run', agent, task: 'hello' }, context);
  expect(run.selfDelegation).toBe(true);
  expect(`web-chat:${run.appSessionId}`).not.toBe(context);
  expect(AgentRunStore.fromDataDir(root).get(run.id)?.selfDelegation).toBe(true);
  expect((await call({ action: 'run', agent, task: 'another task' }, context)).id).not.toBe(run.id);
  for (const next of [agent, 'default', reviewer.id]) {
    await expect(call({ action: 'run', agent: next, task: 'recurse' }, `web-chat:${run.appSessionId}`)).rejects.toThrow('再委譲');
  }
  runs.markSucceeded(run.id, { result: 'hello!', sessionId: 'provider' });
  expect(await call({ action: 'wait', id: run.id }, context)).toMatchObject({ result: 'hello!' });
});

it('only the requesting parent closes an idle child after reviewing its result', async () => {
  const { reviewer, call, runs } = setup();
  const run = await call({ action: 'run', agent: reviewer.id, task: 'review' });
  await expect(call({ action: 'close', id: run.id })).rejects.toThrow('実行中');
  runs.markSucceeded(run.id, { result: 'reviewed', sessionId: 'provider' });
  await expect(call({ action: 'close', id: run.id }, 'other-parent')).rejects.toThrow('見つかりません');
  runs.update(run.id, r => { r.pendingWorkInputs = [{ id: 'm', text: 'more' }]; });
  await expect(call({ action: 'close', id: run.id })).rejects.toThrow('実行中');
  runs.update(run.id, r => { r.pendingWorkInputs = []; });
  expect(await call({ action: 'close', id: run.id })).toMatchObject({ ok: true, lifecycle: 'closed' });
  expect(getSessionLifecycle(run.appSessionId)).toBe('closed');
  expect((await call({ action: 'status', id: run.id })).result).toBe('reviewed');
  expect(await call({ action: 'close', id: run.id })).toMatchObject({ ok: true });
});

it('allows a worker to close its own default consultation, but never itself', async () => {
  const { reviewer, call, runs } = setup();
  const child = await call({ action: 'run', agent: reviewer.id, task: 'review' });
  const childContext = `web-chat:${child.appSessionId}`;
  const question = await call({ action: 'run', agent: 'default', task: 'question' }, childContext);
  runs.markFailed(question.id, new Error('unavailable'));
  expect(await call({ action: 'close', id: question.id }, childContext)).toMatchObject({ ok: true });
  await expect(call({ action: 'close', id: child.id }, childContext)).rejects.toThrow('見つかりません');
});

it('routes three self tasks independently and reuses only explicit retry IDs', async () => {
  const { call, start, runs } = setup();
  const children = await Promise.all(['research', 'verify', 'review'].map((task) =>
    call({ action: 'run', agent: 'self', task, 'request-id': task })
  ));
  expect(new Set(children.map((r) => r.id)).size).toBe(3);
  expect(new Set(children.map((r) => r.appSessionId)).size).toBe(3);
  expect(start.mock.calls.every(([body]) => body.inheritParent === true)).toBe(true);
  expect((await call({ action: 'run', agent: 'self', task: 'research', 'request-id': 'research' })).id).toBe(children[0].id);
  expect(start).toHaveBeenCalledTimes(3);
  await expect(call({ action: 'run', agent: 'self', task: 'changed', 'request-id': 'research' })).rejects.toThrow('別の依頼');
  runs.markSucceeded(children[1].id, { result: 'verified', sessionId: 'verify-provider' });
  runs.markFailed(children[0].id, new Error('research failed'));
  expect(await call({ action: 'status', id: children[1].id })).toMatchObject({ result: 'verified', status: 'succeeded' });
  expect(await call({ action: 'status', id: children[0].id })).toMatchObject({ error: 'research failed', status: 'failed' });
  expect(await call({ action: 'status', id: children[2].id })).toMatchObject({ status: 'queued' });
});

it('counts pending admissions and releases reservations after a failed start', async () => {
  const { catalog, runs, parent } = setup();
  const oldLimit = process.env.AGENT_MAX_CONCURRENT_REQUESTS;
  process.env.AGENT_MAX_CONCURRENT_REQUESTS = '1';
  let rejectStart!: (error: Error) => void;
  const start = vi.fn(() => new Promise<never>((_, reject) => { rejectStart = reject; }));
  const invoke = (id: string) => executeProjectAgentCommand(
    { action: 'run', agent: 'self', task: 'task', 'request-id': id }, { channelId: parent }, { catalog, runs, start }
  );
  try {
    const pending = invoke('one');
    const failure = expect(pending).rejects.toThrow('start failed');
    await expect(invoke('one')).rejects.toThrow('受付中');
    await expect(invoke('two')).rejects.toThrow('1件');
    expect(start).toHaveBeenCalledTimes(1);
    rejectStart(new Error('start failed'));
    await failure;
    const again = invoke('two');
    const secondFailure = expect(again).rejects.toThrow('second failed');
    expect(start).toHaveBeenCalledTimes(2);
    rejectStart(new Error('second failed'));
    await secondFailure;
  } finally {
    if (oldLimit === undefined) delete process.env.AGENT_MAX_CONCURRENT_REQUESTS;
    else process.env.AGENT_MAX_CONCURRENT_REQUESTS = oldLimit;
  }
});

it('validates context mode and limits history copying to self', async () => {
  const { call, writer, start } = setup();
  await expect(call({ action: 'run', agent: 'self', task: 't', context: 'fork' })).rejects.toThrow('--context');
  await expect(call({ action: 'run', agent: writer.id, task: 't', context: 'history' })).rejects.toThrow('self');
  await call({ action: 'run', agent: 'self', task: 't', context: 'history', 'workspace-id': 'isolated' });
  expect(start.mock.calls[0][0]).toMatchObject({ contextMode: 'history', workspaceOverride: 'isolated' });
});

it('keeps retry identity independent of a leader prompt suffix and rejects changed options', async () => {
  const { call, catalog, reviewer, writer, runs } = setup();
  const team = catalog.saveTeam({name:'workers',members:[{agentId:writer.id}]});
  const flags={action:'run',agent:reviewer.id,task:'lead this work','request-id':'leader-retry','allow-teams-json':JSON.stringify([team.id])};
  const run=await call(flags);
  // The execution path may add orchestration instructions to the persisted task.
  // A retry still refers to the original, signed request rather than that prompt.
  expect((await call(flags)).id).toBe(run.id);
  await expect(call({...flags,'delegation-max-members':'3'})).rejects.toThrow('別の依頼');
  expect(runs.list()).toHaveLength(1);
});
