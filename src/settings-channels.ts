import { WebClient, type WebClientOptions } from '@slack/web-api';
import type { Client } from 'discord.js';
import { formatDiscordDestinationLabel } from './discord/destination-label.js';

export type SettingsPlatform = 'discord' | 'slack';

export interface SettingsChannel {
  id: string;
  name: string;
  group?: string;
}

export type SettingsChannelLister = () => Promise<SettingsChannel[]>;

export const SETTINGS_CHANNEL_LIST_TIMEOUT_MS = 10_000;
export const SLACK_SETTINGS_CHANNEL_CACHE_TTL_MS = 60_000;

export const SLACK_SETTINGS_WEB_CLIENT_OPTIONS = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
  timeout: 8_000,
} satisfies WebClientOptions;

export class SettingsChannelListTimeoutError extends Error {
  constructor() {
    super('settings channel list timed out');
    this.name = 'SettingsChannelListTimeoutError';
  }
}

export interface SettingsChannelListers {
  discord?: SettingsChannelLister;
  slack?: SettingsChannelLister;
}

type SlackApiErrorLike = {
  code?: unknown;
  retryAfter?: unknown;
  data?: {
    error?: unknown;
  };
};

export function settingsChannelListErrorMessage(
  platform: SettingsPlatform,
  error: unknown
): string {
  if (error instanceof SettingsChannelListTimeoutError) {
    return `${platform === 'discord' ? 'Discord' : 'Slack'}チャンネル一覧の取得がタイムアウトしました。接続を確認してから再読み込みしてください。`;
  }
  if (platform === 'slack') {
    const slackError = error as SlackApiErrorLike;
    const errorCode = slackError?.data?.error;
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (slackError?.code === 'slack_webapi_rate_limited_error') {
      const retryAfter =
        typeof slackError.retryAfter === 'number' && slackError.retryAfter > 0
          ? `${Math.ceil(slackError.retryAfter)}秒`
          : 'しばらく';
      return `Slack APIの呼び出し上限に達しました。${retryAfter}待ってから一覧を再読み込みしてください。`;
    }
    if (errorCode === 'missing_scope' || rawMessage.includes('missing_scope')) {
      return 'Slack Appの権限が不足しています。Bot Token Scopesへ channels:read / groups:read を追加し、ワークスペースへ再インストールしてから一覧を再読み込みしてください。';
    }
  }
  return `チャンネル一覧を取得できません: ${error instanceof Error ? error.message : String(error)}`;
}

export function listSettingsChannelsWithTimeout(
  lister: SettingsChannelLister,
  timeoutMs = SETTINGS_CHANNEL_LIST_TIMEOUT_MS
): Promise<SettingsChannel[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SettingsChannelListTimeoutError()), timeoutMs);
    void lister()
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

export async function listDiscordSettingsChannels(client: Client): Promise<SettingsChannel[]> {
  const channels: SettingsChannel[] = [];

  for (const channel of client.channels.cache.values()) {
    if (!('guildId' in channel) || !channel.isTextBased() || channel.isThread()) continue;
    const name = formatDiscordDestinationLabel(channel);
    if (!name) continue;
    const group = 'guild' in channel ? channel.guild.name : undefined;
    channels.push({ id: channel.id, name, ...(group ? { group } : {}) });
  }

  return channels.sort((left, right) =>
    `${left.group || ''}\u0000${left.name}`.localeCompare(
      `${right.group || ''}\u0000${right.name}`,
      'ja'
    )
  );
}

export async function listSlackSettingsChannels(client: WebClient): Promise<SettingsChannel[]> {
  const channels: SettingsChannel[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.users.conversations({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 999,
      ...(cursor ? { cursor } : {}),
    });
    for (const channel of response.channels || []) {
      if (!channel.id || !channel.name) continue;
      channels.push({ id: channel.id, name: `#${channel.name}` });
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels.sort((left, right) => left.name.localeCompare(right.name, 'ja'));
}

export function createSlackSettingsChannelLister(
  token: string,
  cacheTtlMs = SLACK_SETTINGS_CHANNEL_CACHE_TTL_MS
): SettingsChannelLister {
  const client = createSlackSettingsWebClient(token);
  return cacheSettingsChannelLister(() => listSlackSettingsChannels(client), cacheTtlMs);
}

export function createSlackSettingsWebClient(token: string, slackApiUrl?: string): WebClient {
  return new WebClient(token, {
    ...SLACK_SETTINGS_WEB_CLIENT_OPTIONS,
    ...(slackApiUrl ? { slackApiUrl } : {}),
  });
}

export function cacheSettingsChannelLister(
  lister: SettingsChannelLister,
  cacheTtlMs = SLACK_SETTINGS_CHANNEL_CACHE_TTL_MS
): SettingsChannelLister {
  let cached: { channels: SettingsChannel[]; expiresAt: number } | undefined;
  let inFlight: Promise<SettingsChannel[]> | undefined;

  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.channels;
    if (inFlight) return inFlight;

    inFlight = lister()
      .then((channels) => {
        cached = { channels, expiresAt: Date.now() + cacheTtlMs };
        return channels;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
