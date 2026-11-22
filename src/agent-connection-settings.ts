import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import {
  applyDedicatedAgentSettings,
  channelAgent,
  setChannelWorkspace,
} from './agent-selection.js';
import type { AgentConnection } from './agent-connections.js';
import { workChannelConnection } from './agent-work-channel-routing.js';
import { formatAgentErrorForUser, ValidationError } from './errors.js';
import type { DedicatedAgentSettings } from './project-catalog.js';
import { executeChatSettings } from './chat-command-settings.js';
import type { WorkspaceEntry, WorkspaceRegistry } from './workspace-registry.js';
import {
  executeRuntimeSettingsCommand,
  type RuntimeSettingsDependencies,
} from './runtime-settings-command.js';

type Change =
  | { name: 'backend'; action: 'set' | 'reset'; backend?: string; model?: string; effort?: string }
  | { name: 'workspace'; action: 'set'; workspaceName: string; path: string }
  | { name: 'workspace'; action: 'use'; workspaceName: string }
  | { name: 'workspace'; action: 'reset' }
  | { name: 'llmmode' | 'llmeffort'; value: string };

type Request = Change & {
  channelId: string;
  userId: string;
};

interface Reply {
  message: string;
  settings: DedicatedAgentSettings;
  workspace?: WorkspaceEntry;
}

interface ParentIpc extends Pick<EventEmitter, 'on' | 'off'> {
  connected?: boolean;
  send?: (message: object, callback: (error: Error | null) => void) => boolean;
}

const requestType = 'agent-connection-settings-update';
const replyType = 'agent-connection-settings-update-result';

function isRequest(value: unknown): value is Request {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  if (typeof request.channelId !== 'string' || typeof request.userId !== 'string') return false;
  switch (request.name) {
    case 'backend':
      return (
        request.action === 'reset' ||
        (request.action === 'set' &&
          typeof request.backend === 'string' &&
          (request.model === undefined || typeof request.model === 'string') &&
          (request.effort === undefined || typeof request.effort === 'string'))
      );
    case 'workspace':
      return (
        request.action === 'reset' ||
        (typeof request.workspaceName === 'string' &&
          (request.action === 'use' ||
            (request.action === 'set' && typeof request.path === 'string')))
      );
    case 'llmmode':
    case 'llmeffort':
      return typeof request.value === 'string' && !!request.value && request.value !== 'status';
    default:
      return false;
  }
}

export function requestDedicatedAgentSettings(
  request: Request,
  ipc: ParentIpc = process
): Promise<string> {
  if (!ipc.connected || !ipc.send)
    return Promise.reject(new ValidationError('親本体に接続できません。設定は保存していません。'));

  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const unknown = () =>
      finish(
        new ValidationError(
          '保存の結果を確認できません。メイン側のエージェント設定を確認してください。'
        )
      );
    function finish(error?: Error, reply?: Reply) {
      clearTimeout(timer);
      ipc.off('message', receive);
      ipc.off('disconnect', unknown);
      if (error) {
        reject(error);
        return;
      }
      try {
        applyDedicatedAgentSettings(reply!.settings, reply!.workspace);
        resolve(reply!.message);
      } catch (error) {
        reject(error);
      }
    }
    function receive(value: unknown) {
      if (!value || typeof value !== 'object') return;
      const reply = value as Record<string, unknown>;
      if (reply.type !== replyType || reply.requestId !== requestId) return;
      if (typeof reply.error === 'string') {
        finish(new ValidationError(reply.error));
      } else if (reply.result && typeof reply.result === 'object') {
        finish(undefined, reply.result as Reply);
      } else {
        unknown();
      }
    }
    const timer = setTimeout(unknown, 45_000);
    ipc.on('message', receive);
    ipc.on('disconnect', unknown);
    try {
      ipc.send!({ type: requestType, requestId, request }, (error) => {
        if (error) unknown();
      });
    } catch {
      unknown();
    }
  });
}

/** Apply a successful parent reply even if the Discord interaction stopped waiting. */
export function installDedicatedAgentSettingsReceiver(): void {
  process.on('message', (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const reply = value as { type?: string; result?: Reply };
    if (reply.type !== replyType || !reply.result?.settings) return;
    try {
      applyDedicatedAgentSettings(reply.result.settings, reply.result.workspace);
    } catch {
      console.warn('[agent-connection] Could not apply saved Agent settings in the worker');
    }
  });
}

export function attachDedicatedAgentSettingsHandler(
  child: ChildProcess,
  connection: AgentConnection,
  connections: AgentConnection[],
  dependencies: RuntimeSettingsDependencies,
  registry: WorkspaceRegistry,
  stopping: () => boolean
): void {
  const receive = (value: unknown) => {
    if (!value || typeof value !== 'object' || !child.connected) return;
    const packet = value as Record<string, unknown>;
    if (packet.type !== requestType || typeof packet.requestId !== 'string') return;
    const send = (body: { result: Reply } | { error: string }) => {
      if (!child.connected) return;
      try {
        child.send({ type: replyType, requestId: packet.requestId, ...body }, () => undefined);
      } catch {
        // The persisted settings are loaded when the connection starts again.
      }
    };

    void (async () => {
      const request = packet.request;
      if (
        stopping() ||
        !connection.enabled ||
        connection.platform !== 'discord' ||
        !isRequest(request)
      )
        throw new ValidationError('専用Botの担当設定を変更できません');
      const allowed = connection.allowedUsers.split(',').map((user) => user.trim());
      if (!allowed.includes('*') && !allowed.includes(request.userId))
        throw new ValidationError('許可されていないユーザーです');
      const agent = channelAgent('discord', request.channelId);
      if (
        agent?.id !== connection.agentId ||
        workChannelConnection(connections, 'discord', connection.agentId)?.id !== connection.id
      )
        throw new ValidationError(
          '担当設定の変更は、この専用Botの作業チャンネルで実行してください'
        );

      const context = { platform: 'discord' as const, channelId: request.channelId };
      let message: string;
      if (request.name === 'workspace') {
        if (dependencies.config?.features?.workspaceSwitching === false)
          throw new ValidationError('この機能は管理者により無効化されています');
        const selected =
          request.action === 'set'
            ? await registry.register(request.workspaceName, request.path)
            : request.action === 'use'
              ? registry.getByName(request.workspaceName)
              : undefined;
        if (request.action === 'use' && !selected)
          throw new ValidationError(`Workspace not found: ${request.workspaceName}`);
        if (channelAgent('discord', request.channelId)?.id !== agent.id)
          throw new ValidationError('担当が変更されました。エージェント設定を確認してください');
        const { workspace } = await setChannelWorkspace(
          registry,
          context.platform,
          context.channelId,
          selected?.id
        );
        message = `${agent.name} の作業場所を \`${workspace.path}\` に設定しました。次のターンから適用されます。`;
      } else if (request.name === 'backend') {
        message = await executeRuntimeSettingsCommand(
          {
            ...context,
            name: 'backend',
            action: request.action,
            scope: 'channel',
            backend: request.backend,
            model: request.model,
            effort: request.effort,
          },
          dependencies
        );
      } else {
        message = await executeChatSettings(request.name, request.value, context, dependencies);
      }
      const updated = channelAgent('discord', request.channelId);
      if (updated?.id !== agent.id || !updated.channelSettingsRevision)
        throw new ValidationError('担当が変更されました。エージェント設定を確認してください');
      const settings: DedicatedAgentSettings = {
        id: updated.id,
        backend: updated.backend,
        model: updated.model,
        effort: updated.effort,
        localLlmMode: updated.localLlmMode,
        localLlmReasoningEffort: updated.localLlmReasoningEffort,
        workspaceId: updated.workspaceId,
        channelSettingsRevision: updated.channelSettingsRevision,
      };
      const workspace = registry.getById(updated.workspaceId ?? 'default');
      send({ result: { message, settings, workspace } });
    })().catch((error: unknown) =>
      send({
        error: error instanceof ValidationError ? error.message : formatAgentErrorForUser(error),
      })
    );
  };
  child.on('message', receive);
  child.once('close', () => child.off('message', receive));
}
