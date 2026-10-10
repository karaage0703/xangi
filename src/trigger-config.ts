/** 実行処理とプロンプトで共有するトリガー設定。 */
export function isTriggerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.TRIGGER_ENABLED?.trim();
  return value === undefined || value === '' || value === 'true';
}

export interface TriggerConfig {
  /** 機能全体の有効化（TRIGGER_ENABLED、デフォルト true。falseで無効化） */
  enabled: boolean;
  /** Bearer 認証トークン（XANGI_TRIGGER_TOKEN）。未設定なら HTTP 経由は全拒否 */
  token?: string;
  /** 同一 source の最短発火間隔 ms（TRIGGER_MIN_INTERVAL_MS、デフォルト 10000） */
  minIntervalMs: number;
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
    enabled: isTriggerEnabled(env),
    token: env.XANGI_TRIGGER_TOKEN || undefined,
    minIntervalMs: Number.isFinite(parsedInterval) && parsedInterval >= 0 ? parsedInterval : 10_000,
  };
}
