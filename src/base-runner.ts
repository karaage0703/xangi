import {
  CHAT_SYSTEM_PROMPT_RESUME,
  CHAT_SYSTEM_PROMPT_PERSISTENT,
  XANGI_COMMANDS,
  buildXangiCommands,
  buildChatSystemResume,
  buildChatSystemPersistent,
} from './prompts/index.js';
import type { ChatPlatform } from './prompts/index.js';

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
export function buildSystemPrompt(platform?: ChatPlatform): string {
  const systemPrompt = buildChatSystemResume(platform);
  const commands = buildXangiCommands(platform);
  return systemPrompt + '\n\n## XANGI_COMMANDS\n\n' + commands;
}

/**
 * 完全なシステムプロンプトを生成（常駐プロセス用）
 */
export function buildPersistentSystemPrompt(platform?: ChatPlatform): string {
  const systemPrompt = buildChatSystemPersistent(platform);
  const commands = buildXangiCommands(platform);
  return systemPrompt + '\n\n## XANGI_COMMANDS\n\n' + commands;
}

// XANGI_COMMANDSを再エクスポート（local-llm runner等から使う）
// XANGI_COMMANDS は静的版 (platform=undefined)、buildXangiCommands は runtime 切替版。
// Local LLM runner は platform 別に system prompt を切替えたいので buildXangiCommands を使う。
export { XANGI_COMMANDS, buildXangiCommands };

// safe-env.ts から再エクスポート（既存のimportを壊さないため）
export { getSafeEnv } from './safe-env.js';
