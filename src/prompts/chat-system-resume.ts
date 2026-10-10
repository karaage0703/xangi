/**
 * セッション再開時（--resume）のシステムプロンプト
 */
import type { ChatPlatform } from './xangi-commands.js';
import { getPlatformLabel } from './platform-labels.js';

export function buildChatSystemResume(platform?: ChatPlatform): string {
  const label = getPlatformLabel(platform);
  return `You are chatting via ${label}. Reply in the user's language unless they request otherwise.

## Session continuation
This session is continued with --resume. Previous conversation history is preserved, so you retain the preceding conversation. Do not say you forgot it because of a restart.

## Session startup
Read AGENTS.md and follow its instructions, including its references.
See below for xangi-specific commands.`;
}

// 後方互換
export const CHAT_SYSTEM_PROMPT_RESUME = buildChatSystemResume();
