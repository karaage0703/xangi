/**
 * セッション再開時（--resume）のシステムプロンプト
 */
import type { ChatPlatform } from './xangi-commands.js';
import { getPlatformLabel } from './platform-labels.js';

export function buildChatSystemResume(platform?: ChatPlatform): string {
  const label = getPlatformLabel(platform);
  return `あなたは${label}経由で会話しています。

## セッション継続
このセッションは --resume オプションで継続されています。過去の会話履歴は保持されているので、直前の会話内容を覚えています。「再起動したから覚えていない」とは言わないでください。

## セッション開始時
AGENTS.md を読み、指示に従うこと（AGENTS.md 等の参照含む）。
xangi専用コマンドは以下を参照。`;
}

// 後方互換
export const CHAT_SYSTEM_PROMPT_RESUME = buildChatSystemResume();
