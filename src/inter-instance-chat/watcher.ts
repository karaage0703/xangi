/**
 * inter-instance-chat の watcher 層。
 *
 * dir 配下の *.jsonl の追記を検出して、
 * 「自分以外のインスタンスからの新規メッセージ」を callback に流す。
 *
 * 設計:
 * - Node 標準 fs.watch を使う（追加依存なし、Linux + bind mount で動く）
 * - 各ファイルの「読了オフセット」を記憶し、差分行のみ JSON parse して emit
 * - polling fallback (INTER_INSTANCE_CHAT_USE_POLLING=true) は setInterval で mtime ベース確認
 *   → Mac/Win Docker Desktop 用
 * - 起動時に既存ファイルを「読了済み」としてシードしない選択もあるが、
 *   仕様確定 (5/5): 起動時に既存メッセージを全部読み込む → seedInitial=true で全 jsonl を最初から流す
 */
import { watch, statSync, existsSync, readFileSync, FSWatcher } from 'fs';
import type { InterChatMessage } from './jsonl-store.js';
import { listInstanceFiles, instanceIdFromFile } from './jsonl-store.js';

export interface WatcherOptions {
  /** 共有ディレクトリ */
  dir: string;
  /** 自分のインスタンスID。これと一致するファイルは監視対象に含めるが、emit はしない（自分のメッセージは loop しない） */
  selfInstanceId: string;
  /** メッセージ受信 callback */
  onMessage: (msg: InterChatMessage, fromInstanceId: string) => void;
  /** TTL（秒）。これより古いメッセージは emit しない */
  ttlSec: number;
  /** polling モード（chokidar 不在環境で fs.watch が信頼できない場合） */
  usePolling?: boolean;
  /** polling 間隔ミリ秒（デフォ 1000） */
  pollIntervalMs?: number;
  /** 起動時に既存メッセージを emit するか（デフォ true） */
  seedInitial?: boolean;
  /** デバッグ logger（デフォ console.log） */
  log?: (msg: string) => void;
}

export interface WatcherHandle {
  stop(): void;
  /** 現在追跡中のファイル数（テスト・診断用） */
  trackedFiles(): string[];
}

interface FileState {
  /** 既読バイト数 */
  readBytes: number;
  /** fs.watch handle (polling 時は undefined) */
  watcher?: FSWatcher;
}

/** 1ファイルの差分行を読み出して残りバイト数を返す */
function readNewLines(path: string, fromBytes: number): { lines: string[]; newBytes: number } {
  if (!existsSync(path)) return { lines: [], newBytes: fromBytes };
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { lines: [], newBytes: fromBytes };
  }
  if (stat.size <= fromBytes) {
    // truncate された場合は最初から読み直す
    if (stat.size < fromBytes) return readNewLines(path, 0);
    return { lines: [], newBytes: fromBytes };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { lines: [], newBytes: fromBytes };
  }
  const fullBytes = Buffer.byteLength(raw, 'utf-8');
  // fromBytes が文字途中になりうる -> シンプルに全行読み直して fromBytes 以降の改行行のみ取る
  // 行ベースで処理: 全 split → byte offset を行ごとに追跡
  const lines: string[] = [];
  let cursor = 0;
  for (const line of raw.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1; // +1 for \n
    if (cursor >= fromBytes) {
      if (line.trim()) lines.push(line);
    }
    cursor += lineBytes;
  }
  return { lines, newBytes: fullBytes };
}

/** 1行を JSON parse して InterChatMessage か判定 */
function parseLine(line: string): InterChatMessage | null {
  try {
    const m = JSON.parse(line) as InterChatMessage;
    if (
      typeof m.ts === 'number' &&
      typeof m.text === 'string' &&
      typeof m.from === 'string' &&
      typeof m.msg_id === 'string'
    ) {
      return m;
    }
  } catch {
    // ignore
  }
  return null;
}

export function startWatcher(options: WatcherOptions): WatcherHandle {
  const log = options.log || ((m) => console.log(`[inter-chat-watcher] ${m}`));
  const states = new Map<string, FileState>();
  const seenMsgIds = new Set<string>();
  const usePolling = !!options.usePolling;
  const pollInterval = options.pollIntervalMs ?? 1000;
  const seedInitial = options.seedInitial !== false;
  const now = () => Math.floor(Date.now() / 1000);

  function processNewLines(path: string): void {
    const fromInstanceId = instanceIdFromFile(path);
    if (fromInstanceId === options.selfInstanceId) {
      // 自分のファイルでも readBytes は更新する（loop 防止のため emit しない）
      const state = states.get(path);
      if (state) {
        const { newBytes } = readNewLines(path, state.readBytes);
        state.readBytes = newBytes;
      } else {
        try {
          states.set(path, { readBytes: statSync(path).size });
        } catch {
          states.set(path, { readBytes: 0 });
        }
      }
      return;
    }
    let state = states.get(path);
    if (!state) {
      state = { readBytes: 0 };
      states.set(path, state);
    }
    const { lines, newBytes } = readNewLines(path, state.readBytes);
    state.readBytes = newBytes;
    for (const line of lines) {
      const msg = parseLine(line);
      if (!msg) continue;
      if (seenMsgIds.has(msg.msg_id)) continue;
      seenMsgIds.add(msg.msg_id);
      // TTL チェック
      if (options.ttlSec > 0 && now() - msg.ts > options.ttlSec) continue;
      try {
        options.onMessage(msg, fromInstanceId);
      } catch (e) {
        log(`onMessage handler threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  function trackFile(path: string, readFromStart: boolean): void {
    if (states.has(path)) return;
    const initial: FileState = { readBytes: 0 };
    states.set(path, initial);
    if (!usePolling) {
      try {
        const w = watch(path, { persistent: true }, () => {
          processNewLines(path);
        });
        initial.watcher = w;
      } catch (e) {
        log(
          `fs.watch failed for ${path}: ${e instanceof Error ? e.message : String(e)} (polling fallback)`
        );
      }
    }
    if (readFromStart) {
      // 最初から読む（seedInitial か、起動後に新規生成されたファイル）
      processNewLines(path);
    } else {
      // 既読扱い（起動時に存在 + seedInitial=false）
      try {
        initial.readBytes = statSync(path).size;
      } catch {
        // ignore
      }
    }
  }

  // 起動時に既存ファイルを track（seedInitial に応じて読み込み）
  for (const path of listInstanceFiles(options.dir)) {
    trackFile(path, seedInitial);
  }

  // dir 自体を watch して新規ファイルを検出（起動後発見は常に最初から読む）
  let dirWatcher: FSWatcher | undefined;
  if (!usePolling) {
    try {
      dirWatcher = watch(options.dir, { persistent: true }, () => {
        for (const path of listInstanceFiles(options.dir)) {
          if (!states.has(path)) trackFile(path, true);
        }
      });
    } catch (e) {
      log(
        `fs.watch on dir failed: ${e instanceof Error ? e.message : String(e)} (polling fallback)`
      );
    }
  }

  // polling timer
  let pollTimer: NodeJS.Timeout | undefined;
  if (usePolling || !dirWatcher) {
    pollTimer = setInterval(() => {
      // 新規ファイル検出（起動後に現れたら最初から読む）
      for (const path of listInstanceFiles(options.dir)) {
        if (!states.has(path)) trackFile(path, true);
      }
      // 既知ファイルは差分チェック
      for (const path of states.keys()) {
        processNewLines(path);
      }
    }, pollInterval);
    pollTimer.unref();
  }

  return {
    stop(): void {
      for (const state of states.values()) {
        try {
          state.watcher?.close();
        } catch {
          // ignore
        }
      }
      states.clear();
      try {
        dirWatcher?.close();
      } catch {
        // ignore
      }
      if (pollTimer) clearInterval(pollTimer);
    },
    trackedFiles(): string[] {
      return Array.from(states.keys());
    },
  };
}
