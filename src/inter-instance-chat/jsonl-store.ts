/**
 * inter-instance-chat の jsonl 読み書き層。
 *
 * 設計原則:
 * - 各インスタンスは自分専用の <instanceId>.jsonl にだけ書き込む（単一writer）
 *   → O_APPEND で atomic、flock 不要（POSIX保証、行サイズ < PIPE_BUF=4KB前提）
 * - 読み取りは全インスタンスのファイルを横断
 * - TTL内のメッセージのみ採用、TTL外は compact で物理削除
 */
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  renameSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface InterChatMessage {
  /** unix 秒 */
  ts: number;
  /** 送信元 instance_id */
  from: string;
  /** 表示名（任意） */
  from_label?: string;
  /** 本文 */
  text: string;
  /** 起源連鎖。先頭は通常 'user'。応答するたびに自分の id を append */
  origin_chain: string[];
  /** UUID。重複検出用 */
  msg_id: string;
}

export interface AppendOptions {
  /** ts を指定しない場合は now */
  ts?: number;
  /** デフォ ['user'] */
  origin_chain?: string[];
  /** 表示名 */
  from_label?: string;
  /** msg_id を指定（テスト用） */
  msg_id?: string;
}

/** dir を mode 0o777 で作成。失敗してもメッセージを出して継続 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o777 });
  }
  // 書き込みテスト
  try {
    const probe = join(dir, `.write_test_${process.pid}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[inter-instance-chat] cannot write to ${dir}: ${msg}`);
  }
}

/** 自分の jsonl ファイルパス */
export function selfPath(dir: string, instanceId: string): string {
  return join(dir, `${instanceId}.jsonl`);
}

/** 全インスタンスの jsonl ファイル名一覧（フルパス） */
export function listInstanceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f));
}

/** ファイル名から instanceId を抜く */
export function instanceIdFromFile(path: string): string {
  const m = path.match(/([^/\\]+)\.jsonl$/);
  return m ? m[1] : path;
}

/**
 * 自分の jsonl にメッセージを append する。
 * - 単一 writer なので flock 不要
 * - 行は単一の JSON.stringify、改行で終端
 */
export function appendMessage(
  dir: string,
  selfInstanceId: string,
  text: string,
  options: AppendOptions = {}
): InterChatMessage {
  ensureDir(dir);
  const message: InterChatMessage = {
    ts: options.ts ?? Math.floor(Date.now() / 1000),
    from: selfInstanceId,
    from_label: options.from_label,
    text,
    origin_chain: options.origin_chain ?? ['user'],
    msg_id: options.msg_id ?? randomUUID(),
  };
  const line = JSON.stringify(message) + '\n';
  appendFileSync(selfPath(dir, selfInstanceId), line, { mode: 0o666 });
  return message;
}

/** 1ファイルから全メッセージを読み出す（壊れた行は warn してスキップ） */
export function readFile(path: string): InterChatMessage[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const messages: InterChatMessage[] = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as InterChatMessage;
      if (
        typeof msg.ts === 'number' &&
        typeof msg.text === 'string' &&
        typeof msg.from === 'string'
      ) {
        messages.push(msg);
      }
    } catch {
      // 壊れた行はスキップ
    }
  }
  return messages;
}

/**
 * dir 内全ファイルを読んで、TTL 内のメッセージを ts 昇順で返す。
 * @param ttlSec TTL（秒）。0 以下だと無制限
 * @param now 現在時刻（秒）。テスト用
 */
export function readAll(
  dir: string,
  ttlSec: number,
  now: number = Math.floor(Date.now() / 1000)
): InterChatMessage[] {
  const all: InterChatMessage[] = [];
  for (const path of listInstanceFiles(dir)) {
    for (const m of readFile(path)) {
      if (ttlSec > 0 && now - m.ts > ttlSec) continue;
      all.push(m);
    }
  }
  all.sort((a, b) => a.ts - b.ts || a.msg_id.localeCompare(b.msg_id));
  return all;
}

/**
 * 自分のファイルから TTL 外のメッセージを削除する（物理 compact）。
 * - 自分のファイルだけを書き換える（他インスタンスのファイルには触れない）
 * - 一時ファイルに書いてから rename で atomic 置換
 */
export function compactSelf(
  dir: string,
  selfInstanceId: string,
  ttlSec: number,
  now: number = Math.floor(Date.now() / 1000)
): { kept: number; removed: number } {
  const path = selfPath(dir, selfInstanceId);
  if (!existsSync(path)) return { kept: 0, removed: 0 };
  const all = readFile(path);
  const kept = ttlSec > 0 ? all.filter((m) => now - m.ts <= ttlSec) : all;
  const removed = all.length - kept.length;
  if (removed === 0) return { kept: kept.length, removed: 0 };
  const tmp = path + '.tmp';
  const body = kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length > 0 ? '\n' : '');
  writeFileSync(tmp, body, { mode: 0o666 });
  // rename atomic（Node の renameSync で十分、同一FS前提）
  try {
    renameSync(tmp, path);
  } catch {
    // 失敗時はフォールバックで上書き
    writeFileSync(path, body, { mode: 0o666 });
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
  return { kept: kept.length, removed };
}

/** ファイルの mtime を返す（テスト・watcher debounce 用） */
export function fileMTime(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 自分の jsonl から特定の msg_id を持つ行を削除する。
 * - 他インスタンスのファイルには触れない（単一 writer 原則）
 * - 一時ファイル経由の atomic rename
 * @returns 削除した件数（通常 0 か 1）
 */
export function deleteMessageById(dir: string, selfInstanceId: string, msgId: string): number {
  const path = selfPath(dir, selfInstanceId);
  if (!existsSync(path)) return 0;
  const all = readFile(path);
  const kept = all.filter((m) => m.msg_id !== msgId);
  const removed = all.length - kept.length;
  if (removed === 0) return 0;
  const tmp = path + '.tmp';
  const body = kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length > 0 ? '\n' : '');
  writeFileSync(tmp, body, { mode: 0o666 });
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, body, { mode: 0o666 });
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
  return removed;
}

/**
 * 自分の jsonl を空にする。
 * - 他インスタンスのファイルには触れない
 * - ファイルが存在しなければ 0 を返す
 * @returns 削除した件数
 */
export function clearSelf(dir: string, selfInstanceId: string): number {
  const path = selfPath(dir, selfInstanceId);
  if (!existsSync(path)) return 0;
  const all = readFile(path);
  if (all.length === 0) {
    // 空ファイルなら何もしない
    return 0;
  }
  writeFileSync(path, '', { mode: 0o666 });
  return all.length;
}
