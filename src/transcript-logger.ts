import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'fs';
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

/**
 * セッション末尾のメッセージだけを読み出す。
 * JSONLの末尾から64KiBずつ遡り、必要な行数が揃った時点でI/Oを止める。
 */
export function readSessionMessagesTail(
  workdir: string,
  appSessionId: string,
  limit: number,
  before = 0
): TranscriptEntry[] {
  if (limit <= 0) return [];
  const safeBefore = Math.max(0, Math.floor(before));
  let fd: number | undefined;
  try {
    const filePath = getSessionLogPath(workdir, appSessionId);
    if (!existsSync(filePath)) return [];
    fd = openSync(filePath, 'r');
    let position = statSync(filePath).size;
    let content = '';
    while (position > 0) {
      const chunkSize = Math.min(64 * 1024, position);
      position -= chunkSize;
      const chunk = Buffer.allocUnsafe(chunkSize);
      readSync(fd, chunk, 0, chunkSize, position);
      content = chunk.toString('utf-8') + content;
      const lineCount = content.split('\n').filter((line) => line.trim()).length;
      if (lineCount >= limit + safeBefore) break;
    }
    const lines = content.split('\n').filter((line) => line.trim());
    const end = Math.max(0, lines.length - safeBefore);
    return lines
      .slice(Math.max(0, end - limit), end)
      .map((line) => JSON.parse(line) as TranscriptEntry);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  hasMore: boolean;
  nextCursor: number | null;
}

/**
 * JSONLを末尾（または前ページ先頭のbyte offset）から読む安定カーソル版。
 * cursorはabsolute byte offsetなので、取得中に末尾へ追記されても次ページがずれない。
 */
export function readSessionMessagesPage(
  workdir: string,
  appSessionId: string,
  limit: number,
  cursor?: number
): TranscriptPage {
  if (limit <= 0) return { entries: [], hasMore: false, nextCursor: null };
  let fd: number | undefined;
  try {
    const filePath = getSessionLogPath(workdir, appSessionId);
    if (!existsSync(filePath)) return { entries: [], hasMore: false, nextCursor: null };
    fd = openSync(filePath, 'r');
    const fileSize = statSync(filePath).size;
    const end = Number.isFinite(cursor)
      ? Math.min(fileSize, Math.max(0, Math.floor(cursor as number)))
      : fileSize;
    let position = end;
    let newlineCount = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlineCount < limit + 2) {
      const chunkSize = Math.min(64 * 1024, position);
      position -= chunkSize;
      const chunk = Buffer.allocUnsafe(chunkSize);
      readSync(fd, chunk, 0, chunkSize, position);
      chunks.unshift(chunk);
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount++;
      }
    }

    const content = Buffer.concat(chunks);
    const segments: Array<{ start: number; end: number }> = [];
    let lineStart = 0;
    for (let index = 0; index <= content.length; index++) {
      if (index !== content.length && content[index] !== 0x0a) continue;
      let lineEnd = index;
      if (lineEnd > lineStart && content[lineEnd - 1] === 0x0d) lineEnd--;
      if (lineEnd > lineStart) segments.push({ start: lineStart, end: lineEnd });
      lineStart = index + 1;
    }
    // 任意chunk境界から始まった先頭断片はJSONL 1行として扱わない。
    if (position > 0 && segments.length > 0) segments.shift();

    const selected = segments.slice(-(limit + 1));
    const hasMore = position > 0 || selected.length > limit;
    const pageSegments = selected.length > limit ? selected.slice(1) : selected;
    const entries = pageSegments.map(
      (segment) =>
        JSON.parse(
          content.subarray(segment.start, segment.end).toString('utf-8')
        ) as TranscriptEntry
    );
    const nextCursor = hasMore && pageSegments.length > 0 ? position + pageSegments[0].start : null;
    return { entries, hasMore, nextCursor };
  } catch {
    return { entries: [], hasMore: false, nextCursor: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
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
 * ユーザーに表示するassistantメッセージを、最後のuserターンに応答がない場合だけ
 * transcriptへ補完する。外部プラットフォームではmessage IDを指定し、Webでは省略する。
 *
 * runnerが最終応答をすでに保存している場合は本文を上書きせず、
 * platformMessageIdだけを補う。再起動finalizerなど、プラットフォーム側では
 * メッセージを確定できたがrunnerが完了しなかった経路で使う。
 */
export function ensureVisibleAssistantResponse(
  workdir: string,
  appSessionId: string,
  platformMessageId: string | undefined,
  visibleText: string,
  createdAt = new Date().toISOString()
): TranscriptEntry | null {
  const entries = readSessionMessages(workdir, appSessionId);
  let lastUserIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex === -1) return null;

  const existingAssistant = entries
    .slice(lastUserIndex + 1)
    .find((entry) => entry.role === 'assistant');
  if (existingAssistant) {
    if (platformMessageId && !existingAssistant.platformMessageId) {
      existingAssistant.platformMessageId = platformMessageId;
      rewriteSessionFile(workdir, appSessionId, entries);
    }
    return existingAssistant;
  }

  const entry: TranscriptEntry = {
    id: generateMessageId(),
    role: 'assistant',
    content: { result: visibleText },
    createdAt,
    ...(platformMessageId ? { platformMessageId } : {}),
  };
  writeEntry(workdir, appSessionId, entry);
  return entry;
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
