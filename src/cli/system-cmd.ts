/**
 * システムコマンドCLIモジュール
 *
 * 再起動・設定変更をファイル経由で実行。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface Settings {
  autoRestart?: boolean;
  [key: string]: unknown;
}

function getSettingsFilePath(): string {
  const dataDir = process.env.DATA_DIR || join(process.cwd(), '.xangi');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return join(dataDir, 'settings.json');
}

function loadSettings(): Settings {
  const filePath = getSettingsFilePath();
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Settings;
  } catch {
    return {};
  }
}

function saveSettings(settings: Settings): void {
  const filePath = getSettingsFilePath();
  writeFileSync(filePath, JSON.stringify(settings, null, 2));
}

async function systemRestart(): Promise<string> {
  const settings = loadSettings();
  if (!settings.autoRestart) {
    return '⚠️ 自動再起動が無効です。先に system_settings --key autoRestart --value true で有効にしてください。';
  }

  // 再起動トリガーファイルを作成（xangiプロセスが監視して再起動）
  const dataDir = process.env.DATA_DIR || join(process.cwd(), '.xangi');
  writeFileSync(join(dataDir, 'restart-trigger'), Date.now().toString());

  return '🔄 再起動をリクエストしました';
}

async function systemSettings(flags: Record<string, string>): Promise<string> {
  const key = flags['key'];
  const value = flags['value'];

  if (!key) {
    // 設定一覧を表示
    const settings = loadSettings();
    const entries = Object.entries(settings)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join('\n');
    return `⚙️ 現在の設定:\n${entries || '  (なし)'}`;
  }

  if (value === undefined) {
    throw new Error('--value is required when --key is specified');
  }

  const settings = loadSettings();

  // 型変換
  let typedValue: unknown;
  if (value === 'true') typedValue = true;
  else if (value === 'false') typedValue = false;
  else if (!isNaN(Number(value))) typedValue = Number(value);
  else typedValue = value;

  settings[key] = typedValue;
  saveSettings(settings);

  return `⚙️ 設定を更新しました: ${key} = ${JSON.stringify(typedValue)}`;
}

// ─── Router ─────────────────────────────────────────────────────────

export async function systemCmd(command: string, flags: Record<string, string>): Promise<string> {
  switch (command) {
    case 'system_restart':
      return systemRestart();
    case 'system_settings':
      return systemSettings(flags);
    default:
      throw new Error(`Unknown system command: ${command}`);
  }
}
