#!/usr/bin/env node
/**
 * スケジューラCLI - Agent（Claude Code / Codex）から呼び出す用
 *
 * Usage:
 *   schedule-cli add --channel <id> --platform <discord|slack> "30分後 メッセージ"
 *   schedule-cli add --channel <id> --platform <discord|slack> --cron "0 9 * * *" --message "おはよう"
 *   schedule-cli list [--channel <id>] [--platform <discord|slack>]
 *   schedule-cli remove <id>
 *   schedule-cli toggle <id>
 */

import { Scheduler, parseScheduleInput, formatScheduleList, type Platform } from './scheduler.js';

const DATA_DIR = process.env.XANGI_DATA_DIR || process.env.DATA_DIR || undefined;
const schedulerConfig = {
  enabled: process.env.SCHEDULER_ENABLED !== 'false',
  startupEnabled: process.env.STARTUP_ENABLED !== 'false',
};

function usage(): void {
  console.log(`スケジューラCLI

Usage:
  schedule-cli add --channel <id> --platform <discord|slack> "<入力>"
  schedule-cli add --channel <id> --platform <discord|slack> --cron "<cron式>" --message "<メッセージ>"
  schedule-cli add --channel <id> --platform <discord|slack> --at "<ISO日時>" --message "<メッセージ>"
  schedule-cli list [--channel <id>] [--platform <discord|slack>]
  schedule-cli remove <id>
  schedule-cli toggle <id>

自然言語入力の例:
  "30分後 ミーティング開始"
  "15:00 レビュー"
  "毎日 9:00 おはよう"
  "毎週月曜 10:00 週次MTG"

環境変数:
  XANGI_DATA_DIR or DATA_DIR  データディレクトリ（default: ./.xangi）
`);
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      result[key] = val;
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length > 0) result['_command'] = positional[0];
  if (positional.length > 1) result['_arg'] = positional.slice(1).join(' ');

  return result;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const command = args['_command'];

  if (!command || command === 'help' || args['help']) {
    usage();
    process.exit(0);
  }

  const scheduler = new Scheduler(DATA_DIR, { quiet: true });

  switch (command) {
    case 'add': {
      const channel = args['channel'];
      const platform = (args['platform'] || 'discord') as Platform;

      if (!channel) {
        console.error('Error: --channel is required');
        process.exit(1);
      }

      // cron式直接指定
      if (args['cron'] && args['message']) {
        try {
          const schedule = scheduler.add({
            type: 'cron',
            expression: args['cron'],
            message: args['message'],
            channelId: channel,
            platform,
            label: args['label'],
          });
          console.log(JSON.stringify({ ok: true, schedule }, null, 2));
        } catch (error) {
          console.error(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          );
          process.exit(1);
        }
        break;
      }

      // 日時直接指定
      if (args['at'] && args['message']) {
        try {
          const schedule = scheduler.add({
            type: 'once',
            runAt: new Date(args['at']).toISOString(),
            message: args['message'],
            channelId: channel,
            platform,
            label: args['label'],
          });
          console.log(JSON.stringify({ ok: true, schedule }, null, 2));
        } catch (error) {
          console.error(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          );
          process.exit(1);
        }
        break;
      }

      // 自然言語パース
      const input = args['_arg'];
      if (!input) {
        console.error('Error: input text is required');
        console.error('Usage: schedule-cli add --channel <id> "30分後 メッセージ"');
        process.exit(1);
      }

      const parsed = parseScheduleInput(input);
      if (!parsed) {
        console.error(
          JSON.stringify({
            ok: false,
            error: `入力を解析できませんでした: "${input}"`,
            hint: '対応: "N分後 msg", "HH:MM msg", "毎日 HH:MM msg", "毎週X曜 HH:MM msg"',
          })
        );
        process.exit(1);
      }

      try {
        const schedule = scheduler.add({
          ...parsed,
          channelId: channel,
          platform,
          label: args['label'],
        });
        console.log(JSON.stringify({ ok: true, schedule }, null, 2));
      } catch (error) {
        console.error(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        );
        process.exit(1);
      }
      break;
    }

    case 'list': {
      const channel = args['channel'];
      const platform = args['platform'] as Platform | undefined;
      const schedules = scheduler.list(channel, platform);

      if (args['json'] === 'true') {
        console.log(JSON.stringify({ ok: true, schedules }, null, 2));
      } else {
        console.log(formatScheduleList(schedules, schedulerConfig));
      }
      break;
    }

    case 'remove':
    case 'delete':
    case 'rm': {
      const idOrIndexList = args['_arg'];
      if (!idOrIndexList) {
        console.error('Error: schedule ID or index number is required');
        process.exit(1);
      }

      const parts = idOrIndexList.trim().split(/\s+/).filter(Boolean);
      const channel = args['channel'];
      const platform = args['platform'] as Platform | undefined;
      const schedules = scheduler.list(channel, platform);
      const deletedIds: string[] = [];
      const errors: string[] = [];

      // 番号を大きい順にソート（削除時のずれを防ぐ）
      const targets = parts
        .map((p) => {
          const num = parseInt(p, 10);
          if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
            if (num > schedules.length) {
              errors.push(`番号 ${num} は範囲外`);
              return null;
            }
            return { index: num, id: schedules[num - 1].id };
          }
          return { index: 0, id: p };
        })
        .filter((t): t is { index: number; id: string } => t !== null)
        .sort((a, b) => b.index - a.index);

      for (const target of targets) {
        if (scheduler.remove(target.id)) {
          deletedIds.push(target.id);
        } else {
          errors.push(`ID ${target.id} が見つからない`);
        }
      }

      if (deletedIds.length === 0) {
        console.error(
          JSON.stringify({ ok: false, error: errors.join(', ') || 'No schedules removed' })
        );
        process.exit(1);
      }

      // 削除成功後、残りのスケジュール一覧を表示
      const remaining = scheduler.list(channel, platform);
      console.log(`✅ ${deletedIds.length}件削除しました\n`);
      console.log(formatScheduleList(remaining, schedulerConfig));
      break;
    }

    case 'toggle': {
      const idOrIndex = args['_arg'];
      if (!idOrIndex) {
        console.error('Error: schedule ID or index number is required');
        process.exit(1);
      }

      let targetId = idOrIndex.trim();

      // 番号指定の場合、対応するIDを取得
      const indexNum = parseInt(targetId, 10);
      if (!isNaN(indexNum) && indexNum > 0 && !targetId.startsWith('sch_')) {
        const channel = args['channel'];
        const platform = args['platform'] as Platform | undefined;
        const schedules = scheduler.list(channel, platform);
        if (indexNum > schedules.length) {
          console.error(
            JSON.stringify({
              ok: false,
              error: `番号 ${indexNum} は範囲外です（1〜${schedules.length}）`,
            })
          );
          process.exit(1);
        }
        targetId = schedules[indexNum - 1].id;
      }

      const schedule = scheduler.toggle(targetId);
      if (!schedule) {
        console.error(JSON.stringify({ ok: false, error: `ID not found: ${targetId}` }));
        process.exit(1);
      }

      // トグル結果を分かりやすく表示
      const status = schedule.enabled ? '✅ 有効化' : '⏸️ 無効化';
      console.log(`${status}しました: ${targetId}\n`);

      // 現在の一覧を表示
      const channel = args['channel'];
      const platform = args['platform'] as Platform | undefined;
      const all = scheduler.list(channel, platform);
      console.log(formatScheduleList(all, schedulerConfig));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }

  // CLIは即終了（cronジョブは起動しない）
  scheduler.stopAll();
}

main();
