import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
xangi専用コマンド（Discord操作・ファイル送信・スケジューラー・チャンネル一覧・タイムアウト対策）は以下を参照。

## 禁止事項
- EnterPlanMode ツールを使用しないこと。Discord 環境ではプランモードの承認操作ができないため、プランモードに入るとセッションがスタックする。複雑なタスクでも直接実行し、必要に応じてユーザーに確認を取ること。`;

/**
 * チャットプラットフォーム連携用のシステムプロンプト（常駐プロセス用）
 */
export const CHAT_SYSTEM_PROMPT_PERSISTENT = `あなたはチャットプラットフォーム（Discord/Slack）経由で会話しています。

## セッション継続
このセッションは常駐プロセスで実行されています。セッション内の会話履歴は保持されます。

## セッション開始時
AGENTS.md を読み、指示に従うこと（AGENTS.md 等の参照含む）。
xangi専用コマンド（Discord操作・ファイル送信・スケジューラー・チャンネル一覧・タイムアウト対策）は以下を参照。

## 禁止事項
- EnterPlanMode ツールを使用しないこと。Discord 環境ではプランモードの承認操作ができないため、プランモードに入るとセッションがスタックする。複雑なタスクでも直接実行し、必要に応じてユーザーに確認を取ること。`;

/**
 * xangi自身の prompts/ から XANGI_COMMANDS.md を読み込む
 * AGENTS.md等のワークスペース設定は各CLIの自動読み込みに任せる
 */
export function loadXangiCommands(): string {
  // dist/ から1つ上がプロジェクトルート
  const projectRoot = join(__dirname, '..');
  const filePath = join(projectRoot, 'prompts', 'XANGI_COMMANDS.md');

  if (!existsSync(filePath)) {
    console.warn('[base-runner] XANGI_COMMANDS.md not found at', filePath);
    return '';
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    console.log(`[base-runner] Loaded XANGI_COMMANDS.md (${content.length} bytes)`);
    return `\n\n## XANGI_COMMANDS.md\n\n${content}`;
  } catch (err) {
    console.error('[base-runner] Failed to load XANGI_COMMANDS.md:', err);
    return '';
  }
}

/**
 * 完全なシステムプロンプトを生成（resume型ランナー用）
 */
export function buildSystemPrompt(): string {
  return CHAT_SYSTEM_PROMPT_RESUME + loadXangiCommands();
}

/**
 * 完全なシステムプロンプトを生成（常駐プロセス用）
 */
export function buildPersistentSystemPrompt(): string {
  return CHAT_SYSTEM_PROMPT_PERSISTENT + loadXangiCommands();
}
