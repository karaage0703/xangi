/**
 * イベントトリガー — 外部イベントによるエージェントターン起動
 *
 * tool-server の POST /api/trigger で受けた外部イベント（ビルド完了・CI 結果・
 * 新着検知など）から、scheduler に登録済みの agentRunner を使って
 * エージェントターンを起動する。ポーリング（定期スケジュールでの確認）を
 * プッシュ（イベント発生時のみ起動）に置き換えるための機構。
 *
 * セキュリティ設計:
 * - TRIGGER_ENABLED=true の明示 opt-in が必要（デフォルト無効）
 * - Bearer トークン（XANGI_TRIGGER_TOKEN）必須。トークン未設定の場合は
 *   有効化されていても全リクエストを拒否する（tool-server は 0.0.0.0 bind のため、
 *   トークン無し運用を許すとネットワーク越しに任意プロンプトを注入できてしまう）
 * - source 単位のレート制限と同時実行ガードで暴走・連打を防ぐ
 */
import { timingSafeEqual } from 'crypto';
import type { Scheduler, Platform } from './scheduler.js';
import { webAppSessionId } from './sessions.js';

/** トリガー受付メッセージの上限文字数 */
export const TRIGGER_MAX_MESSAGE_LENGTH = 4000;

/** source 名の制約（表示・ログ・レート制限キーに使うため英数等に限定） */
const SOURCE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

const VALID_PLATFORMS: Platform[] = ['discord', 'slack', 'telegram', 'web'];

export interface TriggerConfig {
  /** 機能全体の有効化（TRIGGER_ENABLED、デフォルト false） */
  enabled: boolean;
  /** Bearer 認証トークン（XANGI_TRIGGER_TOKEN）。未設定なら HTTP 経由は全拒否 */
  token?: string;
  /** 同一 source の最短発火間隔 ms（TRIGGER_MIN_INTERVAL_MS、デフォルト 10000） */
  minIntervalMs: number;
}

export interface TriggerRequestBody {
  channel?: unknown;
  message?: unknown;
  source?: unknown;
  platform?: unknown;
}

export interface TriggerResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 環境変数からトリガー設定を読み込む
 */
export function loadTriggerConfig(env: NodeJS.ProcessEnv = process.env): TriggerConfig {
  const rawInterval = env.TRIGGER_MIN_INTERVAL_MS;
  // Number('') は 0 になるため、未設定・空文字は明示的にデフォルトへ落とす
  const parsedInterval =
    rawInterval === undefined || rawInterval === '' ? NaN : Number(rawInterval);
  return {
    enabled: env.TRIGGER_ENABLED === 'true',
    token: env.XANGI_TRIGGER_TOKEN || undefined,
    minIntervalMs: Number.isFinite(parsedInterval) && parsedInterval >= 0 ? parsedInterval : 10_000,
  };
}

/** 定数時間比較でトークンを検証する */
function verifyToken(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class EventTrigger {
  private lastFiredAt = new Map<string, number>();
  private runningSources = new Set<string>();
  private counter = 0;

  constructor(
    private config: TriggerConfig,
    private scheduler: Scheduler
  ) {}

  /**
   * HTTP 経由のトリガーリクエストを処理する（Bearer 認証必須）
   */
  async handleHttp(
    body: TriggerRequestBody,
    authorizationHeader: string | undefined
  ): Promise<TriggerResult> {
    if (!this.config.enabled) {
      return { status: 404, body: { ok: false, error: 'Trigger is not enabled' } };
    }
    if (!this.config.token) {
      // トークン未設定で受け付けると認証なしの入口になるため拒否
      console.warn('[trigger] Rejected: XANGI_TRIGGER_TOKEN is not set');
      return {
        status: 401,
        body: { ok: false, error: 'XANGI_TRIGGER_TOKEN is not configured on the server' },
      };
    }
    const header = authorizationHeader ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!provided || !verifyToken(this.config.token, provided)) {
      return { status: 401, body: { ok: false, error: 'Invalid or missing bearer token' } };
    }
    return this.fire(body);
  }

  /**
   * ローカル（xangi-cmd / tool-server の /api/execute）経由のトリガー。
   * tool-server のローカルコマンド経路は既存の信頼境界に従い token 検証を
   * 省略するが、機能自体の opt-in（TRIGGER_ENABLED）は要求する。
   */
  async handleLocal(body: TriggerRequestBody): Promise<TriggerResult> {
    if (!this.config.enabled) {
      return { status: 404, body: { ok: false, error: 'Trigger is not enabled' } };
    }
    return this.fire(body);
  }

  private async fire(body: TriggerRequestBody): Promise<TriggerResult> {
    // ── バリデーション ──
    const requestedChannel = typeof body.channel === 'string' ? body.channel.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!requestedChannel) {
      return { status: 400, body: { ok: false, error: 'channel is required' } };
    }
    if (!message) {
      return { status: 400, body: { ok: false, error: 'message is required' } };
    }
    if (message.length > TRIGGER_MAX_MESSAGE_LENGTH) {
      return {
        status: 400,
        body: {
          ok: false,
          error: `message is too long (max ${TRIGGER_MAX_MESSAGE_LENGTH} chars)`,
        },
      };
    }
    const source = typeof body.source === 'string' && body.source ? body.source : 'external';
    if (!SOURCE_PATTERN.test(source)) {
      return {
        status: 400,
        body: { ok: false, error: 'source must match [A-Za-z0-9_.:-]{1,64}' },
      };
    }
    const platform = (
      typeof body.platform === 'string' && body.platform ? body.platform : 'discord'
    ) as Platform;
    if (!VALID_PLATFORMS.includes(platform)) {
      return {
        status: 400,
        body: { ok: false, error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` },
      };
    }
    const channel =
      platform === 'web' ? webAppSessionId(requestedChannel).trim() : requestedChannel;
    if (!channel) {
      return { status: 400, body: { ok: false, error: 'channel is required' } };
    }

    // ── 暴走防止 ──
    if (this.runningSources.has(source)) {
      return {
        status: 409,
        body: { ok: false, error: `Trigger for source "${source}" is already running` },
      };
    }
    const now = Date.now();
    const last = this.lastFiredAt.get(source);
    if (last !== undefined && now - last < this.config.minIntervalMs) {
      const retryAfterMs = this.config.minIntervalMs - (now - last);
      return {
        status: 429,
        body: { ok: false, error: 'Rate limited', retryAfterMs },
      };
    }

    // ── 実行経路の解決 ──
    const runner = this.scheduler.getAgentRunner(platform);
    if (!runner) {
      return {
        status: 503,
        body: { ok: false, error: `No agent runner registered for platform: ${platform}` },
      };
    }

    this.lastFiredAt.set(source, now);
    this.counter += 1;
    const triggerId = `trg_${now.toString(36)}_${this.counter}`;

    // 発火の可視化: チャンネルに ⚡ ラベルを先に投げる（失敗しても本処理は続行）
    const sender = this.scheduler.getSender(platform);
    if (sender) {
      sender(channel, `⚡ trigger: ${source}`).catch((err) => {
        console.warn(`[trigger] Failed to send label for ${triggerId}:`, err);
      });
    }

    // エージェントターンは fire-and-forget（HTTP 応答はターン完了を待たない）
    const prompt = `[イベントトリガー発火: source=${source}, id=${triggerId}]\n${message}`;
    this.runningSources.add(source);
    console.log(`[trigger] ${triggerId} source=${source} platform=${platform} → turn started`);
    runner(prompt, channel)
      .then((result) => {
        console.log(`[trigger] ${triggerId} completed (${result.length} chars)`);
      })
      .catch((err) => {
        console.error(`[trigger] ${triggerId} failed:`, err);
      })
      .finally(() => {
        this.runningSources.delete(source);
      });

    return { status: 202, body: { ok: true, triggerId, source, platform } };
  }
}
