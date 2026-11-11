import { instanceCliCommand } from '../src/instance-cli.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { ProjectCatalog } from '../src/project-catalog.js';
import { AgentRunStore } from '../src/agent-runs.js';
import { executeProjectAgentCommand, executeTeamCommand } from '../src/project-agent-command.js';
import {
  runDelegatingLeader,
  cancelTeamDelegation,
  delegationScopeCount,
} from '../src/team-delegation.js';
import { initSessions, clearSessions, createWebSession } from '../src/sessions.js';
import type { AgentRunner } from '../src/agent-runner.js';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-'));
  initSessions(dir);
});
afterEach(() => {
  clearSessions();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const catalog = new ProjectCatalog(dir);
  const runs = AgentRunStore.fromDataDir(dir);
  const leader = catalog.saveAgent({ name: 'Leader' });
  const member = catalog.saveAgent({ name: 'Maker' });
  const team = catalog.saveTeam({ name: 'Production', members: [{ agentId: member.id }] });
  const start = vi.fn(async (body: Record<string, unknown>) =>
    runs.create({
      ...body,
      task: String(body.task),
      backend: 'codex',
      workspaceId: 'default',
      workspacePath: dir,
      appSessionId: createWebSession({}),
    })
  );
  const deps = { catalog, runs, start };
  const launch = (extra: Record<string, string> = {}) =>
    executeProjectAgentCommand(
      {
        action: 'run',
        agent: leader.id,
        task: 'Make slides',
        'allow-teams-json': JSON.stringify([team.id]),
        ...extra,
      },
      { channelId: 'parent' },
      deps
    ).then(JSON.parse);
  const dispatch = (appSessionId: string, teamId = team.id) =>
    executeTeamCommand(
      {
        action: 'run',
        team: teamId,
        task: 'Make a figure',
        'assignments-json': JSON.stringify(
          catalog.team(teamId)!.members.map((m) => ({ agentId: m.agentId, task: 'Draw' }))
        ),
      },
      { channelId: `web-chat:${appSessionId}` },
      deps
    ).then(JSON.parse);
  return { catalog, runs, leader, member, team, start, deps, launch, dispatch };
}
it('grants one leader request, permits repeated Agent settings, and rejects unlisted teams and further delegation', async () => {
  const f = setup();
  const leader = await f.launch();
  expect(leader.teamDelegation.teamIds).toEqual([f.team.id]);
  const other = f.catalog.saveTeam({ name: 'Other', members: [{ agentId: f.member.id }] });
  await expect(f.dispatch(leader.appSessionId, other.id)).rejects.toThrow('許可');
  const child = await f.dispatch(leader.appSessionId);
  expect(child.delegationRootId).toBe(leader.id);
  expect(child.parentDeliveryTracked).toBe(false);
  expect(f.runs.markRunning(child.id).parentDeliveryTracked).toBe(false);
  await expect(f.dispatch(child.appSessionId)).rejects.toThrow('再委譲');
  await expect(
    executeProjectAgentCommand(
      { action: 'run', agent: 'default', task: 'escape' },
      { channelId: `web-chat:${child.appSessionId}` },
      f.deps
    )
  ).rejects.toThrow('再委譲');
  f.runs.markSucceeded(child.id, { result: 'Done', sessionId: '' });
  f.catalog.saveTeam({ members: [{ agentId: f.leader.id }] }, f.team.id);
  const sameConfigBatch = await f.dispatch(leader.appSessionId);
  expect(sameConfigBatch.delegationRootId).toBe(leader.id);
});
it('does not allow a delegated leader to create or replace Team settings', async () => {
  const f = setup();
  const leader = await f.launch();
  await expect(executeTeamCommand({action: 'create', name: 'Escape', 'members-json': '[{"agentId":"xangi:default"}]'}, {channelId: `web-chat:${leader.appSessionId}`}, f.deps)).rejects.toThrow('子エージェント');
  expect(f.catalog.teams()).toEqual([f.team]);
});
it('blocks expired/completed leaders and shares cumulative launch budget across rounds', async () => {
  const f = setup();
  const leader = await f.launch({ 'delegation-max-members': '1' });
  const child = await f.dispatch(leader.appSessionId);
  await expect(f.dispatch(leader.appSessionId)).rejects.toThrow('実行中');
  f.runs.markSucceeded(child.id, { result: 'Done', sessionId: '' });
  await expect(f.dispatch(leader.appSessionId)).rejects.toThrow('累計');
  f.runs.markSucceeded(leader.id, { result: 'Done', sessionId: '' });
  await expect(f.dispatch(leader.appSessionId)).rejects.toThrow('再委譲');
  const next = await f.launch({ 'delegation-timeout-ms': '1000' });
  vi.spyOn(Date, 'now').mockReturnValue(next.teamDelegation.deadline + 1);
  await expect(f.dispatch(next.appSessionId)).rejects.toThrow('期限');
  vi.restoreAllMocks();
});
it('counts nested members in the original conversation admission limit', async () => {
  const f = setup();
  vi.stubEnv('AGENT_MAX_CONCURRENT_REQUESTS', '2');
  const leader = await f.launch();
  const child = await f.dispatch(leader.appSessionId);
  f.runs.create({
    task: 'member',
    backend: 'codex',
    workspaceId: 'default',
    workspacePath: dir,
    appSessionId: createWebSession({}),
    delegationRootId: leader.id,
    teamTurnId: 'turn',
    parentContextKey: `web-chat:${child.appSessionId}`,
  });
  expect(delegationScopeCount(f.runs, 'parent')).toBe(2);
  await expect(
    executeProjectAgentCommand(
      { action: 'run', agent: f.member.id, task: 'other' },
      { channelId: 'parent' },
      f.deps
    )
  ).rejects.toThrow('2件');
});
it('waits for unfinished children and resumes the leader with their actual results', async () => {
  const f = setup();
  const leader = await f.launch();
  const child = await f.dispatch(leader.appSessionId);
  const runner = {
    runStream: vi
      .fn()
      .mockResolvedValueOnce({ result: 'started', sessionId: 'leader-session' })
      .mockResolvedValueOnce({ result: 'Integrated', sessionId: 'leader-session' }),
    cancel: vi.fn(),
  } as unknown as AgentRunner;
  const pending = runDelegatingLeader(
    leader,
    f.runs,
    runner,
    'request',
    {},
    { channelId: `web-chat:${leader.appSessionId}` }
  );
  const timer = setTimeout(
    () => f.runs.markSucceeded(child.id, { result: 'actual figure', sessionId: '' }),
    10
  );
  try {
    expect((await pending).result).toBe('Integrated');
    expect(runner.runStream).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runner.runStream).mock.calls[0][0]).toContain(`${instanceCliCommand} team --help`);
    expect(vi.mocked(runner.runStream).mock.calls[1][0]).toContain('actual figure');
    expect(f.runs.get(leader.id)?.teamDelegationClosed).toBe(true);
  } finally {
    clearTimeout(timer);
  }
});
it.each(['stop', 'timeout', 'failure'] as const)(
  'cancels children on leader %s and prevents late admissions',
  async (mode) => {
    const f = setup();
    const leader = await f.launch();
    if (mode === 'timeout') leader.teamDelegation.deadline = Date.now() + 20;
    const child = await f.dispatch(leader.appSessionId);
    const runner = {
      runStream: vi.fn(async () => ({
        result: 'early',
        sessionId: '',
        failed: mode === 'failure',
      })),
      cancel: vi.fn(() => true),
    } as unknown as AgentRunner;
    const channel = `web-chat:${leader.appSessionId}`;
    const pending = runDelegatingLeader(
      leader,
      f.runs,
      runner,
      'request',
      {},
      { channelId: channel }
    );
    if (mode === 'stop') cancelTeamDelegation(channel);
    expect((await pending).failed).toBe(true);
    expect(runner.cancel).toHaveBeenCalledWith(`web-chat:${child.appSessionId}`);
    await expect(f.dispatch(leader.appSessionId)).rejects.toThrow('再委譲');
  }
);
it('rejects invalid grants and preserves unprivileged child behavior', async () => {
  const f = setup();
  await expect(f.launch({ 'allow-teams-json': '["missing"]' })).rejects.toThrow('登録済み');
  await expect(f.launch({ 'delegation-max-members': '0' })).rejects.toThrow('累計');
  f.catalog.saveTeam({ members: [{ agentId: 'xangi:default' }] }, f.team.id);
  expect((await f.launch()).teamDelegation.teamIds).toContain(f.team.id);
  const unprivileged = await f.launch({ 'allow-teams-json': '' });
  await expect(f.dispatch(unprivileged.appSessionId)).rejects.toThrow('再委譲');
});

it('uses the configured leader without caller assignments and freezes allowed membership for later rounds', async () => {
  const f = setup();
  f.catalog.saveTeam({ leaderAgentId: f.leader.id }, f.team.id);
  const context = { channelId: 'parent' };
  const run = JSON.parse(
    await executeTeamCommand(
      { action: 'run', team: f.team.id, task: 'coordinate' },
      context,
      f.deps
    )
  );
  expect(f.start).toHaveBeenLastCalledWith(
    expect.objectContaining({ teamLeaderId: f.leader.id, teamAssignments: undefined })
  );
  expect(run.delegationTeam.members.map((m: { agentId: string }) => m.agentId)).toEqual([
    f.member.id,
  ]);
  await expect(
    executeTeamCommand({ action: 'run', team: f.team.id, task: 'duplicate' }, context, f.deps)
  ).rejects.toThrow('実行中');
  const other = f.catalog.saveAgent({ name: 'New member' });
  f.catalog.saveTeam({ members: [{ agentId: other.id }] }, f.team.id);
  const leaderContext = { channelId: `web-chat:${run.appSessionId}` };
  const shown = JSON.parse(
    await executeTeamCommand({ action: 'show', team: f.team.id }, leaderContext, f.deps)
  );
  expect(shown.members[0].agentId).toBe(f.member.id);
  await expect(
    executeTeamCommand(
      {
        action: 'run',
        team: f.team.id,
        task: 'changed',
        'assignments-json': JSON.stringify([{ agentId: other.id, task: 'escape' }]),
      },
      leaderContext,
      f.deps
    )
  ).rejects.toThrow('チーム内');
  const child = JSON.parse(
    await executeTeamCommand(
      {
        action: 'run',
        team: f.team.id,
        task: 'original',
        'assignments-json': JSON.stringify([{ agentId: f.member.id, task: 'work' }]),
      },
      leaderContext,
      f.deps
    )
  );
  expect(child.delegationRootId).toBe(run.id);
  expect(f.start).toHaveBeenLastCalledWith(
    expect.objectContaining({
      teamLeaderId: undefined,
      teamSnapshot: expect.objectContaining({ leaderAgentId: undefined }),
    })
  );
});

it.each(['configured', 'granted'] as const)(
  'runs four makers then only the reviewer and charges selected members (%s leader)',
  async (mode) => {
    const f = setup();
    const makers = [f.member, ...[1, 2, 3].map((n) => f.catalog.saveAgent({ name: `Maker ${n}` }))];
    const reviewer = f.catalog.saveAgent({ name: 'Reviewer' });
    f.catalog.saveTeam(
      {
        members: [...makers, reviewer].map((a) => ({ agentId: a.id })),
        ...(mode === 'configured' ? { leaderAgentId: f.leader.id } : {}),
      },
      f.team.id
    );
    const leader =
      mode === 'configured'
        ? JSON.parse(
            await executeTeamCommand(
              { action: 'run', team: f.team.id, task: 'coordinate', 'delegation-max-members': '5' },
              { channelId: 'parent' },
              f.deps
            )
          )
        : await f.launch({ 'delegation-max-members': '5' });
    const dispatch = (ids: string[]) =>
      executeTeamCommand(
        {
          action: 'run',
          team: f.team.id,
          task: 'round',
          'assignments-json': JSON.stringify(
            ids.map((agentId) => ({ agentId, task: 'independent work' }))
          ),
        },
        { channelId: `web-chat:${leader.appSessionId}` },
        f.deps
      ).then(JSON.parse);
    const first = await dispatch(makers.map((a) => a.id));
    expect(first.delegatedMemberCount).toBe(4);
    const firstBody = f.start.mock.calls.at(-1)![0];
    const { executeTeamTree } = await import('../src/team-runner.js');
    const execute = vi.fn(async () => ({ result: 'artifact', sessionId: '' }));
    await executeTeamTree(
      {
        ...(firstBody.teamSnapshot as import('../src/teams.js').TeamSnapshot),
        assignments:
          firstBody.teamAssignments as import('../src/teams.js').TeamSnapshot['assignments'],
      },
      execute
    );
    expect(execute.mock.calls).toHaveLength(4);
    expect(
      (firstBody.teamSnapshot as import('../src/teams.js').TeamSnapshot).agents
        .map((a) => a.id)
        .sort()
    ).toEqual(makers.map((a) => a.id).sort());
    await expect(dispatch([reviewer.id])).rejects.toThrow('実行中');
    f.runs.markSucceeded(first.id, { result: 'four figures', sessionId: '' });
    const second = await dispatch([reviewer.id]);
    expect(second.delegatedMemberCount).toBe(1);
    const body = f.start.mock.calls.at(-1)![0];
    execute.mockClear();
    await executeTeamTree(
      {
        ...(body.teamSnapshot as import('../src/teams.js').TeamSnapshot),
        assignments: body.teamAssignments as import('../src/teams.js').TeamSnapshot['assignments'],
      },
      execute
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: reviewer.id }),
      'work',
      'independent work'
    );
    f.runs.markSucceeded(second.id, { result: 'review', sessionId: '' });
    await expect(dispatch([reviewer.id])).rejects.toThrow('累計');
    if (mode === 'configured')
      expect(f.runs.get(leader.id)?.delegationTeam?.members).toHaveLength(5);
  }
);

it('rejects empty, duplicate, outside-team and blank assignments before starting a delegated batch', async () => {
  const f = setup();
  const leader = await f.launch();
  const count = f.start.mock.calls.length;
  for (const assignments of [
    [],
    [{ agentId: 'outside', task: 'work' }],
    [{ agentId: f.member.id, task: ' ' }],
    [
      { agentId: f.member.id, task: 'a' },
      { agentId: f.member.id, task: 'b' },
    ],
  ]) {
    await expect(
      executeTeamCommand(
        {
          action: 'run',
          team: f.team.id,
          task: 'round',
          'assignments-json': JSON.stringify(assignments),
        },
        { channelId: `web-chat:${leader.appSessionId}` },
        f.deps
      )
    ).rejects.toThrow();
  }
  expect(f.start).toHaveBeenCalledTimes(count);
});

it('continues requiring all assignments when the caller has no delegated leader grant', async () => {
  const f = setup();
  const reviewer = f.catalog.saveAgent({ name: 'Reviewer' });
  f.catalog.saveTeam({ members: [{ agentId: f.member.id }, { agentId: reviewer.id }] }, f.team.id);
  await expect(
    executeTeamCommand(
      {
        action: 'run',
        team: f.team.id,
        task: 'partial',
        'assignments-json': JSON.stringify([{ agentId: f.member.id, task: 'work' }]),
      },
      { channelId: 'parent' },
      f.deps
    )
  ).rejects.toThrow('全メンバー');
  expect(f.start).not.toHaveBeenCalled();
});
