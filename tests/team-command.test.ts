import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ProjectCatalog } from '../src/project-catalog.js';
import { AgentRunStore } from '../src/agent-runs.js';
import { executeTeamCommand, delegationLimit } from '../src/project-agent-command.js';
import { initSessions, createWebSession, clearSessions } from '../src/sessions.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'team-command-'));
  initSessions(root);
});
afterEach(() => {
  clearSessions();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function setup() {
  const catalog = new ProjectCatalog(root);
  const runs = AgentRunStore.fromDataDir(root);
  const member = catalog.saveAgent({ name: '調査員', prompt: '一次資料を読む' });
  const team = catalog.saveTeam({ leadership: 'caller',
    name: 'リサーチ',
    prompt: '出典を示す',
    members: [
      { agentId: 'xangi:default', role: 'リーダー' },
      { agentId: member.id, role: '調査' },
    ],
  });
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
  const call = (flags: Record<string, string>, channelId = 'discord-parent') =>
    executeTeamCommand({...((flags.action === 'run' && (catalog.team(flags.team)?.name || flags.team) !== 'Caller') ? {'assignments-json':JSON.stringify((catalog.team(flags.team)||catalog.teams().find(t=>t.name===flags.team))?.members.map(m=>({agentId:m.agentId,task:'独立調査'})))} : {}),...flags}, { channelId, platform: 'discord' }, deps).then(JSON.parse);
  return { catalog, runs, member, team, start, call, deps };
}
it('lists Teams separately and shows complete roles, reporting lines and instructions by name or ID', async () => {
  const { call, team, member } = setup();
  expect(await call({ action: 'list' })).toEqual({
    teams: [
      {
        id: team.id,
        name: 'リサーチ',
        members: 2,
        structure: 'parallel',
        leadership: 'caller',
        maxConcurrency: 16,
        serializeWorkspaces: false,
      },
    ],
  });
  const shown = await call({ action: 'show', team: 'リサーチ' });
  expect(shown).toMatchObject({
    prompt: '出典を示す',
    members: [
      { agentId: 'xangi:default', role: 'リーダー', agent: { name: 'デフォルト（普段のxangi）' } },
      {
        agentId: member.id,
        agent: { name: '調査員', prompt: '一次資料を読む' },
      },
    ],
  });
  expect(await call({ action: 'show', team: team.id })).toEqual(shown);
  await expect(call({ action: 'show', team: 'リサ' })).rejects.toThrow('見つかりません');
});
it('delegates once, exposes only its child phases, and scopes results to the originating conversation', async () => {
  const { call, runs, team, member, start } = setup();
  const run = await call({ action: 'run', team: 'リサーチ', task: '製品を比較して' });
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: `team:${team.id}`,
      parentContextKey: 'discord-parent',
      parentPlatform: 'discord',
    })
  );
  const phase = runs.create({
    task: '調査',
    backend: 'codex',
    workspaceId: 'default',
    workspacePath: root,
    appSessionId: createWebSession({}),
    agentId: member.id,
    teamId: team.id,
    teamPhase: 'work',
    parentContextKey: `web-chat:${run.appSessionId}`,
  });
  runs.markSucceeded(phase.id, { result: '調査結果', sessionId: 'provider' });
  runs.create({
    task: '別の会話の調査',
    backend: 'codex',
    workspaceId: 'default',
    workspacePath: root,
    appSessionId: createWebSession({}),
    teamId: team.id,
    parentContextKey: 'other',
  });
  expect((await call({ action: 'status', id: run.id })).members).toEqual([
    expect.objectContaining({ id: phase.id, result: '調査結果' }),
  ]);
  await expect(call({ action: 'status', id: run.id }, 'other')).rejects.toThrow('見つかりません');
  await expect(
    call({ action: 'status', id: phase.id }, `web-chat:${run.appSessionId}`)
  ).rejects.toThrow('見つかりません');
  await expect(call({ action: 'run', team: team.id, task: '重複' })).rejects.toThrow('実行中');
  await expect(
    call({ action: 'run', team: team.id, task: '再委譲' }, `web-chat:${phase.appSessionId}`)
  ).rejects.toThrow('再委譲');
  runs.markSucceeded(run.id, { result: '最終結果', sessionId: '' });
  expect(await call({ action: 'wait', id: run.id })).toMatchObject({
    status: 'succeeded',
    result: '最終結果',
  });
});
it('reserves before asynchronous start, shares the Agent limit, and releases admission after failure', async () => {
  const { call, start, runs, team, catalog, member } = setup();
  let rejectStart!: (reason: Error) => void;
  start.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectStart = reject;
      })
  );
  const first = call({ action: 'run', team: team.id, task: 'first' });
  const rejection = expect(first).rejects.toThrow('offline');
  await expect(call({ action: 'run', team: team.id, task: 'duplicate' })).rejects.toThrow(
    '実行中'
  );
  rejectStart(new Error('offline'));
  await rejection;
  expect(await call({ action: 'run', team: team.id, task: 'retry' })).toMatchObject({
    status: 'queued',
  });
  for (let i = 0; i < 2; i++)
    runs.create({
      task: 'agent job',
      backend: 'codex',
      workspaceId: 'default',
      workspacePath: root,
      appSessionId: createWebSession({}),
      parentContextKey: 'discord-parent',
    });
  const next = catalog.saveTeam({ leadership: 'caller',
    name: '別チーム',
    members: [{ agentId: member.id, role: '調査' }],
  });
  vi.stubEnv('AGENT_MAX_CONCURRENT_REQUESTS', '3');
  await expect(call({ action: 'run', team: next.id, task: 'fourth' })).rejects.toThrow('3件');
});
it('wait observes terminal failures without resubmitting', async () => {
  const { call, start, team, runs } = setup();
  const run = await call({ action: 'run', team: team.id, task: 'slow' });
  const timer = setTimeout(() => runs.markFailed(run.id, new Error('member failed')), 10);
  try {
    expect(await call({ action: 'wait', id: run.id })).toMatchObject({
      status: 'failed',
      error: 'member failed',
    });
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    clearTimeout(timer);
  }
});

it('rejects missing context, unknown actions, blank tasks and self-delegation before starting', async () => {
  const { call, deps, team, start } = setup();
  await expect(
    executeTeamCommand({ action: 'run', team: team.id, task: 'work' }, undefined, deps)
  ).rejects.toThrow('現在の会話');
  await expect(call({ action: 'run', team: team.id, task: ' ' })).rejects.toThrow('task');
  await expect(call({ action: 'delete', team: team.id })).rejects.toThrow('action must');
  expect(start).not.toHaveBeenCalled();
});

it('requires a complete caller plan and submits the whole batch once',async()=>{
  const {catalog,member,call,start}=setup();
  const team=catalog.saveTeam({name:'Caller',members:[{agentId:member.id,role:'research'}]});
  await expect(call({action:'run',team:team.id,task:'background'})).rejects.toThrow('assignments-json');
  expect(start).not.toHaveBeenCalled();
  const assignments=[{agentId:member.id,task:'independent research'}];
  await call({action:'run',team:team.id,task:'background','assignments-json':JSON.stringify(assignments)});
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({teamAssignments:assignments,task:'background'}));
});

it('defaults to sixteen combined requests and releases a slot after completion',async()=>{
  const {catalog,member,call,runs}=setup();
  vi.stubEnv('AGENT_MAX_CONCURRENT_REQUESTS','');
  const teams=Array.from({length:17},(_,i)=>catalog.saveTeam({leadership:'caller',name:`batch-${i}`,members:[{agentId:member.id,role:'work'}]}));
  const results=await Promise.all(teams.slice(0,16).map(team=>call({action:'run',team:team.id,task:'work'})));
  await expect(call({action:'run',team:teams[16].id,task:'work'})).rejects.toThrow('16件');
  runs.markSucceeded(results[0].id,{result:'done',sessionId:''});
  await expect(call({action:'run',team:teams[16].id,task:'work'})).resolves.toMatchObject({status:'queued'});
});

it.each(['0', '65', '-1', '1.5', 'abc'])('rejects invalid delegation limit %s', value => {
  vi.stubEnv('AGENT_MAX_CONCURRENT_REQUESTS',value);
  expect(()=>delegationLimit()).toThrow('1〜64');
});
it('accepts both boundaries of the configurable delegation limit',()=>{
  for(const limit of ['1','64']) { vi.stubEnv('AGENT_MAX_CONCURRENT_REQUESTS',limit); expect(delegationLimit()).toBe(Number(limit)); }
});

it('scopes log inspection to the parent and selected Team members', async () => {
  const { call, runs, team, member, deps } = setup();
  const run = await call({ action: 'run', team: team.id, task: '調査' });
  const child = runs.create({ task: '調査', backend: 'codex', workspaceId: 'default', workspacePath: root,
    appSessionId: 'child-logs', parentContextKey: `web-chat:${run.appSessionId}`, teamId: team.id, agentId: member.id });
  const logs = await call({ action: 'logs', id: run.id, member: child.id });
  expect(logs.members).toHaveLength(1);
  expect(logs.members[0]).toMatchObject({ id: child.id, counts: {}, totalEvents: 0 });
  await expect(call({ action: 'logs', id: run.id }, 'another-channel')).rejects.toThrow('見つかりません');
  await expect(call({ action: 'logs', id: run.id, member: 'outside' })).rejects.toThrow('見つかりません');
  const { executeProjectAgentCommand } = await import('../src/project-agent-command.js');
  await expect(executeProjectAgentCommand({ action: 'logs', id: child.id }, { channelId: 'another-channel', platform: 'discord' }, deps)).rejects.toThrow('見つかりません');
});
