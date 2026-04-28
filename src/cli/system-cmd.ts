/**
 * システムコマンドCLIモジュール
 *
 * 設定変更はファイル経由、再起動は xangi本体プロセスへSIGTERM送信で行う。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface Settings {
  autoRestart?: boolean;
  [key: string]: unknown;
}

// src/settings.ts の DEFAULT_SETTINGS と揃える
const DEFAULT_SETTINGS: Settings = {
  autoRestart: true,
};

function getSettingsFilePath(): string {
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return join(dataDir, 'settings.json');
}

function loadSettings(): Settings {
  const filePath = getSettingsFilePath();
  if (!existsSync(filePath)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Settings;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
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

  // PIDファイルを読んで xangi 本体プロセスに SIGTERM を送る
  // SIGTERM ハンドラ内で graceful shutdown → process.exit(0) → pm2/Docker 等が再起動
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  const pidFilePath = join(dataDir, 'xangi.pid');

  if (!existsSync(pidFilePath)) {
    return `⚠️ PIDファイルが見つかりません (${pidFilePath})。xangi本体が起動しているか確認してください。`;
  }

  const pidStr = readFileSync(pidFilePath, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return `⚠️ PIDファイルの内容が不正です: "${pidStr}"`;
  }

  // process.kill(pid, 0) はシグナルを送らずに対象プロセスの存在のみ確認
  try {
    process.kill(pid, 0);
  } catch {
    return `⚠️ PID ${pid} のプロセスが存在しません（stale PIDファイル）。xangi本体を起動してください。`;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return `⚠️ PID ${pid} へのSIGTERM送信に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
  }

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
