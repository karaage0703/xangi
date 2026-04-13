import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * セッション単位のトランスクリプト（会話ログ）をJSONLファイルに保存する
 *
 * ログはセッションごとに1ファイル:
 *   logs/sessions/<appSessionId>.jsonl
 */

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string | Record<string, unknown>;
  createdAt: string;
  usage?: Record<string, unknown>;
}

function getSessionLogPath(workdir: string, appSessionId: string): string {
  const dir = join(workdir, 'logs', 'sessions');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `${appSessionId}.jsonl`);
}

function generateMessageId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function writeEntry(workdir: string, appSessionId: string, entry: TranscriptEntry): void {
  try {
    const filePath = getSessionLogPath(workdir, appSessionId);
    const line = JSON.stringify(entry);
    appendFileSync(filePath, line + '\n');
  } catch (err) {
    console.warn('[transcript] Failed to write log:', err);
  }
}

/**
 * ユーザーのプロンプトを記録
 */
export function logPrompt(workdir: string, appSessionId: string, prompt: string): void {
  writeEntry(workdir, appSessionId, {
    id: generateMessageId(),
    role: 'user',
    content: prompt,
    createdAt: new Date().toISOString(),
  });
}

/**
 * AIの応答を記録
 */
export function logResponse(
  workdir: string,
  appSessionId: string,
  json: Record<string, unknown>
): void {
  writeEntry(workdir, appSessionId, {
    id: generateMessageId(),
    role: 'assistant',
    content: json,
    createdAt: new Date().toISOString(),
  });
}

/**
 * エラーを記録
 */
export function logError(workdir: string, appSessionId: string, error: string): void {
  writeEntry(workdir, appSessionId, {
    id: generateMessageId(),
    role: 'error',
    content: error,
    createdAt: new Date().toISOString(),
  });
}

/**
 * セッションのメッセージ一覧を読み出す
 */
export function readSessionMessages(workdir: string, appSessionId: string): TranscriptEntry[] {
  try {
    const filePath = getSessionLogPath(workdir, appSessionId);
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TranscriptEntry);
  } catch {
    return [];
  }
}
