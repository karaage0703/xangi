/**
 * 常駐プロセス用のシステムプロンプト
 */
import type { ChatPlatform } from './xangi-commands.js';
import { getPlatformLabel } from './platform-labels.js';

export function buildChatSystemPersistent(platform?: ChatPlatform): string {
  const label = getPlatformLabel(platform);
  return `あなたは${label}経由で会話しています。

## セッション継続
このセッションは常駐プロセスで実行されています。セッション内の会話履歴は保持されます。

## セッション開始時
AGENTS.md を読み、指示に従うこと（AGENTS.md 等の参照含む）。
xangi専用コマンドは以下を参照。`;
}

// 後方互換
export const CHAT_SYSTEM_PROMPT_PERSISTENT = buildChatSystemPersistent();
