import {
  ensureSession,
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
export async function ensureSessionWithWorkspace(options: {
  registry?: WorkspaceRegistry;
  platform: string;
  contextKey: string;
  bindingKey: string;
  scope?: SessionScope;
}): Promise<ResolvedSessionWorkspace> {
  const { registry, platform, contextKey, bindingKey, scope } = options;
  if (!registry) {
    return {
      appSessionId: ensureSession(contextKey, { platform, scope }),
    };
  }

  const activeId = getActiveSessionId(contextKey);
  const activeEntry = activeId ? getSessionEntry(activeId) : undefined;
  if (activeId && activeEntry) {
    const registeredWorkspace = activeEntry.workspaceId
      ? await registry.resolveById(activeEntry.workspaceId)
      : await registry.resolveById('default');
    const workspace = activeEntry.workspacePath
      ? await registry.resolveSnapshot(registeredWorkspace.id, activeEntry.workspacePath)
      : registeredWorkspace;
    return { appSessionId: activeId, workspace };
  }

  const workspace = await registry.resolve(platform, bindingKey);
  const appSessionId = ensureSession(contextKey, {
    platform,
    scope,
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
