/**
 * xangi専用コマンド — プラットフォーム別に組み立て
 */
import { XANGI_COMMANDS_COMMON } from './xangi-commands-common.js';
import { XANGI_COMMANDS_CHAT_PLATFORM } from './xangi-commands-chat-platform.js';
import { XANGI_COMMANDS_DISCORD } from './xangi-commands-discord.js';
import { XANGI_COMMANDS_SLACK } from './xangi-commands-slack.js';
import { XANGI_COMMANDS_WEB } from './xangi-commands-web.js';
import { XANGI_COMMANDS_LINE } from './xangi-commands-line.js';

export type ChatPlatform = 'discord' | 'slack' | 'web' | 'line';

/**
 * プラットフォームに応じたXANGI_COMMANDSを構築
 * - discord: 共通 + チャットPF共通 + Discord専用
 * - slack: 共通 + チャットPF共通 + Slack専用
 * - web: 共通 + Web専用
 * - line: 共通 + LINE専用 (Markdown非対応、Discord/Slack 用 xangi-cmd は注入しない)
 * - undefined: 共通 + チャットPF共通 + Discord/Slack の両方
 */
export function buildXangiCommands(platform?: ChatPlatform): string {
  const parts = [XANGI_COMMANDS_COMMON];

  if (platform === 'web') {
    parts.push(XANGI_COMMANDS_WEB);
  } else if (platform === 'line') {
    // LINE は Markdown 非対応 + ファイル送信非対応のため、Discord/Slack 用の
    // チャット PF 共通 (MEDIA: / xangi-cmd 系) は注入しない。LINE 専用ルールだけ。
    parts.push(XANGI_COMMANDS_LINE);
  } else {
    parts.push(XANGI_COMMANDS_CHAT_PLATFORM);

    if (platform === 'discord') {
      parts.push(XANGI_COMMANDS_DISCORD);
    } else if (platform === 'slack') {
      parts.push(XANGI_COMMANDS_SLACK);
    } else {
      parts.push(XANGI_COMMANDS_DISCORD);
      parts.push(XANGI_COMMANDS_SLACK);
    }
  }

  return parts.join('\n\n');
}

// 後方互換
export const XANGI_COMMANDS = buildXangiCommands();

export {
  XANGI_COMMANDS_COMMON,
  XANGI_COMMANDS_CHAT_PLATFORM,
  XANGI_COMMANDS_DISCORD,
  XANGI_COMMANDS_SLACK,
  XANGI_COMMANDS_WEB,
  XANGI_COMMANDS_LINE,
};
