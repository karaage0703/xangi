import { inspectAgentRunLogs, logPageOptions } from './agent-run-logs.js';
import { DEFAULT_TEAM_CONCURRENCY, validateTeamAssignments } from './teams.js';
import { removeRegisteredAgent } from './agent-selection.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectCatalog } from './project-catalog.js';
import type { AgentRun, AgentRunStore } from './agent-runs.js';
import { getActiveSessionId, getSessionEntry, webAppSessionId } from './sessions.js';
import type { WorkspaceRegistry } from './workspace-registry.js';
import { realpath } from 'node:fs/promises';
import type { ChatPlatform } from './prompts/index.js';

interface Dependencies {
  catalog: ProjectCatalog;
  runs: AgentRunStore;
  start: (body: Record<string, unknown>) => Promise<AgentRun>;
  workspaces?: WorkspaceRegistry;
}

export function delegationLimit(): number {
  const value = process.env.AGENT_MAX_CONCURRENT_REQUESTS;
  if (value === undefined || value === '') return 16;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 64)
    throw new Error('AGENT_MAX_CONCURRENT_REQUESTSは1〜64の整数で指定してください');
  return Number(value);
}
let active: Dependencies | undefined;
const reservations = new Set<string>();
export function registerProjectAgents(dependencies: Dependencies): void {
  active = dependencies;
}

/** Use the same live catalog and run store as Web Chat; never load a second writer. */
export async function executeProjectAgentCommand(
  flags: Record<string, string>,
  context?: { channelId?: string; platform?: ChatPlatform },
  dependencies = active
): Promise<string> {
  if (!dependencies) throw new Error('Agents require Web Chat to be enabled');
  const { catalog, runs, start, workspaces } = dependencies;
  const parent = context?.channelId;
  const session = parent ? getSessionEntry(webAppSessionId(parent)) : undefined;
  if (
    parent &&
    runs.list().some((r) => r.parentContextKey && r.appSessionId === webAppSessionId(parent))
  )
    throw new Error('子エージェントからの再委譲はできません');
  const action = flags.action || 'list';
  if (flags.project !== undefined || flags['project-name'] !== undefined)
    throw new Error('エージェント操作に --project / --project-name は不要です');
  if (action === 'list') {
    return JSON.stringify({
      agents: catalog.agents().map((agent) => {
        const id = agent.id;
        return {
          id,
          name: agent.name,
          description: agent.prompt.split('\n')[0].slice(0, 120),
          backend: agent.backend,
          model: agent.model,
          current: id === session?.selectedAgentId,
        };
      }),
    });
  }
  if (action === 'delete') {
    removeRegisteredAgent(flags.agent || flags.id || '', catalog, (sessionId) =>
      runs
        .list()
        .some((r) => r.appSessionId === sessionId && ['queued', 'running'].includes(r.status))
    );
    return JSON.stringify({ ok: true });
  }
  if (!parent) throw new Error('現在の会話が必要です');
  if (action === 'create') {
    if (!workspaces) throw new Error('Workspace registry is unavailable');
    if (!flags.name?.trim() || !flags.workspace?.trim())
      throw new Error('--name と --workspace は必須です');
    if (
      catalog
        .agents()
        .some((agent) => agent.name.toLocaleLowerCase() === flags.name.trim().toLocaleLowerCase())
    )
      throw new Error('同じ名前のエージェントが既にあります');
    const workspacePath = await realpath(flags.workspace);
    const workspace =
      workspaces.list().find((entry) => entry.path === workspacePath) ||
      (await workspaces.register(`agent-${flags.name}-${Date.now()}`, workspacePath));
    const agent = catalog.saveAgent({
      name: flags.name,
      role: flags.role || '',
      prompt: flags.prompt || '',
      workspaceId: workspace.id,
      backend: flags.backend,
      model: flags.model,
      effort: flags.effort,
    });
    return JSON.stringify({ agent, workspace });
  }
  if (action === 'wait' || action === 'status' || action === 'logs') {
    let run = runs.get(flags.id || '');
    if (!run || run.parentContextKey !== parent) throw new Error('この会話の依頼が見つかりません');
    if (action === 'logs')
      return JSON.stringify(await inspectAgentRunLogs(run, logPageOptions(flags)));
    const deadline = Date.now() + (action === 'wait' ? 25_000 : 0);
    while (['queued', 'running'].includes(run.status) && Date.now() < deadline) {
      await delay(200);
      run = runs.get(run.id)!;
    }
    return JSON.stringify(run);
  }
  if (action !== 'run')
    throw new Error('action must be create, list, delete, run, status, wait or logs');
  if (!flags.task?.trim()) throw new Error('--task is required');
  if (!flags.agent || !catalog.agent(flags.agent)) throw new Error('エージェントが見つかりません');
  if (flags.agent === session?.selectedAgentId)
    throw new Error('自分以外のエージェントを指定してください');
  const running = runs
    .list()
    .filter((r) => r.parentContextKey === parent && ['queued', 'running'].includes(r.status));
  const reservation = JSON.stringify([parent, flags.agent]);
  const reservedForParent = [...reservations].filter((key) => {
    const [owner, id] = JSON.parse(key);
    return owner === parent && !running.some((r) => r.agentId === id);
  }).length;
  if (running.length + reservedForParent >= delegationLimit())
    throw new Error(`同時に依頼できる担当は${delegationLimit()}件までです。結果を待ってください`);
  if (reservations.has(reservation) || running.some((r) => r.agentId === flags.agent))
    throw new Error('この担当への依頼は実行中です');
  reservations.add(reservation);
  try {
    const execution = catalog.execution(undefined, flags.agent)!;
    return JSON.stringify(
      await start({
        task: flags.task,
        instruction: execution.prompt,
        backend: execution.backend,
        model: execution.model,
        effort: execution.effort,
        workspaceId: execution.workspaceId,
        localLlmMode: execution.localLlmMode,
        localLlmReasoningEffort: execution.localLlmReasoningEffort,
        agentId: flags.agent,
        parentContextKey: parent,
        parentPlatform: context?.platform,
        title: `依頼: ${catalog.agent(flags.agent)!.name}`,
      })
    );
  } finally {
    reservations.delete(reservation);
  }
}

/** Team reads and delegation share the live catalog, run store and admission limit. */
export async function executeTeamCommand(
  flags: Record<string, string>,
  context?: { channelId?: string; platform?: ChatPlatform },
  dependencies = active
): Promise<string> {
  if (!dependencies) throw new Error('Teams require Web Chat to be enabled');
  const { catalog, runs, start } = dependencies;
  const action = flags.action || 'list';
  if (action === 'list') {
    return JSON.stringify({
      teams: catalog.teams().map((team) => ({
        id: team.id,
        name: team.name,
        members: team.members.length,
        leadership: team.leadership,
        maxConcurrency: team.maxConcurrency ?? DEFAULT_TEAM_CONCURRENCY,
        serializeWorkspaces: team.serializeWorkspaces ?? false,
        structure: team.members.some((m) => m.reportsTo) ? 'hierarchy' : 'parallel',
      })),
    });
  }
  const resolveTeam = () => {
    const key = (flags.team || '').trim();
    const byId = catalog.team(key);
    if (byId) return byId;
    const matches = catalog.teams().filter((team) => team.name === key);
    if (matches.length > 1) throw new Error('同名のTeamが複数あります。IDで指定してください');
    if (!matches.length) throw new Error('Teamが見つかりません');
    return matches[0];
  };
  if (action === 'show') {
    const team = resolveTeam();
    const agents = catalog.teamAgent(team.id)!.team!.agents;
    return JSON.stringify({
      ...team,
      maxConcurrency: team.maxConcurrency ?? DEFAULT_TEAM_CONCURRENCY,
      serializeWorkspaces: team.serializeWorkspaces ?? false,
      members: team.members.map((member) => ({
        ...member,
        agent: agents.find((agent) => agent.id === member.agentId),
      })),
    });
  }
  const parent = context?.channelId;
  if (!parent) throw new Error('現在の会話が必要です');
  if (action === 'status' || action === 'wait' || action === 'logs') {
    let run = runs.get(flags.id || '');
    if (!run || run.parentContextKey !== parent || !run.agentId?.startsWith('team:'))
      throw new Error('この会話のTeam依頼が見つかりません');
    const deadline = Date.now() + (action === 'wait' ? 25_000 : 0);
    while (['queued', 'running'].includes(run.status) && Date.now() < deadline) {
      await delay(200);
      run = runs.get(run.id)!;
    }
    const members = runs
      .list()
      .filter(
        (member) =>
          member.parentContextKey === `web-chat:${run.appSessionId}` &&
          member.teamId === run.agentId!.slice('team:'.length)
      );
    const snapshot = getSessionEntry(run.appSessionId)?.selectedAgentConfig?.team;
    if (action === 'logs') {
      const page = logPageOptions(flags);
      const selected = flags.member
        ? members.filter((member) => member.id === flags.member || member.agentId === flags.member)
        : members;
      if (flags.member && !selected.length)
        throw new Error('このTeam依頼のメンバーが見つかりません');
      const logs = [];
      for (const member of selected)
        logs.push({
          name: snapshot?.agents.find((agent) => agent.id === member.agentId)?.name,
          ...(await inspectAgentRunLogs(member, page)),
        });
      return JSON.stringify({ id: run.id, status: run.status, members: logs });
    }
    return JSON.stringify({
      ...run,
      members: members.map((member) => ({
        id: member.id,
        agentId: member.agentId,
        name: snapshot?.agents.find((agent) => agent.id === member.agentId)?.name,
        role: snapshot?.members.find((entry) => entry.agentId === member.agentId)?.role,
        phase: member.teamPhase,
        status: member.status,
        result: member.result,
        error: member.error,
        startedAt: member.startedAt,
        completedAt: member.completedAt,
        usage: member.usage,
      })),
    });
  }
  if (action !== 'run') throw new Error('action must be list, show, run, status, wait or logs');
  if (!flags.task?.trim()) throw new Error('--task is required');
  if (
    runs.list().some((run) => run.parentContextKey && run.appSessionId === webAppSessionId(parent))
  )
    throw new Error('子エージェントからの再委譲はできません');
  const team = resolveTeam();
  const assignments =
    team.leadership === 'caller'
      ? validateTeamAssignments(
          catalog.teamAgent(team.id)!.team!,
          flags['assignments-json'] ? JSON.parse(flags['assignments-json']) : undefined
        )
      : undefined;
  const agentId = `team:${team.id}`;
  const session = getSessionEntry(getActiveSessionId(parent) || webAppSessionId(parent));
  if (team.leadership !== 'caller' && session?.selectedAgentId === agentId)
    throw new Error('自分以外のTeamを指定してください');
  const running = runs
    .list()
    .filter((run) => run.parentContextKey === parent && ['queued', 'running'].includes(run.status));
  const reservation = JSON.stringify([parent, agentId]);
  if (reservations.has(reservation) || running.some((run) => run.agentId === agentId))
    throw new Error('このTeamへの依頼は実行中です');
  const reserved = [...reservations].filter((key) => {
    const [owner, id] = JSON.parse(key);
    return owner === parent && !running.some((r) => r.agentId === id);
  }).length;
  if (running.length + reserved >= delegationLimit())
    throw new Error(`同時に依頼できる担当は${delegationLimit()}件までです。結果を待ってください`);
  reservations.add(reservation);
  try {
    return JSON.stringify(
      await start({
        task: flags.task,
        teamAssignments: assignments,
        agentId,
        parentContextKey: parent,
        parentPlatform: context?.platform,
        title: `Team依頼: ${team.name}`,
      })
    );
  } finally {
    reservations.delete(reservation);
  }
}
