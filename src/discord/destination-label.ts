import type { Client } from 'discord.js';
import type { Schedule } from '../scheduler.js';

type NamedDiscordChannel = {
  name?: string | null;
  isThread?: () => boolean;
  parent?: { name?: string | null } | null;
};

export function formatDiscordDestinationLabel(channel: NamedDiscordChannel): string | undefined {
  const name = channel.name?.trim();
  if (!name) return undefined;

  if (channel.isThread?.()) {
    const parentName = channel.parent?.name?.trim();
    return parentName ? `#${parentName} / ${name}` : name;
  }

  return `#${name}`;
}

/** Resolve from discord.js' in-memory cache so Web API responses never wait on Discord. */
export function resolveCachedDiscordDestinationLabel(
  client: Client,
  channelId: string
): string | undefined {
  const channel = client.channels.cache.get(channelId);
  return channel ? formatDiscordDestinationLabel(channel as NamedDiscordChannel) : undefined;
}

/** Warm only the destinations used by schedules; failures keep the ID fallback intact. */
export async function warmDiscordScheduleDestinations(
  client: Client,
  schedules: Schedule[]
): Promise<void> {
  const channelIds = [
    ...new Set(
      schedules
        .filter((schedule) => schedule.platform === 'discord')
        .map((schedule) => schedule.channelId)
        .filter(Boolean)
    ),
  ];

  await Promise.allSettled(
    channelIds.map(async (channelId) => {
      if (!client.channels.cache.has(channelId)) {
        await client.channels.fetch(channelId);
      }
    })
  );
}
