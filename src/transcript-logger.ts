import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * チャンネルごとのトランスクリプト（会話ログ）をJSONLファイルに保存する
 *
 * ログは日付ごとにローテーションされ、以下のディレクトリ構造で保存:
 *   logs/transcripts/YYYY-MM-DD/{channelId}.jsonl
 */

export interface TranscriptEntry {
  type: 'prompt' | 'response' | 'error';
  sessionId?: string;
  content: string | Record<string, unknown>;
  timestamp?: string;
}

function ensureDir(logDir: string): string {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const dir = join(logDir, today);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function writeLog(baseDir: string, channelId: string, entry: TranscriptEntry): void {
  try {
    const logDir = join(baseDir, 'logs', 'transcripts');
    const dir = ensureDir(logDir);
    const filePath = join(dir, `${channelId}.jsonl`);
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
    appendFileSync(filePath, line + '\n');
  } catch (err) {
    // ログ書き込み失敗は無視（本体の動作に影響させない）
    console.warn('[transcript] Failed to write log:', err);
  }
}

/** 送信プロンプトを記録 */
export function logPrompt(
  baseDir: string,
  channelId: string,
  prompt: string,
  sessionId?: string
): void {
  writeLog(baseDir, channelId, { type: 'prompt', sessionId, content: prompt });
}

/** AI からの応答を記録 */
export function logResponse(
  baseDir: string,
  channelId: string,
  json: Record<string, unknown>
): void {
  writeLog(baseDir, channelId, { type: 'response', content: json });
}

/** エラーを記録 */
export function logError(
  baseDir: string,
  channelId: string,
  error: string,
  sessionId?: string
): void {
  writeLog(baseDir, channelId, { type: 'error', sessionId, content: error });
}
