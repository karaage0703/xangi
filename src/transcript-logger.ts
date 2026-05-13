import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
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
  edited?: boolean;
  editedAt?: string;
  /**
   * 外部プラットフォーム (Discord / Slack) のメッセージ ID。
   * 受信側 (user の Discord メッセージ) と送信側 (xangi が返した
   * bot メッセージ) の両方で記録される。
   * これがあれば外部側で編集・削除されたときに transcript の該当
   * エントリを逆引きできる。
   */
  platformMessageId?: string;
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

/** transcript ファイル全体を書き換える (edit / delete 用) */
function rewriteSessionFile(
  workdir: string,
  appSessionId: string,
  entries: TranscriptEntry[]
): void {
  const filePath = getSessionLogPath(workdir, appSessionId);
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(filePath, entries.length > 0 ? lines + '\n' : '');
}

/**
 * 既存メッセージの content を上書きする。
 * 編集後は `edited: true` と `editedAt` を付与。
 * 対象が見つからなければ null。
 */
export function updateMessageContent(
  workdir: string,
  appSessionId: string,
  messageId: string,
  newContent: string | Record<string, unknown>
): TranscriptEntry | null {
  const entries = readSessionMessages(workdir, appSessionId);
  const idx = entries.findIndex((e) => e.id === messageId);
  if (idx === -1) return null;
  const entry = entries[idx];
  entry.content = newContent;
  entry.edited = true;
  entry.editedAt = new Date().toISOString();
  rewriteSessionFile(workdir, appSessionId, entries);
  return entry;
}

/**
 * メッセージを削除。対象が見つかれば true。
 */
export function deleteMessage(workdir: string, appSessionId: string, messageId: string): boolean {
  const entries = readSessionMessages(workdir, appSessionId);
  const idx = entries.findIndex((e) => e.id === messageId);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  rewriteSessionFile(workdir, appSessionId, entries);
  return true;
}

/**
 * 最後のユーザ/アシスタントメッセージに platformMessageId (Discord/Slack 等の
 * 外部 ID) を後付けで紐付ける。runner からは触らない・transcript の append
 * が終わった後にプラットフォーム側ハンドラから呼ぶ用途。
 *
 * @param role どちらのロールの最後のエントリに付けるか
 * @returns 紐付けに成功したエントリ。対象が無ければ null
 */
export function attachPlatformMessageIdToLast(
  workdir: string,
  appSessionId: string,
  role: 'user' | 'assistant',
  platformMessageId: string
): TranscriptEntry | null {
  const entries = readSessionMessages(workdir, appSessionId);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === role) {
      entries[i].platformMessageId = platformMessageId;
      rewriteSessionFile(workdir, appSessionId, entries);
      return entries[i];
    }
  }
  return null;
}

/**
 * platformMessageId からエントリを逆引き。
 * Discord/Slack の messageUpdate/messageDelete から呼ぶ。
 */
export function findEntryByPlatformMessageId(
  workdir: string,
  appSessionId: string,
  platformMessageId: string
): TranscriptEntry | null {
  const entries = readSessionMessages(workdir, appSessionId);
  return entries.find((e) => e.platformMessageId === platformMessageId) ?? null;
}
