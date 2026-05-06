/**
 * セッションタイトル導出ユーティリティ。
 *
 * Discord/Slack/Web のプロンプトにはメタデータ行（`[プラットフォーム: ...]` など）が
 * 先頭に付くため、UI に出すときはそれを剥がした最初の本文をタイトル候補として使う。
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const PROMPT_METADATA_PATTERNS: RegExp[] = [
  /^\[プラットフォーム: [^\]]*\]\n?/,
  /^\[チャンネル: [^\]]*\]\n?/,
  /^\[発言者: [^\]]*\]\n?/,
  /^\[現在時刻: [^\]]*\]\n?/,
];

/**
 * プロンプト先頭のメタデータ行を順に剥がして本文だけ返す。
 * 4種類のメタデータ行（プラットフォーム / チャンネル / 発言者 / 現在時刻）が
 * 並ぶ前提で、未指定の行はスキップして OK。
 */
export function stripPromptMetadata(text: string): string {
  let s = text;
  for (const re of PROMPT_METADATA_PATTERNS) {
    s = s.replace(re, '');
  }
  return s.trim();
}

/**
 * セッションログ（logs/sessions/<id>.jsonl）の最初のユーザーメッセージから
 * 表示用タイトルを生成する。50 文字に切り詰める。導出できなければ空文字。
 */
export function deriveTitleFromFirstMessage(workdir: string, sessionId: string): string {
  try {
    const filePath = join(workdir, 'logs', 'sessions', `${sessionId}.jsonl`);
    if (!existsSync(filePath)) return '';
    const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0];
    if (!firstLine) return '';
    const entry = JSON.parse(firstLine) as { role?: string; content?: unknown };
    if (entry.role !== 'user' || typeof entry.content !== 'string') return '';
    return stripPromptMetadata(entry.content).slice(0, 50);
  } catch {
    return '';
  }
}
