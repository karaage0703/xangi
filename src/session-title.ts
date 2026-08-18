/**
 * セッションタイトル導出ユーティリティ。
 *
 * Discord/Slack/Web のプロンプトにはメタデータ行（`[プラットフォーム: ...]` など）が
 * 先頭に付くため、UI に出すときはそれを剥がした最初の本文をタイトル候補として使う。
 */
import { closeSync, existsSync, openSync, readSync } from 'fs';
import { join } from 'path';
import { stripReplySuggestionMarkup } from './reply-suggestions.js';

const SESSION_TITLE_MAX_UTF16_LENGTH = 50;

const PROMPT_METADATA_PATTERNS: RegExp[] = [
  /^\[システム注記:[^\n]*\]\n?\n?/,
  /^\[runtime\][^\n]*\n?\n?/,
  /^\[プラットフォーム: [^\]]*\]\n?/,
  /^\[チャンネル: [^\]]*\]\n?/,
  /^\[スレッド: [^\]]*\]\n?/,
  /^\[発言者: [^\]]*\]\n?/,
  /^\[現在時刻: [^\]]*\]\n?/,
];

const PREFETCHED_HISTORY_BLOCK = /<prefetched-history\b[^>]*>[\s\S]*?<\/prefetched-history>\s*/g;
const PLATFORM_SYSTEM_CONTEXT_BLOCK = /<system-context\b[^>]*>[\s\S]*?<\/system-context>\s*/g;
const WEB_PROJECT_CONTEXT_BLOCK = /<web-project-context\b[^>]*>[\s\S]*?<\/web-project-context>\s*/g;
const DISCORD_CONTEXT_BLOCK = /^\s*---\n(?:🧵 スレッド元|💬 返信元) \([^\n]*\):\n[\s\S]*?\n---\n?/;
const CHANNEL_RULE_CONTEXT = /\n{2,}\[チャンネルルール（必ず従うこと）\]\n[\s\S]*$/;
const PREFETCH_FOLLOWUP =
  /初期文脈確認だけを目的に history コマンドを再実行しないでください。さらに古い履歴や追加件数が必要な場合だけ実行してください。\s*/g;
const REPLY_SUGGESTION_CONTEXT =
  /\s*\[system-context\]\s*通常の回答に続けて、ユーザーが次に送りそうな短い返信候補を\d+件生成してください。[\s\S]*?<\/xangi_reply_suggestions>(?=\s*(?:\[USER PROMPT HOOK CONTEXT:|$))/;
const USER_PROMPT_HOOK_CONTEXT =
  /^\[USER PROMPT HOOK CONTEXT: ([A-Za-z0-9._-]+)(?: \(truncated\))?\]\r?\n[\s\S]*?^\[END USER PROMPT HOOK CONTEXT: \1\](?:\r?\n)?/gm;

function readFirstUserContent(workdir: string, sessionId: string): string {
  let fd: number | undefined;
  try {
    const filePath = join(workdir, 'logs', 'sessions', `${sessionId}.jsonl`);
    if (!existsSync(filePath)) return '';
    fd = openSync(filePath, 'r');
    const chunks: Buffer[] = [];
    let position = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      position += bytesRead;
      if (newline >= 0) break;
    }
    const firstLine = Buffer.concat(chunks).toString('utf-8');
    if (!firstLine) return '';
    const entry = JSON.parse(firstLine) as { role?: string; content?: unknown };
    return entry.role === 'user' && typeof entry.content === 'string' ? entry.content : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface SessionOrigin {
  channelId?: string;
  channelName?: string;
  threadId?: string;
  threadName?: string;
}

/** 最初のプロンプトに埋め込まれたDiscord/Slackの会話先を表示用に復元する。 */
export function deriveSessionOrigin(workdir: string, sessionId: string): SessionOrigin | undefined {
  const content = readFirstUserContent(workdir, sessionId);
  const discord = content.match(
    /^\[チャンネル:\s*#?(.+?)\s*\(ID:\s*([^)]+)\)(?:\s*\/\s*thread:\s*(.+?)\s*\(ID:\s*([^)]+)\))?\]/m
  );
  if (discord) {
    return {
      channelName: discord[1].trim(),
      channelId: discord[2].trim(),
      threadName: discord[3]?.trim(),
      threadId: discord[4]?.trim(),
    };
  }

  const slackChannelId = content.match(/^\[チャンネル:\s*([^\]]+)\]/m)?.[1]?.trim();
  const slackThreadId = content.match(/^\[スレッド:\s*([^\]]+)\]/m)?.[1]?.trim();
  if (!slackChannelId) return undefined;
  return { channelId: slackChannelId, threadId: slackThreadId };
}

/**
 * プロンプト先頭のメタデータ行を順に剥がして本文だけ返す。
 * 4種類のメタデータ行（プラットフォーム / チャンネル / 発言者 / 現在時刻）が
 * 並ぶ前提で、未指定の行はスキップして OK。
 */
export function stripPromptMetadata(text: string): string {
  let s = text
    .replace(PLATFORM_SYSTEM_CONTEXT_BLOCK, '')
    .replace(WEB_PROJECT_CONTEXT_BLOCK, '')
    .replace(PREFETCHED_HISTORY_BLOCK, '')
    .replace(PREFETCH_FOLLOWUP, '')
    .replace(REPLY_SUGGESTION_CONTEXT, '');
  let changed = true;
  while (changed) {
    const before = s;
    for (const re of PROMPT_METADATA_PATTERNS) s = s.replace(re, '');
    s = s.replace(DISCORD_CONTEXT_BLOCK, '');
    s = s.trimStart();
    changed = s !== before;
  }
  return stripReplySuggestionMarkup(s).replace(CHANNEL_RULE_CONTEXT, '').trim();
}

/** 会話タイトルなど短い表示値からUserPromptSubmitの内部contextだけを除去する。 */
export function stripUserPromptHookContexts(text: string): string {
  return text.replace(USER_PROMPT_HOOK_CONTEXT, '').trim();
}

/** セッションタイトルから孤立したUTF-16 surrogateを除去する。 */
export function sanitizeSessionTitle(title: string): string {
  return title.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ''
  );
}

/** UTF-16 surrogate pairを分断せず、表示用タイトルの上限へ切り詰める。 */
export function truncateSessionTitle(title: string): string {
  const sanitized = sanitizeSessionTitle(title);
  if (sanitized.length <= SESSION_TITLE_MAX_UTF16_LENGTH) return sanitized;

  let end = SESSION_TITLE_MAX_UTF16_LENGTH;
  if ((sanitized.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
  return sanitized.slice(0, end);
}

/**
 * セッションログ（logs/sessions/<id>.jsonl）の最初のユーザーメッセージから
 * 表示用タイトルを生成する。50 文字に切り詰める。導出できなければ空文字。
 */
export function deriveTitleFromFirstMessage(workdir: string, sessionId: string): string {
  return truncateSessionTitle(
    stripUserPromptHookContexts(stripPromptMetadata(readFirstUserContent(workdir, sessionId)))
  );
}

/** セッション台帳から消えた古いログの activity thread ID を先頭プロンプトから復元する。 */
export function deriveActivityThreadIdFromFirstMessage(
  workdir: string,
  sessionId: string
): string | null {
  const content = readFirstUserContent(workdir, sessionId);
  const platform = content
    .match(/^\[プラットフォーム:\s*([^\]]+)\]/m)?.[1]
    ?.trim()
    .toLowerCase();
  if (platform === 'web') return `web:${sessionId}`;
  if (platform !== 'discord' && platform !== 'slack') return null;

  const threadId = content.match(/\/\s*thread:.*?\(ID:\s*([^)]+)\)/)?.[1]?.trim();
  const channelId = content.match(/^\[チャンネル:.*?\(ID:\s*([^)]+)\)/m)?.[1]?.trim();
  const contextId = threadId || channelId;
  return contextId ? `${platform}:${contextId}` : null;
}
