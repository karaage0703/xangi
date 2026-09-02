export type ExternalChatPlatform = 'discord' | 'slack';

export interface ExternalChatUrlInput {
  contextKey: string;
  platformMessageId?: string;
}

export type ExternalChatUrlResolver = (input: ExternalChatUrlInput) => Promise<string | undefined>;

export type ExternalChatUrlResolvers = Partial<
  Record<ExternalChatPlatform, ExternalChatUrlResolver>
>;

export function discordChannelUrl(contextKey: string, guildId?: string): string | undefined {
  if (!/^\d+$/.test(contextKey)) return undefined;
  if (guildId && /^\d+$/.test(guildId)) {
    return `https://discord.com/channels/${guildId}/${contextKey}`;
  }
  return `https://discord.com/channels/@me/${contextKey}`;
}

export function slackPermalinkTarget(
  contextKey: string,
  platformMessageId?: string
): { channel: string; messageTs: string } | undefined {
  const separator = contextKey.indexOf(':');
  const channel = separator >= 0 ? contextKey.slice(0, separator) : contextKey;
  const threadTs = separator >= 0 ? contextKey.slice(separator + 1) : '';
  const messageTs = threadTs || platformMessageId || '';
  if (!/^[A-Z0-9]+$/.test(channel) || !/^\d+\.\d+$/.test(messageTs)) return undefined;
  return { channel, messageTs };
}

export function isAllowedExternalChatUrl(platform: ExternalChatPlatform, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (platform === 'discord') return url.hostname === 'discord.com';
    return url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com');
  } catch {
    return false;
  }
}
