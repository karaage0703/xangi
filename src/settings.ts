import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { DiscordCompletionNotifyMode } from './config.js';

export interface Settings {
  replySuggestionsEnabled?: boolean;
  discordAutoReplyChannels?: Record<string, boolean>;
  slackAutoReplyChannels?: Record<string, boolean>;
  discordCompletionNotifyChannels?: Record<string, DiscordCompletionNotifyMode>;
  discordThreadModeChannels?: Record<string, boolean>;
}

const DEFAULT_SETTINGS: Settings = {};

let settingsPath: string | null = null;
let cachedSettings: Settings | null = null;

const DISCORD_COMPLETION_NOTIFY_MODES = new Set<DiscordCompletionNotifyMode>([
  'off',
  'message',
  'mention',
]);

function normalizeDiscordCompletionNotifyChannels(
  value: unknown
): Record<string, DiscordCompletionNotifyMode> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const normalized: Record<string, DiscordCompletionNotifyMode> = {};
  for (const [channelId, mode] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(channelId)) continue;
    if (
      typeof mode === 'string' &&
      DISCORD_COMPLETION_NOTIFY_MODES.has(mode as DiscordCompletionNotifyMode)
    ) {
      normalized[channelId] = mode as DiscordCompletionNotifyMode;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeDiscordBooleanChannels(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const normalized: Record<string, boolean> = {};
  for (const [channelId, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(channelId)) continue;
    if (typeof enabled === 'boolean') {
      normalized[channelId] = enabled;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeSlackBooleanChannels(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const normalized: Record<string, boolean> = {};
  for (const [channelId, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Z0-9]+$/i.test(channelId)) continue;
    if (typeof enabled === 'boolean') normalized[channelId] = enabled;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeDiscordThreadModeChannels(value: unknown): Record<string, boolean> | undefined {
  return normalizeDiscordBooleanChannels(value);
}

/**
 * settings.json のパスを初期化する
 * dataDir（DATA_DIR or WORKSPACE_PATH/.xangi）配下に保存。
 * sessions.json などの他の永続データと同じディレクトリに揃える。
 */
export function initSettings(dataDir: string): void {
  settingsPath = join(dataDir, 'settings.json');
}

/**
 * settings.json のパスを取得
 */
export function getSettingsPath(): string {
  if (!settingsPath) {
    throw new Error('Settings not initialized. Call initSettings(dataDir) first.');
  }
  return settingsPath;
}

/**
 * 設定を読み込む（キャッシュあり）
 */
export function loadSettings(): Settings {
  if (cachedSettings) return { ...cachedSettings };

  const path = getSettingsPath();
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const discordAutoReplyChannels = normalizeDiscordBooleanChannels(
      parsed.discordAutoReplyChannels
    );
    const slackAutoReplyChannels = normalizeSlackBooleanChannels(parsed.slackAutoReplyChannels);
    const discordCompletionNotifyChannels = normalizeDiscordCompletionNotifyChannels(
      parsed.discordCompletionNotifyChannels
    );
    const discordThreadModeChannels = normalizeDiscordThreadModeChannels(
      parsed.discordThreadModeChannels
    );
    cachedSettings = {
      ...(typeof parsed.replySuggestionsEnabled === 'boolean' && {
        replySuggestionsEnabled: parsed.replySuggestionsEnabled,
      }),
      ...(discordAutoReplyChannels && { discordAutoReplyChannels }),
      ...(slackAutoReplyChannels && { slackAutoReplyChannels }),
      ...(discordCompletionNotifyChannels && { discordCompletionNotifyChannels }),
      ...(discordThreadModeChannels && { discordThreadModeChannels }),
    };
    return { ...cachedSettings };
  } catch {
    // ファイルがない or パースエラー → デフォルト
    cachedSettings = { ...DEFAULT_SETTINGS };
    return { ...cachedSettings };
  }
}

/**
 * 設定を保存する
 */
export function saveSettings(settings: Partial<Settings>): Settings {
  const current = loadSettings();
  const merged: Settings = {
    ...current,
    ...settings,
  };

  const path = getSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

  cachedSettings = merged;
  console.log(`[xangi] Settings saved: ${JSON.stringify(merged)}`);
  return { ...merged };
}

/**
 * 設定をフォーマットして表示用文字列を返す
 */
export function formatSettings(settings: Settings): string {
  const autoReplyChannels = Object.keys(settings.discordAutoReplyChannels ?? {}).length;
  const completionNotifyChannels = Object.keys(
    settings.discordCompletionNotifyChannels ?? {}
  ).length;
  const threadModeChannels = Object.keys(settings.discordThreadModeChannels ?? {}).length;
  const slackAutoReplyChannels = Object.keys(settings.slackAutoReplyChannels ?? {}).length;
  const lines = [
    '⚙️ **現在の設定**',
    `- 回答候補の全体設定: ${settings.replySuggestionsEnabled === undefined ? '起動時設定' : settings.replySuggestionsEnabled ? 'ON' : 'OFF'}`,
    `- Discordメンションなし応答チャンネル設定: ${autoReplyChannels}件`,
    `- Slackメンションなし応答チャンネル設定: ${slackAutoReplyChannels}件`,
    `- Discord完了通知チャンネル設定: ${completionNotifyChannels}件`,
    `- Discordスレッドモードチャンネル設定: ${threadModeChannels}件`,
  ];
  return lines.join('\n');
}

export function getReplySuggestionsEnabled(settings: Settings, defaultEnabled: boolean): boolean {
  return settings.replySuggestionsEnabled ?? defaultEnabled;
}

/** 起動初期化前の単体利用では、従来どおり起動時設定へフォールバックする。 */
export function loadReplySuggestionsEnabled(defaultEnabled: boolean): boolean {
  try {
    return getReplySuggestionsEnabled(loadSettings(), defaultEnabled);
  } catch {
    return defaultEnabled;
  }
}

export function getChannelAutoReply(
  settings: Settings,
  channelId: string,
  defaultEnabled: boolean
): boolean {
  return settings.discordAutoReplyChannels?.[channelId] ?? defaultEnabled;
}

/**
 * スレッド内メッセージに対する autoreply の実効値を返す。
 *
 * スレッド自身に設定があればそれを使い、無ければ親チャンネルの設定を継承する。
 * 設定値は「未設定 / on / off」の 3 状態あるため、スレッドと親の論理和では
 * 未設定と明示的な off を区別できず、親が on のときスレッドだけ off にできない。
 */
export function getChannelAutoReplyWithParent(
  settings: Settings,
  channelId: string,
  parentChannelId: string | null | undefined,
  defaultEnabled: boolean
): boolean {
  const inherited =
    parentChannelId != null
      ? getChannelAutoReply(settings, parentChannelId, defaultEnabled)
      : defaultEnabled;
  return getChannelAutoReply(settings, channelId, inherited);
}

export function getSlackChannelAutoReply(
  settings: Settings,
  channelId: string,
  defaultEnabled: boolean
): boolean {
  return settings.slackAutoReplyChannels?.[channelId] ?? defaultEnabled;
}

export function getChannelCompletionNotifyMode(
  settings: Settings,
  channelId: string,
  defaultMode: DiscordCompletionNotifyMode
): DiscordCompletionNotifyMode {
  return settings.discordCompletionNotifyChannels?.[channelId] ?? defaultMode;
}

export function getChannelThreadMode(
  settings: Settings,
  channelId: string,
  defaultEnabled: boolean
): boolean {
  return settings.discordThreadModeChannels?.[channelId] ?? defaultEnabled;
}

/**
 * キャッシュをクリア（テスト用）
 */
export function clearSettingsCache(): void {
  cachedSettings = null;
  settingsPath = null;
}
