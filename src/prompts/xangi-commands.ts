/**
 * xangi専用コマンド — プラットフォーム別に組み立て
 */
import { XANGI_COMMANDS_COMMON, XANGI_COMMANDS_TRIGGER } from './xangi-commands-common.js';
import { buildXangiCommandsChatPlatform } from './xangi-commands-chat-platform.js';
import { XANGI_COMMANDS_DISCORD } from './xangi-commands-discord.js';
import { XANGI_COMMANDS_SLACK } from './xangi-commands-slack.js';
import { XANGI_COMMANDS_WEB } from './xangi-commands-web.js';
import { XANGI_COMMANDS_LINE } from './xangi-commands-line.js';
import { XANGI_COMMANDS_TELEGRAM } from './xangi-commands-telegram.js';

export type ChatPlatform = 'discord' | 'slack' | 'web' | 'line' | 'telegram';

/**
 * プラットフォームに応じたXANGI_COMMANDSを構築
 * - discord: 共通 + チャットPF共通 + Discord専用
 * - slack: 共通 + チャットPF共通 + Slack専用
 * - web: 共通 + チャットPF共通 + Web専用
 * - line: 共通 + LINE専用 (Markdown非対応、Discord/Slack 用 xangi-cmd は注入しない)
 * - undefined: 共通のみ（platform固有の指示を混在させない）
 *
 * イベントトリガーのセクションは TRIGGER_ENABLED=true のときだけ注入する
 * （無効な機能を案内すると CLI 失敗で混乱するため）。トリガーの投稿先は
 * platform: discord|slack|web で利用できるため、Webにも注入する。
 */
export function buildXangiCommands(platform?: ChatPlatform): string {
  const parts = [XANGI_COMMANDS_COMMON];

  if (platform === 'web') {
    if (process.env.TRIGGER_ENABLED === 'true') {
      parts.push(XANGI_COMMANDS_TRIGGER);
    }
    parts.push(buildXangiCommandsChatPlatform());
    parts.push(XANGI_COMMANDS_WEB);
  } else if (platform === 'line') {
    // LINE は Markdown 非対応 + ファイル送信非対応のため、Discord/Slack 用の
    // チャット PF 共通 (MEDIA: / xangi-cmd 系) は注入しない。LINE 専用ルールだけ。
    parts.push(XANGI_COMMANDS_LINE);
  } else if (platform === 'telegram') {
    // Telegram も Markdown はエスケープされるためプレーンテキストを基本とし、
    // Telegram 専用ルールだけを注入する。
    parts.push(XANGI_COMMANDS_TELEGRAM);
  } else if (platform === 'discord' || platform === 'slack') {
    if (process.env.TRIGGER_ENABLED === 'true') {
      parts.push(XANGI_COMMANDS_TRIGGER);
    }
    parts.push(buildXangiCommandsChatPlatform());

    if (platform === 'discord') {
      parts.push(XANGI_COMMANDS_DISCORD);
    } else if (platform === 'slack') {
      parts.push(XANGI_COMMANDS_SLACK);
    }
  }

  return parts.join('\n\n');
}

export {
  XANGI_COMMANDS_COMMON,
  XANGI_COMMANDS_TRIGGER,
  buildXangiCommandsChatPlatform,
  XANGI_COMMANDS_DISCORD,
  XANGI_COMMANDS_SLACK,
  XANGI_COMMANDS_WEB,
  XANGI_COMMANDS_LINE,
  XANGI_COMMANDS_TELEGRAM,
};
