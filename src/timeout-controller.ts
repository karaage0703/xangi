import { EventEmitter } from 'events';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, TIMEOUT_EXTEND_ENABLED } from './constants.js';
import type { TimeoutState, ExtendTimeoutResult } from './agent-runner.js';

interface TimeoutResource {
  timeoutAt: number;
  maxTimeoutAt: number;
  timeoutMs: number;
  startedAt: number;
  timer: NodeJS.Timeout;
  onTimeout: () => void;
}

/**
 * チャンネル別のタイムアウト管理を共通化するコンポーネント。
 *
 * 全 Runner (LocalLlm/Codex/Grok/PersistentRunner) で同じ
 * timeoutAt/maxTimeoutAt/extend ロジックを共有するため、状態と
 * timeout-* イベント発火を 1 箇所に集約する。
 *
 * 使い方:
 *   class FooRunner extends EventEmitter implements AgentRunner {
 *     private timeoutController = new TimeoutController();
 *     constructor() {
 *       super();
 *       for (const evt of ['timeout-started', 'timeout-extended', 'timeout-cleared'] as const) {
 *         this.timeoutController.on(evt, (p) => this.emit(evt, p));
 *       }
 *     }
 *     async run(prompt, opts) {
 *       const channelId = opts?.channelId ?? '__default__';
 *       const ac = new AbortController();
 *       this.timeoutController.start(channelId, () => ac.abort());
 *       try {
 *         const result = await callLlm(prompt, { signal: ac.signal });
 *         this.timeoutController.clear(channelId, 'completed');
 *         return result;
 *       } catch (e) {
 *         this.timeoutController.clear(channelId, 'error');
 *         throw e;
 *       }
 *     }
 *     getTimeoutState(channelId) { return this.timeoutController.getState(channelId); }
 *     extendTimeout(channelId, ms) { return this.timeoutController.extend(channelId, ms); }
 *   }
 */
export class TimeoutController extends EventEmitter {
  private resources = new Map<string, TimeoutResource>();
  private readonly baseTimeoutMs: number;
  private readonly maxTimeoutMs: number;

  constructor(opts?: { baseTimeoutMs?: number; maxTimeoutMs?: number }) {
    super();
    this.baseTimeoutMs = opts?.baseTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = opts?.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  }

  /**
   * リクエスト開始時に呼ぶ。
   * 既存リソースがあれば silent に置き換える (再起動扱い)。
   * タイマー発火時は onTimeout を呼んだ後 'timeout-cleared' (reason: 'timeout') を emit。
   */
  start(channelId: string, onTimeout: () => void): void {
    this.clearInternal(channelId, 'silent');
    const now = Date.now();
    const timeoutAt = now + this.baseTimeoutMs;
    const maxTimeoutAt = now + this.maxTimeoutMs;
    const timer = setTimeout(() => this.fireTimeout(channelId), this.baseTimeoutMs);
    this.resources.set(channelId, {
      timeoutAt,
      maxTimeoutAt,
      timeoutMs: this.baseTimeoutMs,
      startedAt: now,
      timer,
      onTimeout,
    });
    this.emit('timeout-started', {
      channelId,
      timeoutAt,
      maxTimeoutAt,
      timeoutMs: this.baseTimeoutMs,
    });
  }

  /** リクエスト完了 / エラー時に呼ぶ。reason='silent' は emit を抑制 (内部用)。*/
  clear(channelId: string, reason: 'completed' | 'error' | 'timeout' | string): void {
    this.clearInternal(channelId, reason);
  }

  private clearInternal(channelId: string, reason: string): void {
    const r = this.resources.get(channelId);
    if (!r) return;
    clearTimeout(r.timer);
    this.resources.delete(channelId);
    if (reason !== 'silent') {
      this.emit('timeout-cleared', { channelId, reason });
    }
  }

  /** タイマー発火時の内部処理。 */
  private fireTimeout(channelId: string): void {
    const r = this.resources.get(channelId);
    if (!r) return;
    this.resources.delete(channelId);
    try {
      r.onTimeout();
    } catch (e) {
      console.error(`[timeout-controller] onTimeout threw for ${channelId}:`, e);
    }
    this.emit('timeout-cleared', { channelId, reason: 'timeout' });
  }

  /**
   * タイムアウトを延長する。
   * - `TIMEOUT_EXTEND_ENABLED=false`: { ok: false, reason: 'unsupported' }
   * - 進行中リクエストが無い: { ok: false, reason: 'no_active_request' }
   * - `additionalMs` 省略時は **残り時間 (remainingMs) を採用** → 結果として残り時間が 2 倍になる
   * - additionalMs <= 0 / 非数: { ok: false, reason: 'no_active_request' }
   * - max 超過: { ok: false, reason: 'max_timeout_exceeded', maxTimeoutAt }
   * - 成功: { ok: true, timeoutAt, remainingMs, timeoutMs, maxTimeoutAt } + emit 'timeout-extended'
   */
  extend(channelId: string, additionalMs?: number): ExtendTimeoutResult {
    if (!TIMEOUT_EXTEND_ENABLED) {
      return { ok: false, reason: 'unsupported' };
    }
    const r = this.resources.get(channelId);
    if (!r) return { ok: false, reason: 'no_active_request' };
    const currentRemaining = Math.max(0, r.timeoutAt - Date.now());
    // 省略時は残り時間を加算 → 結果 (residual + delta) で「2 倍」相当
    const ms = additionalMs ?? currentRemaining;
    if (!Number.isFinite(ms) || ms <= 0) {
      return { ok: false, reason: 'no_active_request' };
    }
    const requested = r.timeoutAt + ms;
    if (requested > r.maxTimeoutAt) {
      return {
        ok: false,
        reason: 'max_timeout_exceeded',
        maxTimeoutAt: r.maxTimeoutAt,
      };
    }
    clearTimeout(r.timer);
    const remainingMs = Math.max(0, requested - Date.now());
    r.timeoutAt = requested;
    r.timeoutMs += ms;
    r.timer = setTimeout(() => this.fireTimeout(channelId), remainingMs);
    this.emit('timeout-extended', {
      channelId,
      timeoutAt: requested,
      maxTimeoutAt: r.maxTimeoutAt,
      timeoutMs: r.timeoutMs,
      remainingMs,
    });
    return {
      ok: true,
      timeoutAt: requested,
      remainingMs,
      timeoutMs: r.timeoutMs,
      maxTimeoutAt: r.maxTimeoutAt,
    };
  }

  /** UI 表示用の現在状態。 */
  getState(channelId: string): TimeoutState {
    const r = this.resources.get(channelId);
    if (!r) return { active: false };
    return {
      active: true,
      timeoutAt: r.timeoutAt,
      maxTimeoutAt: r.maxTimeoutAt,
      remainingMs: Math.max(0, r.timeoutAt - Date.now()),
      timeoutMs: r.timeoutMs,
    };
  }

  /** プロセス終了 / runner shutdown 時に全部解放する。 */
  clearAll(reason: 'shutdown' | 'completed' | 'error' = 'shutdown'): void {
    for (const channelId of Array.from(this.resources.keys())) {
      this.clearInternal(channelId, reason);
    }
  }
}
