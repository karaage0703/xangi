/**
 * アプリケーション全体で使用する定数
 */

// Discord
export const DISCORD_MAX_LENGTH = 2000;
export const DISCORD_SPLIT_MARGIN = 100; // 分割時のマージン
export const DISCORD_SAFE_LENGTH = DISCORD_MAX_LENGTH - DISCORD_SPLIT_MARGIN; // 1900

// ストリーミング
export const STREAM_UPDATE_INTERVAL_MS = 1000;

/** 正の整数 env を読む。未設定 / 不正値はデフォルトを返す。 */
function envPositiveMs(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (!raw) return defaultMs;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

// タイムアウト
/** 初期タイムアウト (env TIMEOUT_MS、default 5 分) */
export const DEFAULT_TIMEOUT_MS = envPositiveMs('TIMEOUT_MS', 300_000);

/**
 * 動的延長で到達できる絶対上限 (env TIMEOUT_MAX_MS、default 1 時間)。
 * リクエスト開始時刻 + MAX_TIMEOUT_MS が上限 (累積ではなく絶対値)。
 * 数時間動かしっぱなしのタスク用に env で上書き可能。
 */
export const MAX_TIMEOUT_MS = envPositiveMs('TIMEOUT_MAX_MS', 60 * 60 * 1000);

/**
 * 延長機能の有効/無効 (env TIMEOUT_EXTEND_ENABLED、default true)。
 * false にすると extendTimeout が常に 'unsupported' を返し、UI のボタンも非表示になる。
 */
export const TIMEOUT_EXTEND_ENABLED =
  (process.env.TIMEOUT_EXTEND_ENABLED ?? 'true').toLowerCase() !== 'false';

/**
 * API で additionalMs を省略したときの fallback。
 * UI からは「残り時間を 2 倍」(extend で remainingMs を加算) で呼ぶため、
 * このデフォルト値は外部から `additionalMs` を明示しない HTTP 呼び出し用の保険。
 */
export const DEFAULT_TIMEOUT_EXTEND_MS = 5 * 60 * 1000; // 5分
