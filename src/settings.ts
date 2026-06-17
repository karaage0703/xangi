import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { DiscordCompletionNotifyMode } from './config.js';

export interface Settings {
  autoRestart: boolean;
  discordCompletionNotifyChannels?: Record<string, DiscordCompletionNotifyMode>;
}

const DEFAULT_SETTINGS: Settings = {
  autoRestart: true,
};

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
    const discordCompletionNotifyChannels = normalizeDiscordCompletionNotifyChannels(
      parsed.discordCompletionNotifyChannels
    );
    cachedSettings = {
      autoRestart: parsed.autoRestart ?? DEFAULT_SETTINGS.autoRestart,
      ...(discordCompletionNotifyChannels && { discordCompletionNotifyChannels }),
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
  const merged: Settings = { ...current, ...settings };

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
  const completionNotifyChannels = Object.keys(
    settings.discordCompletionNotifyChannels ?? {}
  ).length;
  const lines = [
    '⚙️ **現在の設定**',
    `- 自動再起動: ${settings.autoRestart ? '✅ ON' : '❌ OFF'}`,
    `- Discord完了通知チャンネル設定: ${completionNotifyChannels}件`,
  ];
  return lines.join('\n');
}

export function getChannelCompletionNotifyMode(
  settings: Settings,
  channelId: string,
  defaultMode: DiscordCompletionNotifyMode
): DiscordCompletionNotifyMode {
  return settings.discordCompletionNotifyChannels?.[channelId] ?? defaultMode;
}

/**
 * キャッシュをクリア（テスト用）
 */
export function clearSettingsCache(): void {
  cachedSettings = null;
  settingsPath = null;
}
