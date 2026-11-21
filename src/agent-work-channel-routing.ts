import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConnection } from './agent-connections.js';
import { DEFAULT_TEAM_AGENT_ID } from './teams.js';
import { WebProjectError, type WebProject } from './web-projects.js';

export type WorkChannel = { platform: 'discord' | 'slack'; channelId: string };
export type ConnectionRoute = Pick<AgentConnection, 'id' | 'agentId' | 'platform' | 'enabled'>;

export function sameWorkChannel(left: WorkChannel, right: unknown): boolean {
  return Boolean(
    right &&
    typeof right === 'object' &&
    'platform' in right &&
    right.platform === left.platform &&
    'channelId' in right &&
    right.channelId === left.channelId
  );
}

export function projectWorkAgentId(project: Pick<WebProject, 'defaultAgentId'>): string {
  return project.defaultAgentId || DEFAULT_TEAM_AGENT_ID;
}

export function readWorkChannelAgent(
  dataDir: string,
  platform: string,
  channelId: string
): string | undefined {
  try {
    const bindings = JSON.parse(
      readFileSync(join(dataDir, 'channel-agents.json'), 'utf8')
    ) as Record<string, string>;
    return bindings[JSON.stringify([platform, channelId])];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function workChannelConnection<T extends ConnectionRoute>(
  connections: T[],
  platform: WorkChannel['platform'],
  agentId: string
): T | undefined {
  const matching = connections.filter(
    (item) => item.agentId === agentId && item.platform === platform
  );
  if (!matching.length) return undefined;
  const enabled = matching.filter((item) => item.enabled);
  if (enabled.length !== 1) {
    throw new WebProjectError(
      enabled.length
        ? '担当の専用Botを1つだけ有効にしてください'
        : '担当の専用Botが無効です。エージェント設定を確認してください',
      409
    );
  }
  return enabled[0];
}

export function acceptsWorkChannelMessage(
  dataDir: string,
  connections: ConnectionRoute[],
  platform: WorkChannel['platform'],
  channelId: string,
  ownConnectionId?: string
): boolean {
  const agentId = readWorkChannelAgent(dataDir, platform, channelId);
  if (!agentId) return true;
  const dedicated = workChannelConnection(connections, platform, agentId);
  return dedicated?.id === ownConnectionId;
}
