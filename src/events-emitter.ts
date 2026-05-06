/**
 * Pull 型 SSE 配信用の event bus。
 *
 * 旧 push 型 (`XANGI_EVENTS_URLS` で指定された receiver に POST) は廃止し、
 * xangi 内部の subscriber に publish するだけのバスに変えた。consumer
 * (デスクトップアバター、可視化ツール等) は web-chat サーバの
 * `GET /api/events/stream` (SSE) を購読して取りに来る。
 *
 * 設計方針:
 * - 操作的イベント (turn.started / message.delta / turn.complete / turn.aborted /
 *   agent.error) のみ流し、状態 (thinking/talking/idle) は consumer 側で派生させる。
 * - publish はベスト・エフォート: subscriber が例外を投げても他の subscriber は
 *   止めない。本業 (応答ストリーミング) を遅らせない。
 * - 設定は最初の publish 時に評価する (lazy)。.env / dotenv の読み込みより前に
 *   モジュールが import されても問題ないようにするため。
 */

import { createHash } from 'crypto';
import { hostname } from 'os';
import { join } from 'path';

interface ResolvedConfig {
  enabled: boolean;
  instanceId: string;
  hostHint: string;
  instanceIdSource: 'explicit' | 'auto';
}

let cachedConfig: ResolvedConfig | null = null;

export function resolveDataDir(): string {
  return process.env.DATA_DIR || join(process.env.WORKSPACE_PATH || process.cwd(), '.xangi');
}

export function resolveInstanceId(): { id: string; source: 'explicit' | 'auto' } {
  const explicit = process.env.XANGI_INSTANCE_ID?.trim();
  if (explicit) return { id: explicit, source: 'explicit' };
  // hostname + DATA_DIR ハッシュで自動採番。
  // 同じ DATA_DIR で再起動すると ID が保持される (consumer 側のフィルタ設定が壊れない)。
  // 同一 PC で別 DATA_DIR なら自動的に別 ID。
  const hash = createHash('sha1').update(resolveDataDir()).digest('hex').slice(0, 6);
  return { id: `xangi-${hostname()}-${hash}`, source: 'auto' };
}

function resolveConfig(): ResolvedConfig {
  if (cachedConfig) return cachedConfig;
  const enabled = process.env.XANGI_EVENTS_ENABLED !== 'false';
  const { id, source } = resolveInstanceId();
  cachedConfig = {
    enabled,
    instanceId: id,
    hostHint: hostname(),
    instanceIdSource: source,
  };
  return cachedConfig;
}

export type Platform = 'discord' | 'slack' | 'web';

/** プラットフォーム不問の thread_id を組み立てる。例: discord:123, slack:C012, web:session-abc */
export function threadIdFor(platform: Platform, id: string): string {
  return `${platform}:${id}`;
}

/** プラットフォーム不問の turn_id を組み立てる。例: discord-msg-456 */
export function turnIdFor(platform: Platform, messageId: string): string {
  return `${platform}-msg-${messageId}`;
}

interface CommonOpts {
  threadId: string;
  turnId: string;
  /** 表示用の人間に読める名前。例: "#general", "DM with karaage", "Browser session" */
  threadLabel?: string;
  /** プラットフォーム種別 (任意。consumer が表示分岐に使うため) */
  platform?: Platform;
}

export interface TurnStartedOpts extends CommonOpts {
  userText?: string;
}
export interface MessageDeltaOpts extends CommonOpts {
  chunk: string;
  fullText: string;
}
export interface TurnCompleteOpts extends CommonOpts {
  text?: string;
}
export type TurnAbortedOpts = CommonOpts;
export interface AgentErrorOpts extends CommonOpts {
  message: string;
}

interface BaseBody {
  thread_id: string;
  turn_id: string;
  thread_label?: string;
  platform?: Platform;
  ts: number;
}

type EventBody =
  | ({ type: 'turn.started'; user_text?: string } & BaseBody)
  | ({ type: 'message.delta'; text: string; full_text: string } & BaseBody)
  | ({ type: 'turn.complete'; text?: string } & BaseBody)
  | ({ type: 'turn.aborted' } & BaseBody)
  | ({ type: 'agent.error'; message: string } & BaseBody);

/** Subscriber が受け取る最終ペイロード (instance_id / host_hint 付き)。 */
export type PublishedEvent = EventBody & {
  instance_id: string;
  host_hint: string;
};

export type EventSubscriber = (payload: PublishedEvent) => void;

const subscribers = new Set<EventSubscriber>();

/**
 * 全イベントを購読する。返り値は unsubscribe 関数。
 *
 * SSE ハンドラ / テスト / 内部の派生モジュールが使う。
 * subscriber が例外を投げても他の subscriber には影響しない。
 */
export function subscribeEvents(cb: EventSubscriber): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** 現在の subscriber 数 (運用 / デバッグ用)。 */
export function getSubscriberCount(): number {
  return subscribers.size;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function baseFields(opts: CommonOpts): BaseBody {
  return {
    thread_id: opts.threadId,
    turn_id: opts.turnId,
    thread_label: opts.threadLabel,
    platform: opts.platform,
    ts: nowSec(),
  };
}

function publish(body: EventBody): void {
  const cfg = resolveConfig();
  if (!cfg.enabled) return;
  if (subscribers.size === 0) return;
  const payload: PublishedEvent = {
    ...body,
    instance_id: cfg.instanceId,
    host_hint: cfg.hostHint,
  };
  for (const cb of subscribers) {
    try {
      cb(payload);
    } catch {
      // subscriber 側のエラーは握り潰す (本業を止めない)。
    }
  }
}

export function getEventsConfig(): ResolvedConfig {
  return resolveConfig();
}

/**
 * テスト用: キャッシュされた設定と subscribers をクリアする。
 */
export function _resetEventsConfigForTest(): void {
  cachedConfig = null;
  subscribers.clear();
}

export const events = {
  turnStarted(opts: TurnStartedOpts): void {
    publish({ type: 'turn.started', ...baseFields(opts), user_text: opts.userText });
  },
  messageDelta(opts: MessageDeltaOpts): void {
    publish({
      type: 'message.delta',
      ...baseFields(opts),
      text: opts.chunk,
      full_text: opts.fullText,
    });
  },
  turnComplete(opts: TurnCompleteOpts): void {
    publish({ type: 'turn.complete', ...baseFields(opts), text: opts.text });
  },
  turnAborted(opts: TurnAbortedOpts): void {
    publish({ type: 'turn.aborted', ...baseFields(opts) });
  },
  agentError(opts: AgentErrorOpts): void {
    publish({ type: 'agent.error', ...baseFields(opts), message: opts.message });
  },
};
