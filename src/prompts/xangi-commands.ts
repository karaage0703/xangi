/**
 * xangi専用コマンド — プラットフォーム別に組み立て
 */
import { XANGI_COMMANDS_COMMON } from './xangi-commands-common.js';
import { XANGI_COMMANDS_CHAT_PLATFORM } from './xangi-commands-chat-platform.js';
import { XANGI_COMMANDS_DISCORD } from './xangi-commands-discord.js';
import { XANGI_COMMANDS_SLACK } from './xangi-commands-slack.js';
import { XANGI_COMMANDS_WEB } from './xangi-commands-web.js';

export type ChatPlatform = 'discord' | 'slack' | 'web';

/**
 * プラットフォームに応じたXANGI_COMMANDSを構築
 * - discord: 共通 + チャットPF共通 + Discord専用
 * - slack: 共通 + チャットPF共通 + Slack専用
 * - web: 共通 + Web専用（チャットPF共通・Discord・Slackコマンドなし）
 * - undefined: 共通 + チャットPF共通 + 全プラットフォーム
 */
export function buildXangiCommands(platform?: ChatPlatform): string {
  const parts = [XANGI_COMMANDS_COMMON];

  if (platform === 'web') {
    parts.push(XANGI_COMMANDS_WEB);
  } else {
    // Discord/Slack/undefined → チャットプラットフォーム共通を含める
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

// 後方互換: プラットフォーム未指定時は全部入り
export const XANGI_COMMANDS = buildXangiCommands();

export {
  XANGI_COMMANDS_COMMON,
  XANGI_COMMANDS_CHAT_PLATFORM,
  XANGI_COMMANDS_DISCORD,
  XANGI_COMMANDS_SLACK,
  XANGI_COMMANDS_WEB,
};
