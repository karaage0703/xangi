import type { ProjectCatalog } from './project-catalog.js';
import type { WorkspaceEntry, WorkspaceRegistry } from './workspace-registry.js';
import { createWebSession, getSessionEntry, getSessionLifecycle } from './sessions.js';
import type { WebCommandResult } from './web-slash-commands.js';

export interface WebSelectionContext {
  appSessionId?: string;
  catalog: ProjectCatalog;
  registry?: WorkspaceRegistry;
  resolveWorkspace: (id?: string) => Promise<WorkspaceEntry>;
  resolveSessionWorkspace: (id: string) => Promise<WorkspaceEntry>;
  busy: (id: string) => boolean;
}

/** Switching creates a new conversation; the old transcript and workspace snapshot stay intact. */
export async function executeWebSelection(
  name: 'agent' | 'workspace',
  args: string[],
  ctx: WebSelectionContext
): Promise<WebCommandResult> {
  const action = args[0] || 'status';
  const text = (message: string): WebCommandResult => ({ kind: 'message', message });
  if (action === 'list' && args.length <= 1) {
    const entries = name === 'agent' ? ctx.catalog.teamAgents() : ctx.registry?.list() || [];
    return text(
      entries.map((entry) => `${entry.name}: ${entry.id}`).join('\n') ||
        '登録済みの項目はありません'
    );
  }
  const entry = ctx.appSessionId ? getSessionEntry(ctx.appSessionId) : undefined;
  if (!entry || entry.platform !== 'web') {
    throw new Error(
      'Web会話を開いてから実行してください。Discord・Slackの担当と作業場所は設定画面から変更できます。'
    );
  }
  if (action === 'status' && args.length <= 1) {
    if (name === 'agent') {
      const agent = entry.selectedAgentId
        ? ctx.catalog.execution(entry.projectId, entry.selectedAgentId, entry.selectedAgentConfig)
        : undefined;
      return text(
        `この会話の担当: ${agent?.name || '個別設定（担当指定なし）'}${entry.selectedAgentId ? ` (${entry.selectedAgentId})` : ''}`
      );
    }
    const workspace = await ctx.resolveSessionWorkspace(entry.id);
    return text(`この会話の作業場所: ${workspace.name}\n\`${workspace.path}\``);
  }
  const valid =
    name === 'agent'
      ? (action === 'set' && args.length === 2) || (action === 'reset' && args.length === 1)
      : (action === 'use' && args.length === 2) ||
        (action === 'set' && args.length === 3) ||
        (action === 'reset' && args.length === 1);
  if (!valid)
    throw new Error(
      name === 'agent'
        ? '使い方: /agent list|status|set <id>|reset'
        : '使い方: /workspace status|list|use <name>|set <name> <path>|reset'
    );
  if (getSessionLifecycle(entry.id) === 'closed')
    throw new Error('終了済みの会話は再開してから切り替えてください');
  if (ctx.busy(entry.id))
    throw new Error('実行中は切り替えられません。完了後、または /stop の後に実行してください');

  let agentId: string | undefined;
  let workspace: WorkspaceEntry;
  if (name === 'agent') {
    if (action === 'set') {
      const agents = ctx.catalog.teamAgents();
      const matches = agents.filter((agent) => agent.name === args[1]);
      const agent =
        agents.find((agent) => agent.id === args[1]) ||
        (matches.length === 1 ? matches[0] : undefined);
      if (!agent)
        throw new Error(
          'Agentが見つからないか、同名のAgentがあります。/agent list のIDを指定してください'
        );
      agentId = agent.id;
    }
    workspace = await ctx.resolveWorkspace(
      agentId ? ctx.catalog.execution(entry.projectId, agentId)?.workspaceId : undefined
    );
  } else {
    if (!ctx.registry) throw new Error('Workspace registry is unavailable');
    if (entry.selectedAgentId)
      throw new Error(
        '担当Agentの作業場所は固定です。/agent reset で担当指定を解除してから切り替えてください'
      );
    if (action === 'set') workspace = await ctx.registry.register(args[1], args[2]);
    else if (action === 'use') {
      const selected = ctx.registry.getByName(args[1]);
      if (!selected) throw new Error(`Workspace not found: ${args[1]}`);
      workspace = await ctx.registry.resolveById(selected.id);
    } else workspace = await ctx.resolveWorkspace();
  }
  const sessionId = createWebSession({
    projectId: entry.projectId,
    secret: entry.secret,
    selectedAgentId: agentId,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
  });
  return { kind: 'session', sessionId };
}
