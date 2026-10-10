import {
  channelAgent,
  agentWorkspaceRegistry,
  beginAgentChannelTurn,
  retireAgentSession,
} from './agent-selection.js';
import {
  ensureSession,
  closeSession,
  getActiveSessionId,
  getSessionEntry,
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
  const agent = channelAgent(platform, bindingKey);
  if (
    activeId &&
    (activeEntry?.selectedAgentId !== agent?.id || activeEntry?.selectedAgentConfig?.team)
  ) {
    retireAgentSession(contextKey);
    closeSession(activeId);
    activeId = undefined;
    activeEntry = undefined;
  }
  if (activeId && activeEntry) {
    const registeredWorkspace = activeEntry.workspaceId
      ? await registry.resolveById(activeEntry.workspaceId)
      : await registry.resolveById('default');
    const workspace = activeEntry.workspacePath
      ? await registry.resolveSnapshot(registeredWorkspace.id, activeEntry.workspacePath)
      : registeredWorkspace;
    if (
      getActiveSessionId(contextKey) !== activeId ||
      channelAgent(platform, bindingKey)?.id !== agent?.id
    )
      return resolveSessionWithWorkspace(options);
    return { appSessionId: activeId, workspace };
  }

  const workspace =
    agent && (!agent.team || (agent.team.leadership === 'caller' && !agent.id.startsWith('team:')))
      ? await registry.resolveById(agent.workspaceId || 'default')
      : await registry.resolve(platform, bindingKey);
  if (channelAgent(platform, bindingKey)?.id !== agent?.id)
    return ensureSessionWithWorkspace(options);
  const appSessionId = ensureSession(contextKey, {
    platform,
    secret,
    scope,
    selectedAgentId: agent?.id,
    selectedAgentConfig: agent
      ? { ...agent, prompt: [agent.role, agent.prompt].filter(Boolean).join('\n\n') }
      : undefined,
    agentBindingKey: bindingKey,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
  });
  const persistedEntry = getSessionEntry(appSessionId);
  const registeredWorkspace = persistedEntry?.workspaceId
    ? await registry.resolveById(persistedEntry.workspaceId)
    : await registry.resolveById('default');
  const persistedWorkspace = persistedEntry?.workspacePath
    ? await registry.resolveSnapshot(registeredWorkspace.id, persistedEntry.workspacePath)
    : registeredWorkspace;
  return { appSessionId, workspace: persistedWorkspace };
}
