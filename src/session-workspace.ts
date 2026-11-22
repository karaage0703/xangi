import {
  channelAgent,
  channelAgentSettingsChanged,
  projectSessionAgent,
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
import type { SharedProject } from './project-catalog.js';
import type { WorkspaceEntry, WorkspaceRegistry } from './workspace-registry.js';

export interface ResolvedSessionWorkspace {
  appSessionId: string;
  workspace?: WorkspaceEntry;
}

/**
 * Resolves the immutable workspace snapshot for a chat session.
 *
 * Ordinary workspace bindings apply at session creation. When an assigned Agent
 * is edited through channel settings, the next turn starts with a fresh snapshot.
 */
type WorkspaceOptions = {
  registry?: WorkspaceRegistry;
  platform: string;
  contextKey: string;
  bindingKey: string;
  scope?: SessionScope;
  /** Privacy for a newly created session; existing sessions retain their mode. */
  secret?: boolean;
  project?: SharedProject;
  webLinked?: boolean;
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
  const { platform, contextKey, bindingKey } = options;
  const registry = options.registry ?? agentWorkspaceRegistry();
  if (!registry) {
    return {
      appSessionId: ensureSession(contextKey, {
        platform,
        scope: options.scope,
        secret: options.secret,
        webLinked: options.webLinked,
      }),
    };
  }

  let activeId = getActiveSessionId(contextKey);
  let activeEntry = activeId ? getSessionEntry(activeId) : undefined;
  const secret = activeEntry?.secret ?? options.secret ?? false;
  const webLinked = options.webLinked ?? activeEntry?.webLinked;
  const scope = options.scope ?? activeEntry?.scope;
  const project = secret ? undefined : options.project;
  const boundAgent = project ? undefined : channelAgent(platform, bindingKey);
  const agent = project ? projectSessionAgent(project) : boundAgent;
  const bindingChanged = () => {
    const current = channelAgent(platform, bindingKey);
    return (
      current?.id !== boundAgent?.id ||
      current?.channelSettingsRevision !== boundAgent?.channelSettingsRevision
    );
  };
  if (
    activeId &&
    !project &&
    !activeEntry?.projectId &&
    (activeEntry?.selectedAgentId !== agent?.id ||
      activeEntry?.selectedAgentConfig?.team ||
      channelAgentSettingsChanged(activeEntry, boundAgent))
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
      (!project && !activeEntry.projectId && bindingChanged())
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
  if (!project && bindingChanged()) return resolveSessionWithWorkspace(options);
  const appSessionId = ensureSession(contextKey, {
    platform,
    secret,
    scope,
    projectId: project?.id,
    webLinked,
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
