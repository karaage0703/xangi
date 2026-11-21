import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withPathMutation } from './path-mutation.js';
import { writePrivateJsonFile } from './setup/private-json-file.js';
import { validateSettingValue } from './cli/settings-cmd.js';
import { WebProjectError } from './web-projects.js';

export interface AgentConnection {
  id: string;
  agentId: string;
  platform: 'discord' | 'slack';
  name: string;
  enabled: boolean;
  allowedUsers: string;
  botToken: string;
  appToken?: string;
}
export type ConnectionStatus = 'starting' | 'ready' | 'failed' | 'stopped';
export const agentConnectionStatus = new Map<string, ConnectionStatus>();

/** Credentials stay in a private state file, never in catalog/API responses. */
export class AgentConnectionStore {
  readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'agent-connections.json');
  }

  async read(): Promise<AgentConnection[]> {
    let document;
    try {
      document = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('個別接続の設定を読み込めません');
    }
    if (document?.version !== 1 || !Array.isArray(document.connections))
      throw new Error('個別接続の設定形式が不正です');
    const seen = new Set<string>();
    for (const connection of document.connections) {
      if (
        !connection ||
        typeof connection.id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(connection.id) ||
        typeof connection.agentId !== 'string' ||
        !connection.agentId ||
        seen.has(connection.id)
      )
        throw new Error('個別接続のIDが不正です');
      seen.add(connection.id);
      this.normalize(connection, connection);
    }
    return document.connections.map((connection: AgentConnection) => ({
      ...this.normalize(connection as unknown as Record<string, unknown>, connection),
      id: connection.id,
      agentId: connection.agentId,
    }));
  }

  hasAgent(agentId: string): boolean {
    try {
      const document = JSON.parse(readFileSync(this.path, 'utf8'));
      return document.connections.some((c: AgentConnection) => c.agentId === agentId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error('個別接続を確認できないためエージェントを削除できません');
    }
  }

  async list(agentId: string) {
    return (await this.read()).filter((c) => c.agentId === agentId).map((c) => this.public(c));
  }

  public(connection: AgentConnection) {
    return {
      id: connection.id,
      agentId: connection.agentId,
      platform: connection.platform,
      name: connection.name,
      enabled: connection.enabled,
      allowedUsers: connection.allowedUsers,
      credentialsConfigured: true,
      status: agentConnectionStatus.get(connection.id) || 'stopped',
      applyMode: 'restart' as const,
    };
  }

  async save(agentId: string, input: Record<string, unknown>, id?: string) {
    return withPathMutation(this.path, async () => {
      const connections = await this.read();
      const previous = id
        ? connections.find((c) => c.id === id && c.agentId === agentId)
        : undefined;
      if (id && !previous) throw new WebProjectError('接続が見つかりません', 404);
      const connection = { ...this.normalize(input, previous), agentId, id: id || randomUUID() };
      const duplicate = connections.some(
        (c) =>
          c.id !== id &&
          c.platform === connection.platform &&
          (c.botToken === connection.botToken || (c.appToken && c.appToken === connection.appToken))
      );
      const commonToken =
        process.env[connection.platform === 'discord' ? 'DISCORD_TOKEN' : 'SLACK_BOT_TOKEN'];
      if (
        duplicate ||
        commonToken === connection.botToken ||
        (connection.platform === 'slack' && connection.appToken === process.env.SLACK_APP_TOKEN)
      )
        throw new WebProjectError(
          'このBotまたはAppは別の接続で使用されています。専用Botを作成してください',
          400
        );
      const next = connections.filter((c) => c.id !== id);
      next.push(connection);
      await writePrivateJsonFile(this.path, { version: 1, connections: next });
      return this.public(connection);
    });
  }

  async remove(agentId: string, id: string) {
    await withPathMutation(this.path, async () => {
      const connections = await this.read();
      if (!connections.some((c) => c.id === id && c.agentId === agentId))
        throw new WebProjectError('接続が見つかりません', 404);
      await writePrivateJsonFile(this.path, {
        version: 1,
        connections: connections.filter((c) => c.id !== id),
      });
    });
  }

  private normalize(
    input: Record<string, unknown>,
    previous?: AgentConnection
  ): Omit<AgentConnection, 'id' | 'agentId'> {
    const platform = input.platform ?? previous?.platform;
    if (platform !== 'discord' && platform !== 'slack')
      throw new WebProjectError('DiscordまたはSlackを選んでください', 400);
    if (previous && platform !== previous.platform)
      throw new WebProjectError('接続サービスは変更できません。接続を作り直してください', 400);
    const name = input.name === undefined ? (previous?.name ?? '') : input.name;
    if (typeof name !== 'string' || name.length > 80)
      throw new WebProjectError('接続名は80文字以内の文字列で指定してください', 400);
    const enabled = input.enabled ?? previous?.enabled ?? true;
    if (typeof enabled !== 'boolean') throw new WebProjectError('有効設定が不正です', 400);
    const users = input.allowedUsers ?? previous?.allowedUsers;
    if (typeof users !== 'string' || !users.trim())
      throw new WebProjectError('許可ユーザーIDを指定してください', 400);
    const allowedUsers = validateSettingValue(
      platform === 'discord' ? 'DISCORD_ALLOWED_USER' : 'SLACK_ALLOWED_USER',
      users
    );
    const token = (key: 'botToken' | 'appToken') => {
      const value = input[key];
      if (value !== undefined && typeof value !== 'string')
        throw new WebProjectError('トークンは文字列で指定してください', 400);
      const result = (typeof value === 'string' ? value.trim() : '') || previous?.[key];
      if (!result || result.length > 4096 || /\s/.test(result))
        throw new WebProjectError('有効なトークンを指定してください', 400);
      return result;
    };
    return {
      platform,
      name: name.trim(),
      enabled,
      allowedUsers,
      botToken: token('botToken'),
      ...(platform === 'slack' ? { appToken: token('appToken') } : {}),
    };
  }
}
