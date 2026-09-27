import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectCatalog } from './project-catalog.js';
import type { AgentRun, AgentRunStore } from './agent-runs.js';
import { getSessionEntry, webAppSessionId } from './sessions.js';
import type { WorkspaceRegistry } from './workspace-registry.js';
import { realpath } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import type { ChatPlatform } from './prompts/index.js';

interface Dependencies {
  catalog: ProjectCatalog;
  runs: AgentRunStore;
  start: (body: Record<string, unknown>) => Promise<AgentRun>;
  workspaces?: WorkspaceRegistry;
}

let active: Dependencies | undefined;
const reservations = new Set<string>();
function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
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
          description: agent.role,
          backend: agent.backend,
          model: agent.model,
          current: id === session?.selectedAgentId,
        };
      }),
    });
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
    const parentWorkspace =
      session?.workspacePath ??
      (context?.platform === 'discord'
        ? (await workspaces.resolve('discord', parent)).path
        : undefined);
    if (
      (parentWorkspace && isWithin(workspacePath, parentWorkspace)) ||
      (workspaces.getById('default')?.path &&
        isWithin(workspacePath, workspaces.getById('default')!.path))
    )
      throw new Error('親Workspaceの外にある別のWorkspaceを指定してください');
    const workspace =
      workspaces.list().find((entry) => entry.path === workspacePath) ||
      (await workspaces.register(`agent-${flags.name}-${Date.now()}`, workspacePath));
    const agent = catalog.saveAgent({
      name: flags.name,
      role: flags.role || '開発担当',
      prompt: flags.prompt || '',
      workspaceId: workspace.id,
      backend: flags.backend,
      model: flags.model,
      effort: flags.effort,
    });
    return JSON.stringify({ agent, workspace });
  }
  if (action === 'wait' || action === 'status') {
    let run = runs.get(flags.id || '');
    if (!run || run.parentContextKey !== parent) throw new Error('この会話の依頼が見つかりません');
    const deadline = Date.now() + (action === 'wait' ? 25_000 : 0);
    while (['queued', 'running'].includes(run.status) && Date.now() < deadline) {
      await delay(200);
      run = runs.get(run.id)!;
    }
    return JSON.stringify(run);
  }
  if (action !== 'run') throw new Error('action must be list, run, status or wait');
  if (!flags.task?.trim()) throw new Error('--task is required');
  if (!flags.agent || !catalog.agent(flags.agent)) throw new Error('エージェントが見つかりません');
  if (flags.agent === session?.selectedAgentId)
    throw new Error('自分以外のエージェントを指定してください');
  const running = runs
    .list()
    .filter((r) => r.parentContextKey === parent && ['queued', 'running'].includes(r.status));
  const reservation = JSON.stringify([parent, flags.agent]);
  const reservedForParent = [...reservations].filter((key) => JSON.parse(key)[0] === parent).length;
  if (running.length + reservedForParent >= 3)
    throw new Error('同時に依頼できる担当は3名までです。結果を待ってください');
  if (reservations.has(reservation) || running.some((r) => r.agentId === flags.agent))
    throw new Error('この担当への依頼は実行中です');
  const execution = catalog.execution(undefined, flags.agent)!;
  if (workspaces) {
    const childPath = (await workspaces.resolveById(execution.workspaceId || 'default')).path;
    const parentPath =
      session?.workspacePath ??
      (context?.platform === 'discord'
        ? (await workspaces.resolve('discord', parent)).path
        : workspaces.getById('default')?.path);
    if (parentPath && isWithin(childPath, parentPath))
      throw new Error('子エージェントのWorkspaceは親Workspaceの外に置いてください');
  }
  reservations.add(reservation);
  try {
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
