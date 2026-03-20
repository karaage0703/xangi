import {
  CHAT_SYSTEM_PROMPT_RESUME,
  CHAT_SYSTEM_PROMPT_PERSISTENT,
  XANGI_COMMANDS,
} from './prompts/index.js';

/**
 * ランナー共通の設定
 */
export interface BaseRunnerOptions {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
}

// プロンプトを再エクスポート（既存のimportを壊さないため）
export { CHAT_SYSTEM_PROMPT_RESUME, CHAT_SYSTEM_PROMPT_PERSISTENT };

/**
 * 完全なシステムプロンプトを生成（resume型ランナー用）
 */
export function buildSystemPrompt(): string {
  return CHAT_SYSTEM_PROMPT_RESUME + '\n\n## XANGI_COMMANDS.md\n\n' + XANGI_COMMANDS;
}

/**
 * 完全なシステムプロンプトを生成（常駐プロセス用）
 */
export function buildPersistentSystemPrompt(): string {
  return CHAT_SYSTEM_PROMPT_PERSISTENT + '\n\n## XANGI_COMMANDS.md\n\n' + XANGI_COMMANDS;
}

// XANGI_COMMANDSを再エクスポート（local-llm runner等から使う）
export { XANGI_COMMANDS };

// safe-env.ts から再エクスポート（既存のimportを壊さないため）
export { getSafeEnv } from './safe-env.js';
