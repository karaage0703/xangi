import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ChatPlatform } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * ランナー共通の設定
 */
export interface BaseRunnerOptions {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
}

/**
 * チャットプラットフォーム連携用のシステムプロンプト（resumeあり）
 */
export const CHAT_SYSTEM_PROMPT_RESUME = `あなたはチャットプラットフォーム（Discord/Slack）経由で会話しています。

## セッション継続
このセッションは --resume オプションで継続されています。過去の会話履歴は保持されているので、直前の会話内容を覚えています。「再起動したから覚えていない」とは言わないでください。

## セッション開始時
AGENTS.md を読み、指示に従うこと（AGENTS.md 等の参照含む）。
xangi専用コマンド（プラットフォーム専用コマンド・スケジューラー・チャンネル一覧・タイムアウト対策）は以下を参照。

## 禁止事項
- EnterPlanMode ツールを使用しないこと。チャット環境ではプランモードの承認操作ができないため、プランモードに入るとセッションがスタックする。複雑なタスクでも直接実行し、必要に応じてユーザーに確認を取ること。`;

/**
 * チャットプラットフォーム連携用のシステムプロンプト（常駐プロセス用）
 */
export const CHAT_SYSTEM_PROMPT_PERSISTENT = `あなたはチャットプラットフォーム（Discord/Slack）経由で会話しています。

## セッション継続
このセッションは常駐プロセスで実行されています。セッション内の会話履歴は保持されます。

## セッション開始時
AGENTS.md を読み、指示に従うこと（AGENTS.md 等の参照含む）。
xangi専用コマンド（プラットフォーム専用コマンド・スケジューラー・チャンネル一覧・タイムアウト対策）は以下を参照。

## 禁止事項
- EnterPlanMode ツールを使用しないこと。チャット環境ではプランモードの承認操作ができないため、プランモードに入るとセッションがスタックする。複雑なタスクでも直接実行し、必要に応じてユーザーに確認を取ること。`;

/**
 * Load a prompt file from the prompts/ directory
 */
function loadPromptFile(filename: string): string {
  const projectRoot = join(__dirname, '..');
  const filePath = join(projectRoot, 'prompts', filename);

  if (!existsSync(filePath)) {
    console.warn(`[base-runner] ${filename} not found at`, filePath);
    return '';
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    console.log(`[base-runner] Loaded ${filename} (${content.length} bytes)`);
    return content;
  } catch (err) {
    console.error(`[base-runner] Failed to load ${filename}:`, err);
    return '';
  }
}

/**
 * xangi自身の prompts/ からプラットフォームに応じたコマンドファイルを読み込む
 * AGENTS.md等のワークスペース設定は各CLIの自動読み込みに任せる
 */
export function loadXangiCommands(platform?: ChatPlatform): string {
  const parts: string[] = [];

  // Always load common commands
  const common = loadPromptFile('XANGI_COMMANDS_COMMON.md');
  if (common) {
    parts.push(common);
  }

  // Load platform-specific commands
  if (platform === 'discord') {
    const discord = loadPromptFile('XANGI_COMMANDS_DISCORD.md');
    if (discord) parts.push(discord);
  } else if (platform === 'slack') {
    const slack = loadPromptFile('XANGI_COMMANDS_SLACK.md');
    if (slack) parts.push(slack);
  } else {
    // Both platforms or unknown — load all
    const discord = loadPromptFile('XANGI_COMMANDS_DISCORD.md');
    if (discord) parts.push(discord);
    const slack = loadPromptFile('XANGI_COMMANDS_SLACK.md');
    if (slack) parts.push(slack);
  }

  if (parts.length === 0) {
    return '';
  }

  return `\n\n## XANGI Commands\n\n${parts.join('\n\n')}`;
}

/**
 * 完全なシステムプロンプトを生成（resume型ランナー用）
 */
export function buildSystemPrompt(platform?: ChatPlatform): string {
  return CHAT_SYSTEM_PROMPT_RESUME + loadXangiCommands(platform);
}

/**
 * 完全なシステムプロンプトを生成（常駐プロセス用）
 */
export function buildPersistentSystemPrompt(platform?: ChatPlatform): string {
  return CHAT_SYSTEM_PROMPT_PERSISTENT + loadXangiCommands(platform);
}
