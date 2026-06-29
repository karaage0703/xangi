import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  hashId,
  sanitizeAndTruncateArgs,
  sanitizeAndTruncateResult,
  sanitizeAndTruncateRawText,
  sanitizeSignature,
  type SanitizeOptions,
} from './sanitize.js';

/**
 * tool-trajectory 観測ログ。
 *
 * 既存 `transcript-logger` (`logs/sessions/<appSessionId>.jsonl`) とは独立して、
 * `logs/tool-trajectory/<appSessionId>.jsonl` に 1 event = 1 line の jsonl で
 * append する。
 *
 * 目的:
 * - Local LLM の tool 使用挙動を観察 (drift / loop / tool_search 採用ミス)
 * - 5+1 機構 (loop / 冪等キャッシュ / streaming hold buffer / pseudo tool_call rescue /
 *   context prune) の発火タイミングを構造化記録
 *
 * 設計:
 * - 全 event 共通 fields: ts / event_id / kind / schema_version / appSessionId /
 *   turn_index / seq / platform / backend / model / channelId_hash / round
 * - kind 別 fields は payload にぶら下げる
 * - 強制 sanitize: secret / Discord+LINE ID (hash) / home path / URL secret
 * - fail-safe: jsonl 書き込み失敗で runner を落とさない (console.warn のみ)
 * - 無効時 (env で OFF) は完全 no-op
 *
 * 既存 transcript-logger は一切変更しない。session restore は従来通り
 * `logs/sessions/*.jsonl` のみを見るので互換性は完全に維持される。
 */

export const TRAJECTORY_SCHEMA_VERSION = 1;

export type TrajectoryKind =
  'session_start' | 'tool_call' | 'tool_search' | 'drift_rescue' | 'loop_detected' | 'runner_event';

export interface TrajectoryCommon {
  appSessionId: string;
  platform?: string;
  backend?: string;
  model?: string;
  channelId?: string;
  turnIndex?: number;
  round?: number;
}

export interface SessionStartPayload {
  baseUrl?: string;
  features?: string[];
  logger?: {
    enabled: boolean;
    sanitize_version: number;
    retention_days?: number;
    size_cap_mb?: number;
  };
}

export interface ToolCallPayload {
  tool_call_id?: string;
  tool_name: string;
  args: unknown;
  result?: string;
  error?: string;
  duration_ms: number;
  status: 'success' | 'error';
  parent_tool_call_id?: string;
}

export interface ToolSearchPayload {
  query: string;
  candidates: Array<{ name: string; type: 'tool' | 'skill'; score: number }>;
  activated_tools: string[];
  activated_skills?: string[];
}

export type DriftSafetyVerdict =
  'safe' | 'unsafe' | 'unparseable' | 'already_executed' | 'loop_blocked' | 'dropped_empty';

export interface DriftRescuePayload {
  raw_text_head: string;
  parsed_name?: string;
  parsed_args?: unknown;
  safety_verdict: DriftSafetyVerdict;
  executed: boolean;
  failure_reason?: string;
}

export type LoopKindEvent = 'exact' | 'similar' | 'idempotent_cache_hit';

export interface LoopDetectedPayload {
  loop_kind: LoopKindEvent;
  signature: string;
  tool_name?: string;
  action: 'blocked' | 'cached' | 'warned';
  repeats?: number;
}

export interface RunnerEventPayload {
  event:
    | 'streaming_hold_buffer_drop'
    | 'context_prune'
    | 'session_retry'
    | 'idempotent_cache_store'
    | 'stop_hook_block';
  details?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** ワークディレクトリ (logs/tool-trajectory/ がこの下にできる) */
  workdir: string;
  /** ロガー有効/無効 (env XANGI_TOOL_TRAJECTORY_LOG=false で OFF) */
  enabled: boolean;
  /** Discord/LINE ID hash 用 salt */
  hashSalt: string;
  /** args 切り詰め上限 (default 8KB) */
  maxArgsChars?: number;
  /** result 切り詰め上限 (default 16KB) */
  maxResultChars?: number;
  /** drift raw_text 切り詰め上限 (default 2KB) */
  maxRawTextChars?: number;
  /** TTL 日数。未指定なら削除しない (default)。指定時のみ古いファイルを削除する */
  retentionDays?: number;
  /** logs/tool-trajectory 全体のサイズ上限 MB。未指定なら上限なし (default) */
  sizeCapMb?: number;
}

const TRAJECTORY_DIR = 'logs/tool-trajectory';

export class ToolTrajectoryLogger {
  readonly enabled: boolean;
  private readonly workdir: string;
  private readonly seqCounters = new Map<string, number>();
  private readonly sanitizeOpts: SanitizeOptions;
  /** undefined ならファイル削除を一切しない (default)。env で明示指定された時のみ TTL 適用 */
  private readonly retentionDays?: number;
  /** undefined ならサイズ上限なし (default)。env で明示指定された時のみ size cap 適用 */
  private readonly sizeCapBytes?: number;

  constructor(opts: LoggerOptions) {
    this.enabled = opts.enabled;
    this.workdir = opts.workdir;
    this.sanitizeOpts = {
      salt: opts.hashSalt,
      maxArgsChars: opts.maxArgsChars,
      maxResultChars: opts.maxResultChars,
      maxRawTextChars: opts.maxRawTextChars,
    };
    this.retentionDays = opts.retentionDays;
    this.sizeCapBytes = opts.sizeCapMb !== undefined ? opts.sizeCapMb * 1024 * 1024 : undefined;
  }

  /** appSessionId → ファイル絶対パス */
  private filePath(appSessionId: string): string {
    return join(this.workdir, TRAJECTORY_DIR, `${appSessionId}.jsonl`);
  }

  /** appSessionId 用の seq を払い出す (0 始まり、+1 ずつ) */
  private nextSeq(appSessionId: string): number {
    const cur = this.seqCounters.get(appSessionId) ?? 0;
    this.seqCounters.set(appSessionId, cur + 1);
    return cur;
  }

  /** appSessionId の seq counter をリセット (session_start で呼ぶ) */
  resetSeq(appSessionId: string): void {
    this.seqCounters.set(appSessionId, 0);
  }

  private writeEvent(
    kind: TrajectoryKind,
    common: TrajectoryCommon,
    payload: Record<string, unknown>
  ): void {
    if (!this.enabled) return;
    try {
      const dir = join(this.workdir, TRAJECTORY_DIR);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const entry = {
        ts: new Date().toISOString(),
        event_id: randomUUID(),
        kind,
        schema_version: TRAJECTORY_SCHEMA_VERSION,
        appSessionId: common.appSessionId,
        seq: this.nextSeq(common.appSessionId),
        turn_index: common.turnIndex,
        round: common.round,
        platform: common.platform,
        backend: common.backend,
        model: common.model,
        channelId_hash: common.channelId
          ? hashId(common.channelId, this.sanitizeOpts.salt)
          : undefined,
        ...payload,
      };
      const line = JSON.stringify(entry);
      appendFileSync(this.filePath(common.appSessionId), line + '\n');
    } catch (err) {
      // fail-safe: ロガー失敗で runner を落とさない
      console.warn(
        `[tool-trajectory] Failed to write ${kind} event: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  logSessionStart(common: TrajectoryCommon, payload: SessionStartPayload): void {
    if (!this.enabled) return;
    this.resetSeq(common.appSessionId);
    this.writeEvent('session_start', common, {
      baseUrl_sanitized: payload.baseUrl ? this.maskUrl(payload.baseUrl) : undefined,
      features: payload.features,
      logger: payload.logger,
    });
  }

  logToolCall(common: TrajectoryCommon, payload: ToolCallPayload): void {
    if (!this.enabled) return;
    this.writeEvent('tool_call', common, {
      tool_call_id: payload.tool_call_id,
      tool_name: payload.tool_name,
      args_sanitized: sanitizeAndTruncateArgs(payload.args, this.sanitizeOpts),
      result_truncated:
        payload.result !== undefined
          ? sanitizeAndTruncateResult(payload.result, this.sanitizeOpts)
          : undefined,
      error_truncated:
        payload.error !== undefined
          ? sanitizeAndTruncateResult(payload.error, this.sanitizeOpts)
          : undefined,
      duration_ms: payload.duration_ms,
      status: payload.status,
      parent_tool_call_id: payload.parent_tool_call_id,
    });
  }

  logToolSearch(common: TrajectoryCommon, payload: ToolSearchPayload): void {
    if (!this.enabled) return;
    this.writeEvent('tool_search', common, {
      query_sanitized: sanitizeAndTruncateRawText(payload.query, this.sanitizeOpts),
      candidates: payload.candidates,
      activated_tools: payload.activated_tools,
      activated_skills: payload.activated_skills,
    });
  }

  logDriftRescue(common: TrajectoryCommon, payload: DriftRescuePayload): void {
    if (!this.enabled) return;
    this.writeEvent('drift_rescue', common, {
      raw_text_head_sanitized: sanitizeAndTruncateRawText(payload.raw_text_head, this.sanitizeOpts),
      parsed_name: payload.parsed_name,
      parsed_args_sanitized:
        payload.parsed_args !== undefined
          ? sanitizeAndTruncateArgs(payload.parsed_args, this.sanitizeOpts)
          : undefined,
      safety_verdict: payload.safety_verdict,
      executed: payload.executed,
      failure_reason: payload.failure_reason,
    });
  }

  logLoopDetected(common: TrajectoryCommon, payload: LoopDetectedPayload): void {
    if (!this.enabled) return;
    this.writeEvent('loop_detected', common, {
      loop_kind: payload.loop_kind,
      signature_sanitized: sanitizeSignature(payload.signature, this.sanitizeOpts),
      tool_name: payload.tool_name,
      action: payload.action,
      repeats: payload.repeats,
    });
  }

  logRunnerEvent(common: TrajectoryCommon, payload: RunnerEventPayload): void {
    if (!this.enabled) return;
    this.writeEvent('runner_event', common, {
      event: payload.event,
      details: payload.details,
    });
  }

  /**
   * 起動時 prune: TTL 超過 + 全体サイズ上限を超えた古いファイルを削除する。
   * 1 PR 目はシンプルに mtime 基準の単純削除のみ。
   *
   * default では retention/size cap いずれも無効 (env で明示指定された時のみ動作)。
   * 観察データを残す前提で、勝手に消さないのを default にしている。
   * 容量が気になる場合のみ env で TTL や size cap を設定する。
   *
   * @returns 削除したファイル数と解放した bytes
   */
  prune(): { removed: number; freedBytes: number } {
    if (!this.enabled) return { removed: 0, freedBytes: 0 };
    // どちらの上限も未設定なら早期 return (default: 削除しない)
    if (this.retentionDays === undefined && this.sizeCapBytes === undefined) {
      return { removed: 0, freedBytes: 0 };
    }
    const dir = join(this.workdir, TRAJECTORY_DIR);
    if (!existsSync(dir)) return { removed: 0, freedBytes: 0 };

    let removed = 0;
    let freedBytes = 0;
    let files: Array<{ name: string; path: string; size: number; mtimeMs: number }> = [];
    try {
      files = readdirSync(dir)
        .filter((n) => n.endsWith('.jsonl'))
        .map((n) => {
          const p = join(dir, n);
          const s = statSync(p);
          return { name: n, path: p, size: s.size, mtimeMs: s.mtimeMs };
        });
    } catch (err) {
      console.warn(
        `[tool-trajectory] prune: readdir failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return { removed: 0, freedBytes: 0 };
    }

    // 1. TTL 超過削除 (retentionDays 設定時のみ)
    const kept: typeof files = [];
    if (this.retentionDays !== undefined && this.retentionDays > 0) {
      const ttlMs = this.retentionDays * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - ttlMs;
      for (const f of files) {
        if (f.mtimeMs < cutoff) {
          try {
            unlinkSync(f.path);
            removed += 1;
            freedBytes += f.size;
          } catch (err) {
            console.warn(
              `[tool-trajectory] prune: unlink failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        } else {
          kept.push(f);
        }
      }
    } else {
      kept.push(...files);
    }

    // 2. size cap 超過削除 (sizeCapBytes 設定時のみ)
    if (this.sizeCapBytes !== undefined) {
      let totalSize = kept.reduce((acc, f) => acc + f.size, 0);
      if (totalSize > this.sizeCapBytes) {
        kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const f of kept) {
          if (totalSize <= this.sizeCapBytes) break;
          try {
            unlinkSync(f.path);
            removed += 1;
            freedBytes += f.size;
            totalSize -= f.size;
          } catch (err) {
            console.warn(
              `[tool-trajectory] prune: unlink failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }

    return { removed, freedBytes };
  }

  /** baseUrl から secret-like query を redact する小さな helper */
  private maskUrl(url: string): string {
    try {
      const u = new URL(url);
      // path までを返し、 query は捨てる (baseUrl 用途では query は不要)
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return url;
    }
  }
}

/** ロガー設定を環境変数から組み立てる helper。 */
export function loggerOptionsFromEnv(
  workdir: string,
  env: NodeJS.ProcessEnv = process.env
): LoggerOptions {
  const enabled = env.XANGI_TOOL_TRAJECTORY_LOG !== 'false';
  // 永続 salt が未指定なら起動毎にランダム生成 (同セッション内で同 ID は同 hash になる)
  // 本番運用で「日跨ぎでも同 ID 相関を追いたい」場合は env で固定値を指定する
  const hashSalt = env.TOOL_TRAJECTORY_LOG_HASH_SALT || randomUUID().replace(/-/g, '').slice(0, 16);
  const maxResultChars = env.TOOL_TRAJECTORY_LOG_MAX_RESULT_CHARS
    ? parseInt(env.TOOL_TRAJECTORY_LOG_MAX_RESULT_CHARS, 10)
    : undefined;
  const maxArgsChars = env.TOOL_TRAJECTORY_LOG_MAX_ARGS_CHARS
    ? parseInt(env.TOOL_TRAJECTORY_LOG_MAX_ARGS_CHARS, 10)
    : undefined;
  const retentionDays = env.TOOL_TRAJECTORY_LOG_RETENTION_DAYS
    ? parseInt(env.TOOL_TRAJECTORY_LOG_RETENTION_DAYS, 10)
    : undefined;
  const sizeCapMb = env.TOOL_TRAJECTORY_LOG_SIZE_CAP_MB
    ? parseInt(env.TOOL_TRAJECTORY_LOG_SIZE_CAP_MB, 10)
    : undefined;

  return {
    workdir,
    enabled,
    hashSalt,
    maxArgsChars,
    maxResultChars,
    retentionDays,
    sizeCapMb,
  };
}
