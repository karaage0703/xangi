/**
 * inter-instance-chat の統合エントリ。
 *
 * - 設定の読み込み
 * - ストア / watcher の起動・停止
 * - send (自分の jsonl に追記) のラッパー
 * - 受信した他インスタンスメッセージのリスナ管理
 *
 * 公開する関数:
 *   startInterInstanceChat(): 起動
 *   stopInterInstanceChat(): 停止
 *   sendMessage(text, options): 送信（自分のjsonlに追記）
 *   readRecent(maxN, ttlSec?): 最近のメッセージ
 *   onMessage(handler): 他インスタンスからの受信を購読
 *   getInterChatConfig(): 解決済みの設定取得
 */
import { resolveInstanceId, resolveDataDir as resolveStateDir } from '../events-emitter.js';
import {
  appendMessage,
  readAll,
  ensureDir,
  compactSelf,
  deleteMessageById,
  clearSelf,
  type InterChatMessage,
  type AppendOptions,
} from './jsonl-store.js';
import { startWatcher, type WatcherHandle } from './watcher.js';

export type { InterChatMessage, AppendOptions };

export interface InterChatConfig {
  enabled: boolean;
  dir: string;
  selfInstanceId: string;
  ttlSec: number;
  compactIntervalSec: number;
  usePolling: boolean;
  /** 表示名。デフォは selfInstanceId と同じ */
  selfLabel: string;
}

let cachedConfig: InterChatConfig | null = null;
let watcher: WatcherHandle | null = null;
let compactTimer: NodeJS.Timeout | null = null;
const listeners = new Set<(msg: InterChatMessage, fromInstanceId: string) => void>();
let started = false;

export function getInterChatConfig(): InterChatConfig {
  if (cachedConfig) return cachedConfig;
  const enabled = process.env.INTER_INSTANCE_CHAT_ENABLED === 'true';
  const dir = process.env.INTER_INSTANCE_CHAT_DIR?.trim() || '/tmp/xangi-chat';
  const ttlSec = parseInt(process.env.INTER_INSTANCE_CHAT_TTL_SEC || '3600', 10);
  const compactIntervalSec = parseInt(
    process.env.INTER_INSTANCE_CHAT_COMPACT_INTERVAL_SEC || '600',
    10
  );
  const usePolling = process.env.INTER_INSTANCE_CHAT_USE_POLLING === 'true';
  const { id: selfInstanceId } = resolveInstanceId();
  const selfLabel = process.env.XANGI_INSTANCE_LABEL?.trim() || selfInstanceId;

  cachedConfig = {
    enabled,
    dir,
    selfInstanceId,
    ttlSec: Number.isFinite(ttlSec) ? ttlSec : 3600,
    compactIntervalSec: Number.isFinite(compactIntervalSec) ? compactIntervalSec : 600,
    usePolling,
    selfLabel,
  };
  return cachedConfig;
}

/** 設定キャッシュをクリア（テスト用） */
export function _resetInterChatConfigForTest(): void {
  cachedConfig = null;
}

/**
 * 起動。INTER_INSTANCE_CHAT_ENABLED=true のときのみ実体が動く。
 * 多重 start は no-op（既に動いてれば何もしない）。
 */
export function startInterInstanceChat(): InterChatConfig {
  const cfg = getInterChatConfig();
  if (!cfg.enabled) return cfg;
  if (started) return cfg;

  ensureDir(cfg.dir);

  watcher = startWatcher({
    dir: cfg.dir,
    selfInstanceId: cfg.selfInstanceId,
    ttlSec: cfg.ttlSec,
    usePolling: cfg.usePolling,
    seedInitial: true,
    onMessage: (msg, fromInstanceId) => {
      for (const fn of listeners) {
        try {
          fn(msg, fromInstanceId);
        } catch (e) {
          console.warn(
            `[inter-instance-chat] listener threw: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    },
  });

  // 定期 compact
  if (cfg.compactIntervalSec > 0 && cfg.ttlSec > 0) {
    compactTimer = setInterval(() => {
      try {
        compactSelf(cfg.dir, cfg.selfInstanceId, cfg.ttlSec);
      } catch (e) {
        console.warn(
          `[inter-instance-chat] compact failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }, cfg.compactIntervalSec * 1000);
    compactTimer.unref();
  }

  started = true;
  console.log(
    `[inter-instance-chat] started (instance=${cfg.selfInstanceId}, dir=${cfg.dir}, ttl=${cfg.ttlSec}s, polling=${cfg.usePolling})`
  );
  return cfg;
}

export function stopInterInstanceChat(): void {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
  if (compactTimer) {
    clearInterval(compactTimer);
    compactTimer = null;
  }
  listeners.clear();
  started = false;
}

export function isStarted(): boolean {
  return started;
}

/**
 * 送信。自分の jsonl に append する。
 * - origin_chain は呼び出し側が指定するか、デフォ ['user']
 * - text が空のときは何もしない
 */
export function sendMessage(text: string, options: AppendOptions = {}): InterChatMessage | null {
  const cfg = getInterChatConfig();
  if (!cfg.enabled) {
    throw new Error(
      'inter-instance-chat is disabled (set INTER_INSTANCE_CHAT_ENABLED=true to enable)'
    );
  }
  if (!text || !text.trim()) return null;
  ensureDir(cfg.dir);
  const msg = appendMessage(cfg.dir, cfg.selfInstanceId, text, {
    from_label: options.from_label || cfg.selfLabel,
    origin_chain: options.origin_chain || ['user'],
    msg_id: options.msg_id,
    ts: options.ts,
  });
  return msg;
}

/**
 * web-chat 等の既存プラットフォームからの会話を inter-chat の自分の jsonl に流す。
 * fire-and-forget: enabled=false なら何もしない、エラーは warn して握り潰す。
 *
 * - role='user' のとき origin_chain=['user']、from_label="<selfLabel> (user)"
 * - role='agent' のとき origin_chain=['user', <selfInstanceId>]、from_label="<selfLabel> (agent)"
 *
 * 設計意図: 「自分の jsonl」に書き込まれる主体はあくまで自インスタンス（from は selfInstanceId）。
 * 人間 vs エージェント発言の区別は from_label / origin_chain の長さで表現する。
 */
export function flowFromHostPlatform(
  text: string,
  role: 'user' | 'agent'
): InterChatMessage | null {
  const cfg = getInterChatConfig();
  if (!cfg.enabled) return null;
  if (!text || !text.trim()) return null;
  try {
    const fromLabel = `${cfg.selfLabel} (${role})`;
    const originChain = role === 'user' ? ['user'] : ['user', cfg.selfInstanceId];
    return appendMessage(cfg.dir, cfg.selfInstanceId, text, {
      from_label: fromLabel,
      origin_chain: originChain,
    });
  } catch (e) {
    console.warn(
      `[inter-instance-chat] flowFromHostPlatform failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

/** TTL内の最近メッセージを返す（昇順）。limit があれば末尾 N 件 */
export function readRecent(limit?: number, ttlOverrideSec?: number): InterChatMessage[] {
  const cfg = getInterChatConfig();
  const ttl = ttlOverrideSec ?? cfg.ttlSec;
  const all = readAll(cfg.dir, ttl);
  if (limit && limit > 0 && all.length > limit) {
    return all.slice(-limit);
  }
  return all;
}

/**
 * 自分の jsonl から特定の msg_id を持つ行を削除する。
 * - 他インスタンスのメッセージは削除できない（単一 writer 原則）
 * @returns 削除した件数（通常 0 か 1）
 */
export function deleteOwnMessage(msgId: string): number {
  const cfg = getInterChatConfig();
  if (!cfg.enabled) {
    throw new Error(
      'inter-instance-chat is disabled (set INTER_INSTANCE_CHAT_ENABLED=true to enable)'
    );
  }
  return deleteMessageById(cfg.dir, cfg.selfInstanceId, msgId);
}

/**
 * 自分の jsonl を空にする。
 * - 他インスタンスのメッセージは削除しない
 * @returns 削除した件数
 */
export function clearOwnMessages(): number {
  const cfg = getInterChatConfig();
  if (!cfg.enabled) {
    throw new Error(
      'inter-instance-chat is disabled (set INTER_INSTANCE_CHAT_ENABLED=true to enable)'
    );
  }
  return clearSelf(cfg.dir, cfg.selfInstanceId);
}

/**
 * 受信メッセージ購読。
 * - watcher が動いてないと何も流れない
 * - 自分のメッセージは流れない
 */
export function onMessage(
  handler: (msg: InterChatMessage, fromInstanceId: string) => void
): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/** メンション抽出（先頭/単語境界の @<id> を集める） */
export function extractMentions(text: string): string[] {
  const matches = text.match(/(^|\s)@([\w.-]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.replace(/^.*?@/, ''));
}

/** メンションが自分宛か判定 */
export function isMentioned(text: string, selfInstanceId: string, selfLabel?: string): boolean {
  const mentions = extractMentions(text);
  if (mentions.includes(selfInstanceId)) return true;
  if (selfLabel && mentions.includes(selfLabel)) return true;
  return false;
}

/** state dir 解決（テスト・診断用に export） */
export const __debug__ = { resolveStateDir };
