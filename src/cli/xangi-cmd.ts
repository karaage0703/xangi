#!/usr/bin/env node
/**
 * xangi-cmd — xangiコマンドのCLIインターフェース
 *
 * Discord REST APIを直接叩いてDiscord操作を行う。
 * Claude CodeからBash経由で、Local LLMからexecツール経由で呼ばれる。
 *
 * 環境変数:
 *   XANGI_DIR — xangi-devのディレクトリ（.envの読み込み元）
 *   DISCORD_TOKEN — Discord BOTトークン（.envから自動読み込み）
 *
 * 使い方:
 *   node xangi-cmd.js discord_history --channel <id> [--count <n>] [--offset <n>]
 *   node xangi-cmd.js discord_send --channel <id> --message <text>
 *   node xangi-cmd.js discord_channels --guild <id>
 *   node xangi-cmd.js discord_search --channel <id> --keyword <text>
 *   node xangi-cmd.js discord_edit --channel <id> --message-id <id> --content <text>
 *   node xangi-cmd.js discord_delete --channel <id> --message-id <id>
 *   node xangi-cmd.js schedule_list
 *   node xangi-cmd.js schedule_add --input <text> --channel <id> --platform <discord|slack>
 *   node xangi-cmd.js schedule_remove --id <id>
 *   node xangi-cmd.js schedule_toggle --id <id>
 *   node xangi-cmd.js media_send --channel <id> --file <path>
 *   node xangi-cmd.js system_restart
 *   node xangi-cmd.js system_settings --key <key> --value <value>
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { discordApi } from './discord-api.js';
import { scheduleCmd } from './schedule-cmd.js';
import { systemCmd } from './system-cmd.js';

// .env を自動読み込み（DISCORD_TOKEN等のシークレットを取得）
function loadEnvFile(): void {
  // 1. XANGI_DIR から .env を読む
  // 2. なければ自身の dist/cli/ から2階層上（xangi-dev/）の .env を読む
  const candidates: string[] = [];

  if (process.env.XANGI_DIR) {
    candidates.push(join(process.env.XANGI_DIR, '.env'));
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  candidates.push(join(__dirname, '..', '..', '.env'));

  for (const envPath of candidates) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // クォート除去
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        // 既に設定されていなければセット
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      break;
    }
  }
}

loadEnvFile();

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const command = argv[2] || '';
  const flags: Record<string, string> = {};
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      flags[key] = value;
    }
  }
  return { command, flags };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  if (!command || command === 'help') {
    console.log(`xangi-cmd — xangiコマンドCLI

Discord操作:
  discord_history   チャンネル履歴取得
  discord_send      メッセージ送信
  discord_channels  チャンネル一覧
  discord_search    メッセージ検索
  discord_edit      メッセージ編集
  discord_delete    メッセージ削除

スケジュール:
  schedule_list     一覧表示
  schedule_add      追加
  schedule_remove   削除
  schedule_toggle   有効/無効切替

その他:
  media_send        ファイル送信
  system_restart    再起動
  system_settings   設定変更`);
    return;
  }

  try {
    let result: string;

    if (command.startsWith('discord_')) {
      result = await discordApi(command, flags);
    } else if (command.startsWith('schedule_')) {
      result = await scheduleCmd(command, flags);
    } else if (command === 'media_send') {
      result = await discordApi(command, flags);
    } else if (command.startsWith('system_')) {
      result = await systemCmd(command, flags);
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }

    console.log(result);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
