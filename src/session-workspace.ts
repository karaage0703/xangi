import {
  channelAgent,
  channelProject,
  projectChannelAgent,
  defaultAgentWorkspaceId,
  agentWorkspaceRegistry,
  beginAgentChannelTurn,
  retireAgentSession,
} from './agent-selection.js';
import {
  ensureSession,
  closeSession,
  getActiveSessionId,
  getSessionEntry,
  updateSessionAgentBindingKey,
  type SessionScope,
} from './sessions.js';
import type { WorkspaceEntry, WorkspaceRegistry } from './workspace-registry.js';

export interface ResolvedSessionWorkspace {
  appSessionId: string;
  workspace?: WorkspaceEntry;
}

/**
 * Resolves the immutable workspace snapshot for a chat session.
 *
 * Bindings are consulted only when the session is first created. Existing
 * sessions continue using their snapshot even after the channel binding changes.
 */
type WorkspaceOptions = {
  registry?: WorkspaceRegistry;
  platform: string;
  contextKey: string;
  bindingKey: string;
  scope?: SessionScope;
  /** Privacy for a newly created session; existing sessions retain their mode. */
  secret?: boolean;
};
export async function ensureSessionWithWorkspace(
  options: WorkspaceOptions
): Promise<ResolvedSessionWorkspace> {
  const release = beginAgentChannelTurn(options.platform, options.bindingKey);
  try {
    return await resolveSessionWithWorkspace(options);
  } finally {
    release();
  }
}
async function resolveSessionWithWorkspace(
  options: WorkspaceOptions
): Promise<ResolvedSessionWorkspace> {
  const { platform, contextKey, bindingKey, scope } = options;
  const registry = options.registry ?? agentWorkspaceRegistry();
  if (!registry) {
    return {
      appSessionId: ensureSession(contextKey, { platform, scope, secret: options.secret }),
    };
  }

  let activeId = getActiveSessionId(contextKey);
  let activeEntry = activeId ? getSessionEntry(activeId) : undefined;
  const secret = activeEntry?.secret ?? options.secret ?? false;
  const project = secret ? undefined : channelProject(platform, bindingKey);
  const agent =
    (project && projectChannelAgent(platform, bindingKey)) || channelAgent(platform, bindingKey);
  if (
    activeId &&
    !project &&
    !activeEntry?.projectId &&
    (activeEntry?.selectedAgentId !== agent?.id || activeEntry?.selectedAgentConfig?.team)
  ) {
    retireAgentSession(contextKey);
    closeSession(activeId);
    activeId = undefined;
    activeEntry = undefined;
  }
  if (activeId && activeEntry) {
    const workspaceId = activeEntry.workspaceId ?? 'default';
    const workspace = activeEntry.workspacePath
      ? await registry.resolveSnapshot(workspaceId, activeEntry.workspacePath)
      : await registry.resolveById(workspaceId);
    if (
      getActiveSessionId(contextKey) !== activeId ||
      (!project && !activeEntry.projectId && channelAgent(platform, bindingKey)?.id !== agent?.id)
    )
      return resolveSessionWithWorkspace(options);
    if (!activeEntry.agentBindingKey) updateSessionAgentBindingKey(activeId, bindingKey);
    return { appSessionId: activeId, workspace };
  }

  const workspace =
    agent && (!agent.team || (agent.team.leadership === 'caller' && !agent.id.startsWith('team:')))
      ? await registry.resolveById(agent.workspaceId || 'default')
      : await registry.resolveById(
          registry.getBinding(platform, bindingKey) || defaultAgentWorkspaceId()
        );
  if (!project && channelAgent(platform, bindingKey)?.id !== agent?.id)
    return ensureSessionWithWorkspace(options);
  const appSessionId = ensureSession(contextKey, {
    platform,
    secret,
    scope,
    projectId: project?.id,
    selectedAgentId: agent?.id,
    selectedAgentConfig: agent
      ? {
          ...agent,
          prompt: ['role' in agent ? agent.role : undefined, agent.prompt]
            .filter(Boolean)
            .join('\n\n'),
        }
      : undefined,
    agentBindingKey: bindingKey,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
  });
  const persistedEntry = getSessionEntry(appSessionId);
  const workspaceId = persistedEntry?.workspaceId ?? 'default';
  const persistedWorkspace = persistedEntry?.workspacePath
    ? await registry.resolveSnapshot(workspaceId, persistedEntry.workspacePath)
    : await registry.resolveById(workspaceId);
  return { appSessionId, workspace: persistedWorkspace };
}
