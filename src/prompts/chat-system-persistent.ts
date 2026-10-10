/**
 * 常駐プロセス用のシステムプロンプト
 */
import type { ChatPlatform } from './xangi-commands.js';
import { getPlatformLabel } from './platform-labels.js';

export function buildChatSystemPersistent(platform?: ChatPlatform): string {
  const label = getPlatformLabel(platform);
  return `You are chatting via ${label}. Reply in the user's language unless they request otherwise.

## Session continuation
This session runs in a persistent process. Conversation history is retained within the session.

## Session startup
Read AGENTS.md and follow its instructions, including its references.
See below for xangi-specific commands.`;
}

// 後方互換
export const CHAT_SYSTEM_PROMPT_PERSISTENT = buildChatSystemPersistent();
