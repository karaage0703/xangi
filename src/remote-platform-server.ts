import type { IncomingMessage, ServerResponse } from 'http';
import { timingSafeEqual } from 'crypto';
import type { AgentRunner } from './agent-runner.js';
import type { BackendResolver } from './backend-resolver.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import type { Config } from './config.js';
import { threadIdFor, turnIdFor } from './events-emitter.js';
import {
  ensureSession,
  getSession,
  getSessionEntry,
  incrementMessageCount,
  setSession,
  updateSessionTitle,
} from './sessions.js';
import { ensureSessionWithWorkspace } from './session-workspace.js';
import { truncateSessionTitle } from './session-title.js';
import { readJsonBody, sendJson } from './web-http.js';
import type { WorkspaceRegistry } from './workspace-registry.js';

export const REMOTE_PLATFORM_TURN_PATH = '/api/remote-platform/turn';
const busySessions = new Set<string>();
const MAX_ATTACHMENTS = 20;

type RemotePlatform = 'discord' | 'slack';

interface RemotePlatformTurn {
  platform: RemotePlatform;
  contextKey: string;
  settingsChannelId: string;
  channelId: string;
  messageId: string;
  userId: string;
  userName: string;
  text: string;
  channelName?: string;
  threadId?: string;
  threadName?: string;
  parentChannelName?: string;
  attachments?: string[];
}

export interface RemotePlatformServerDeps {
  agentRunner: AgentRunner;
  config?: Config;
  resolver?: BackendResolver;
  workspaceRegistry?: WorkspaceRegistry;
}

function authorized(req: IncomingMessage): boolean {
  const configured = process.env.XANGI_REMOTE_PLATFORM_TOKEN?.trim();
  if (!configured) return false;
  const provided = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  const expectedBytes = Buffer.from(configured);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)
  );
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = typeof body[key] === 'string' ? body[key].trim() : '';
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function parseRemotePlatformTurn(body: Record<string, unknown>): RemotePlatformTurn {
  const platform = requiredString(body, 'platform');
  if (platform !== 'discord' && platform !== 'slack') {
    throw new Error('platform must be discord or slack');
  }
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .filter((value): value is string => typeof value === 'string' && value.length <= 4096)
        .slice(0, MAX_ATTACHMENTS)
    : undefined;
  return {
    platform,
    contextKey: requiredString(body, 'contextKey'),
    settingsChannelId: requiredString(body, 'settingsChannelId'),
    channelId: requiredString(body, 'channelId'),
    messageId: requiredString(body, 'messageId'),
    userId: requiredString(body, 'userId'),
    userName: requiredString(body, 'userName'),
    text: requiredString(body, 'text'),
    channelName: typeof body.channelName === 'string' ? body.channelName : undefined,
    threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
    threadName: typeof body.threadName === 'string' ? body.threadName : undefined,
    parentChannelName:
      typeof body.parentChannelName === 'string' ? body.parentChannelName : undefined,
    attachments,
  };
}

export function buildRemotePlatformPrompt(input: RemotePlatformTurn): string {
  const platformName = input.platform === 'discord' ? 'Discord' : 'Slack';
  const lines = [
    `[プラットフォーム: ${platformName}]`,
    `[チャンネル: ${input.channelName ? `#${input.channelName} ` : ''}(ID: ${input.channelId})]`,
  ];
  if (input.threadId) {
    lines.push(`[スレッド: ${input.threadName ?? input.threadId} (ID: ${input.threadId})]`);
  }
  if (input.parentChannelName) lines.push(`[親チャンネル: #${input.parentChannelName}]`);
  lines.push(`[発言者: ${input.userName} (ID: ${input.userId})]`);
  if (input.attachments?.length) {
    lines.push(`[添付ファイル]\n${input.attachments.map((path) => `- ${path}`).join('\n')}`);
  }
  lines.push(input.text);
  return lines.join('\n');
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function handleRemotePlatformRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RemotePlatformServerDeps
): Promise<boolean> {
  const path = (req.url || '/').split('?')[0];
  if (path !== REMOTE_PLATFORM_TURN_PATH) return false;
  if (process.env.XANGI_REMOTE_PLATFORM_ENABLED !== 'true') {
    sendJson(res, 404, { error: 'Remote platform adapter is disabled' });
    return true;
  }
  if (!process.env.XANGI_REMOTE_PLATFORM_TOKEN?.trim()) {
    sendJson(res, 503, { error: 'Remote platform adapter token is not configured' });
    return true;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  let input: RemotePlatformTurn;
  try {
    input = parseRemotePlatformTurn(await readJsonBody(req));
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }

  const resolved = await ensureSessionWithWorkspace({
    registry: deps.workspaceRegistry,
    platform: input.platform,
    contextKey: input.contextKey,
    bindingKey: input.settingsChannelId,
  });
  const appSessionId = resolved.appSessionId;
  if (busySessions.has(appSessionId)) {
    sendJson(res, 409, { error: 'Session is busy' });
    return true;
  }
  busySessions.add(appSessionId);
  const sessionWorkdir =
    resolved.workspace?.path ?? deps.config?.agent.config.workdir ?? process.cwd();
  ensureSession(input.contextKey, { platform: input.platform });
  const providerSessionId = getSession(input.contextKey);
  const backend = deps.resolver?.resolve(input.contextKey);
  const prompt = buildRemotePlatformPrompt(input);
  const eventContext = {
    threadId: threadIdFor(input.platform, input.contextKey),
    turnId: turnIdFor(input.platform, input.messageId),
    threadLabel: input.threadName ?? input.channelName,
    platform: input.platform,
    userText: input.text,
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  writeSse(res, 'started', { appSessionId });
  try {
    const result = await runWithBubbleEvents(
      deps.agentRunner,
      prompt,
      eventContext,
      {
        onText: (_chunk, fullText) => writeSse(res, 'text', { fullText }),
        onToolUse: (toolName, toolInput) => writeSse(res, 'tool', { toolName, toolInput }),
        onError: (error) => writeSse(res, 'error', { message: error.message }),
      },
      {
        sessionId: providerSessionId,
        channelId: input.contextKey,
        settingsChannelId: input.settingsChannelId,
        appSessionId,
        platform: input.platform,
        defaultBackend: backend?.backend,
        defaultModel: backend?.model,
        defaultEffort: backend?.effort,
        workdir: sessionWorkdir,
        skipPermissions: deps.config?.agent.config.skipPermissions,
      }
    );
    setSession(input.contextKey, result.sessionId);
    incrementMessageCount(appSessionId);
    const entry = getSessionEntry(appSessionId);
    if (entry && !entry.title) updateSessionTitle(appSessionId, truncateSessionTitle(input.text));
    writeSse(res, 'done', {
      response: result.result,
      attachments: result.attachments ?? [],
      appSessionId,
    });
  } catch (error) {
    writeSse(res, 'error', { message: error instanceof Error ? error.message : String(error) });
  } finally {
    busySessions.delete(appSessionId);
    res.end();
  }
  return true;
}
