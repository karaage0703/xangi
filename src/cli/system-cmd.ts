/**
 * システムコマンドCLIモジュール
 *
 * tool-server (xangi 本体プロセス) 内で実行される前提。
 * 再起動は自プロセスへ SIGTERM を送って pm2 / Docker などの supervisor に任せる。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { canSelfRestart, getSelfLifecyclePermission } from '../self-lifecycle.js';

interface Settings {
  [key: string]: unknown;
}

// src/settings.ts の DEFAULT_SETTINGS と揃える
const DEFAULT_SETTINGS: Settings = {};

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

/**
 * 自プロセスに SIGTERM を送って再起動を依頼する。
 *
 * 前提: tool-server 経由で xangi 本体プロセス内から呼ばれる。
 * レスポンスを先に返してから kill するため、kill は次の tick (100ms 後) に遅延させる。
 * pm2 / Docker の restart policy で復活する想定。
 */
async function systemRestart(): Promise<string> {
  const selfLifecycle = getSelfLifecyclePermission();
  if (!canSelfRestart(selfLifecycle)) {
    return '⚠️ 自己再起動が無効です。管理者が .env の XANGI_SELF_LIFECYCLE=restart-only を設定し、xangi を再起動してください。';
  }

  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, 100);

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
  if (key === 'selfLifecycle' || key === 'XANGI_SELF_LIFECYCLE') {
    throw new Error(
      'selfLifecycle is not a runtime setting; self lifecycle permission is managed by XANGI_SELF_LIFECYCLE in .env and requires process restart'
    );
  }

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
