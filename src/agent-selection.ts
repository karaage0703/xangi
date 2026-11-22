import { agentWorkBusy } from './agent-work.js';
import { DEFAULT_TEAM_AGENT_ID, teamCallerInstructions, upgradeLegacyTeam } from './teams.js';
import { migrateTeamId } from './team-migration.js';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DedicatedAgentSettings,
  ProjectCatalog,
  SharedAgent,
  SharedProject,
} from './project-catalog.js';
import type { WorkspaceEntry, WorkspaceRegistry } from './workspace-registry.js';
import type { AgentRunner } from './agent-runner.js';
import type { BackendResolver, ChannelOverride } from './backend-resolver.js';
import {
  getActiveSessionId,
  getSessionEntry,
  listAllSessions,
  closeSession,
  clearClosedSessionAgentSelections,
  clearClosedSessionTeamSelections,
  getSessionLifecycle,
  type SessionEntry,
} from './sessions.js';
import { projectWorkAgentId, type WorkChannel } from './agent-work-channel-routing.js';
import { WebProjectError } from './web-projects.js';

interface Dependencies {
  catalog: ProjectCatalog;
  registry?: WorkspaceRegistry;
  runner: AgentRunner;
  busy?: (contextKey: string) => boolean;
  hasConnections?: (agentId: string) => boolean;
}
const preparing = new Map<string, number>();
export function beginAgentChannelTurn(platform: string, channel: string): () => void {
  const id = key(platform, channel);
  preparing.set(id, (preparing.get(id) || 0) + 1);
  return () => {
    const n = (preparing.get(id) || 1) - 1;
    if (n) preparing.set(id, n);
    else preparing.delete(id);
  };
}
export async function channelAgentSnapshot(
  platform: string,
  channel: string,
  registry = active?.registry
) {
  const release = beginAgentChannelTurn(platform, channel);
  try {
    const agent = channelAgent(platform, channel);
    if (agent && !registry) throw new Error('Workspace registry is unavailable');
    const workspace = registry
      ? agent
        ? await registry.resolveById(agent.workspaceId || 'default')
        : await registry.resolveById(
            registry.getBinding(platform, channel) || defaultAgentWorkspaceId()
          )
      : undefined;
    return {
      workspaceId: workspace?.id,
      workspacePath: workspace?.path,
      selectedAgentId: agent?.id,
      agentBindingKey: channel,
      selectedAgentConfig: agent
        ? {
            ...agent,
            prompt: ['role' in agent ? agent.role : undefined, agent.prompt]
              .filter(Boolean)
              .join('\n\n'),
          }
        : undefined,
    };
  } finally {
    release();
  }
}
let active: Dependencies | undefined;
let bindings: Record<string, string> = {};
let file: string | undefined;
let teamFile: string | undefined;
let teamBindings: Record<string, string> = {}; // Legacy settings are retired on startup.
const key = (platform: string, channel: string) => JSON.stringify([platform, channel]);
export function registerAgentSelection(dataDir: string, dependencies: Dependencies): void {
  active = dependencies;
  file = join(dataDir, 'channel-agents.json');
  bindings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  teamFile = join(dataDir, 'channel-teams.json');
  teamBindings = existsSync(teamFile) ? JSON.parse(readFileSync(teamFile, 'utf8')) : {};
  if (
    !teamBindings ||
    Array.isArray(teamBindings) ||
    typeof teamBindings !== 'object' ||
    Object.values(teamBindings).some((v) => typeof v !== 'string')
  )
    throw new Error('Invalid channel team settings');
  if (
    !bindings ||
    Array.isArray(bindings) ||
    typeof bindings !== 'object' ||
    Object.values(bindings).some((value) => typeof value !== 'string')
  )
    throw new Error('Invalid channel agent settings');
  const migrated = Object.fromEntries(
    Object.entries(bindings).map(([key, id]) => [key, migrateTeamId(id)])
  );
  if (JSON.stringify(migrated) !== JSON.stringify(bindings)) {
    writeFileSync(file + '.tmp', JSON.stringify(migrated, null, 2) + '\n', { mode: 0o600 });
    renameSync(file + '.tmp', file);
    bindings = migrated;
  }
  let splitTeams = false;
  for (const [channel, id] of Object.entries(bindings)) {
    if (!id.startsWith('team:')) continue;
    teamBindings[channel] ??= id.slice('team:'.length);
    delete bindings[channel];
    splitTeams = true;
  }
  // Retain a backup for inspection; ambiguous multi-channel bindings are all released.
  const counts = new Map<string, number>();
  for (const id of Object.values(bindings)) counts.set(id, (counts.get(id) || 0) + 1);
  const duplicates = Object.entries(bindings).filter(([, id]) => counts.get(id)! > 1);
  if (splitTeams || duplicates.length || Object.keys(teamBindings).length) {
    const backup = join(dataDir, 'channel-assignments-before-single-agent.json');
    if (!existsSync(backup))
      writeFileSync(backup, JSON.stringify({ bindings, teamBindings }, null, 2), { mode: 0o600 });
    for (const [channel] of duplicates) delete bindings[channel];
    teamBindings = {};
    writeFileSync(teamFile + '.tmp', '{}\n', { mode: 0o600 });
    renameSync(teamFile + '.tmp', teamFile);
    writeFileSync(file + '.tmp', JSON.stringify(bindings, null, 2) + '\n', { mode: 0o600 });
    renameSync(file + '.tmp', file);
    console.warn(
      '[agent-selection] Retired channel Team settings and ambiguous Agent assignments; backup:',
      backup
    );
  }
}
export function listSelectableTeams() {
  return active?.catalog.teams() || [];
}
export function listSelectableAgents() {
  return active ? [active.catalog.defaultAgent(), ...active.catalog.agents()] : [];
}
export function retireAgentSession(contextKey: string): void {
  active?.runner.destroy?.(contextKey);
}
export function defaultAgentWorkspaceId(): string {
  return active?.catalog.defaultAgent().workspaceId || 'default';
}
export function agentWorkspaceRegistry(): WorkspaceRegistry | undefined {
  return active?.registry;
}
export function projectSessionAgent(project: SharedProject) {
  const dedicatedAgentId = process.env.XANGI_CONNECTION_AGENT_ID;
  if (dedicatedAgentId) {
    const execution = active!.catalog.execution(undefined, dedicatedAgentId)!;
    return {
      ...execution,
      id: dedicatedAgentId,
      prompt: [project.prompt, execution.prompt].filter(Boolean).join('\n\n'),
    };
  }
  const id = projectWorkAgentId(project);
  const execution = active!.catalog.execution(project.id, id)!;
  return { ...execution, id };
}
export function channelAgent(platform: string, channel: string) {
  const id = process.env.XANGI_CONNECTION_AGENT_ID || bindings[key(platform, channel)];
  const agent =
    id === DEFAULT_TEAM_AGENT_ID
      ? active?.catalog.defaultAgent()
      : id
        ? active?.catalog.agent(id)
        : undefined;
  if (id && !agent)
    throw new Error('設定されたエージェントが見つかりません。担当設定を解除してください');
  return agent;
}
export const channelIndividualAgent = channelAgent;
/** Existing Project and secret conversations retain their original snapshots. */
export function channelAgentSettingsChanged(
  entry: SessionEntry | undefined,
  agent: SharedAgent | undefined
): boolean {
  return Boolean(
    entry &&
    agent &&
    !entry.secret &&
    !entry.projectId &&
    entry.selectedAgentId === agent.id &&
    entry.selectedAgentConfig?.channelSettingsRevision !== agent.channelSettingsRevision
  );
}

export function applyDedicatedAgentSettings(
  settings: DedicatedAgentSettings,
  workspace?: WorkspaceEntry
): void {
  if (!active || settings.id !== process.env.XANGI_CONNECTION_AGENT_ID)
    throw new Error('更新した専用Botの担当設定を確認できません');
  if (workspace) active.registry?.applyDedicatedWorkspace(workspace);
  active.catalog.applyDedicatedAgentSettings(settings);
}

export function saveChannelAgentSettings(
  platform: string,
  channel: string,
  expectedAgentId: string,
  settings: ChannelOverride | { workspaceId: string }
): void {
  if (process.env.XANGI_CONNECTION_AGENT_ID)
    throw new Error('専用Botの担当設定はメインのエージェント設定から変更してください');
  if (!active || channelAgent(platform, channel)?.id !== expectedAgentId)
    throw new Error('担当が変更されました。現在の担当を確認してから保存してください');
  active.catalog.saveChannelAgentSettings(expectedAgentId, { ...settings });
}

/** Channel workspace commands share the same routing on Discord, Slack and Web. */
export async function setChannelWorkspace(
  registry: WorkspaceRegistry,
  platform: 'discord' | 'slack',
  channel: string,
  workspaceId?: string
) {
  const agent = channelAgent(platform, channel);
  if (agent) {
    const workspace = await registry.resolveById(workspaceId ?? 'default');
    if (!registry.getById(workspace.id)) throw new Error('Workspaceが見つかりません');
    saveChannelAgentSettings(platform, channel, agent.id, { workspaceId: workspace.id });
    return { workspace, agent };
  }
  if (workspaceId) return { workspace: await registry.bind(platform, channel, workspaceId) };
  await registry.resetBinding(platform, channel);
  return { workspace: await registry.resolve(platform, channel) };
}

export function agentWorkChannel(agentId: string): WorkChannel | undefined {
  const binding = Object.entries(bindings).find(([, id]) => id === agentId);
  if (!binding) return undefined;
  const [platform, channelId] = JSON.parse(binding[0]) as [string, string];
  if (platform === 'discord' || platform === 'slack') return { platform, channelId };
}
/** Kept only to explicitly reject obsolete API callers. */
export async function changeChannelTeam(_platform: string, _channel: string, _id?: string) {
  throw new Error('Teamのチャンネル設定は廃止しました。team runでチームを指定してください');
}
export function sessionAgent(appSessionId?: string) {
  const entry = appSessionId ? getSessionEntry(appSessionId) : undefined;
  const id = entry?.selectedAgentId;
  if (id && entry?.selectedAgentConfig) {
    const config = entry.selectedAgentConfig;
    if (!config.team) return config;
    const team = upgradeLegacyTeam(config.team);
    return team === config.team
      ? config
      : {
          ...config,
          team,
          prompt: [config.prompt, teamCallerInstructions(team)].filter(Boolean).join('\n\n'),
        };
  }
  if (!id) return undefined;
  return active?.catalog.execution(undefined, id);
}
export function selectedAgentForContext(contextKey: string) {
  const session = getSessionEntry(getActiveSessionId(contextKey) || '');
  const id = session?.selectedAgentId;
  if (id) return sessionAgent(session!.id);
  for (const platform of ['discord', 'slack']) {
    const agent = channelAgent(platform, session?.agentBindingKey || contextKey.split(':')[0]);
    if (agent) return agent;
  }
  return undefined;
}
export function assertIndividualAgentSettings(contextKey: string): void {
  if (
    selectedAgentForContext(contextKey) &&
    !(
      selectedAgentForContext(contextKey)?.team?.leadership === 'caller' &&
      selectedAgentForContext(contextKey)?.id.startsWith('team:')
    )
  )
    throw new Error('Agent指定中です。担当を解除してから個別設定を変更してください');
}
export function resolveAgentBackend(
  resolver: BackendResolver,
  agent: NonNullable<ReturnType<typeof sessionAgent>>
) {
  const global = resolver.resolve();
  const backend = agent.backend || global.backend;
  if (!resolver.isBackendSelectable(backend))
    throw new Error('担当のバックエンドは現在利用できません');
  const sameBackend = backend === global.backend;
  return {
    ...resolver.resolve(undefined, { backend }),
    backend,
    model: agent.model || (sameBackend ? global.model : undefined),
    effort: agent.effort || (sameBackend && !agent.model ? global.effort : undefined),
    localLlmMode: agent.localLlmMode,
    localLlmReasoningEffort: agent.localLlmReasoningEffort,
  };
}
function duplicateAgentChannelError(id: string): Error {
  const current = agentWorkChannel(id)!;
  const destination =
    current.platform === 'discord' ? `<#${current.channelId}>` : current.channelId;
  return new Error(
    `Agentを設定できるチャンネルは最大1つです。現在の設定先: ${current.platform} ${destination}（ID: ${current.channelId}）。現在の割当を解除してから設定してください`
  );
}
export async function changeChannelAgent(
  platform: string,
  channel: string,
  id?: string,
  teamOnly = false
) {
  if (process.env.XANGI_CONNECTION_AGENT_ID)
    throw new Error('専用Botの担当はメインのエージェント接続設定から変更してください');
  if (teamOnly || id?.startsWith('team:')) throw new Error('Teamのチャンネル設定は廃止しました');
  if (!active || !file) throw new Error('エージェント設定はWeb Chat有効時に利用できます');
  if (!['discord', 'slack'].includes(platform) || !channel.trim())
    throw new Error('Discord/Slackのチャンネルを指定してください');
  const candidate =
    id === DEFAULT_TEAM_AGENT_ID
      ? active.catalog.defaultAgent()
      : id
        ? active.catalog.agent(id)
        : undefined;
  if (id && !candidate) throw new Error('エージェントが見つかりません');
  if (bindings[key(platform, channel)] === id) return;
  if (id && Object.entries(bindings).some(([k, v]) => v === id && k !== key(platform, channel)))
    throw duplicateAgentChannelError(id);
  if (id) {
    if (!active.registry) throw new Error('Workspace registry is unavailable');
    await active.registry.resolveById(candidate!.workspaceId || 'default');
  }
  const matching = listAllSessions(true).filter(
    (s) =>
      s.platform === platform &&
      (s.agentBindingKey === channel ||
        s.contextKey === channel ||
        (platform === 'slack' && s.contextKey.startsWith(channel + ':')))
  );
  const affected = matching.filter((s) => getActiveSessionId(s.contextKey) === s.id);
  if (
    (id && agentWorkBusy(id)) ||
    (bindings[key(platform, channel)] && agentWorkBusy(bindings[key(platform, channel)])) ||
    preparing.has(key(platform, channel)) ||
    active.busy?.(channel) ||
    matching.some(
      (s) => active!.busy?.(s.contextKey) || active!.runner.getTimeoutState?.(s.contextKey)?.active
    )
  )
    throw new Error('処理中の会話があります。完了してから担当を変更してください');
  if (id && Object.entries(bindings).some(([k, v]) => v === id && k !== key(platform, channel)))
    throw duplicateAgentChannelError(id);
  const next = { ...bindings };
  if (id) next[key(platform, channel)] = id;
  else delete next[key(platform, channel)];
  writeFileSync(file + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(file + '.tmp', file);
  bindings = next;
  for (const contextKey of new Set(matching.map((session) => session.contextKey)))
    retireAgentSession(contextKey);
  for (const session of affected) closeSession(session.id);
}
export function removeRegisteredAgent(
  id: string,
  catalog: ProjectCatalog,
  isBusy: (id: string) => boolean = () => false
): void {
  if (id === DEFAULT_TEAM_AGENT_ID)
    throw new WebProjectError('既定のエージェントは削除できません', 400);
  if (active?.hasConnections?.(id))
    throw new WebProjectError('個別接続を削除してからエージェントを削除してください', 409);
  if (catalog.list().some((p) => p.defaultAgentId === id))
    throw new WebProjectError('Projectの担当に設定されています', 409);
  if (!catalog.agent(id)) throw new WebProjectError('エージェントが見つかりません', 404);
  const channels = Object.entries(bindings)
    .filter(([, value]) => value === id)
    .map(([k]) => JSON.parse(k).join(':'));
  const sessions = listAllSessions(true).filter(
    (s) =>
      s.selectedAgentId === id &&
      (getSessionLifecycle(s.id) !== 'closed' ||
        isBusy(s.id) ||
        active?.runner.getTimeoutState?.(s.contextKey)?.active)
  );
  if (channels.length || sessions.length)
    throw new WebProjectError(
      '使用中のエージェントです: ' +
        [...channels, ...sessions.map((s) => s.title || s.id)].join(', '),
      409
    );
  catalog.removeAgent(id);
  clearClosedSessionAgentSelections([id]);
}

export function teamSelectionAgent(id: string) {
  return active?.catalog.teamAgent(id);
}
export function removeRegisteredTeam(id: string, catalog: ProjectCatalog): void {
  const selection = `team:${id}`;
  if (catalog.list().some((p) => p.defaultAgentId === selection))
    throw new WebProjectError('Projectの担当に設定されています', 409);
  if (
    Object.values(bindings).includes(selection) ||
    Object.values(teamBindings).includes(id) ||
    listAllSessions(true).some(
      (s) =>
        (s.selectedAgentId === selection || s.selectedAgentConfig?.team?.id === id) &&
        (getSessionLifecycle(s.id) !== 'closed' ||
          active?.runner.getTimeoutState?.(s.contextKey)?.active)
    )
  )
    throw new WebProjectError('使用中のTeamです。担当を解除し、会話を閉じてください', 409);
  catalog.removeTeam(id);
  clearClosedSessionTeamSelections(id);
}

/** Shared UI/CLI guard. Unregister metadata only; never remove workspace files. */
export async function removeRegisteredWorkspace(
  id: string,
  registry: WorkspaceRegistry,
  catalog: ProjectCatalog
) {
  const workspace = registry.getById(id);
  if (!workspace) throw new WebProjectError('Workspaceが見つかりません', 404);
  if (workspace.isDefault) throw new WebProjectError('default Workspaceは登録解除できません', 409);
  const agent = catalog.teamAgents().find((candidate) => candidate.workspaceId === id);
  if (agent) throw new WebProjectError(`Workspaceはエージェント「${agent.name}」で使用中です`, 409);
  if (listAllSessions().some((candidate) => candidate.workspaceId === id))
    throw new WebProjectError('Workspaceは既存の会話で使用中です', 409);
  return registry.unregister(id);
}
