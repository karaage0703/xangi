import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export interface Settings {
  autoRestart: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  autoRestart: true,
};

let settingsPath: string | null = null;
let cachedSettings: Settings | null = null;

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
    cachedSettings = {
      autoRestart: parsed.autoRestart ?? DEFAULT_SETTINGS.autoRestart,
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
  const lines = ['⚙️ **現在の設定**', `- 自動再起動: ${settings.autoRestart ? '✅ ON' : '❌ OFF'}`];
  return lines.join('\n');
}

/**
 * キャッシュをクリア（テスト用）
 */
export function clearSettingsCache(): void {
  cachedSettings = null;
  settingsPath = null;
}
