import { isAntigravityWorkspaceArtifactPathError } from './antigravity-output.js';

/**
 * クライアント入力に起因するエラー（パラメータ不足・バリデーション失敗など）。
 * tool-server側でこの型を投げると HTTP 400 で返る。それ以外は 500（サーバー内部エラー）。
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** A model request has its own budget, distinct from the enclosing turn. */
export class LlmTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly streaming: boolean
  ) {
    super(`LLM ${streaming ? 'stream idle' : 'request'} timed out after ${timeoutMs}ms`);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * The operation failed after side effects may already have completed, so
 * retrying the enclosing task could duplicate externally visible work.
 */
export class NonRetryableError extends Error {
  readonly retryable = false;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

/** CLI exited without confirming completion; side effects may already exist. */
export class IncompleteAgentTurnError extends NonRetryableError {
  constructor(
    public readonly backend: string,
    public readonly sessionId?: string
  ) {
    super(`${backend} exited without turn.completed; completion is unconfirmed`);
    this.name = 'IncompleteAgentTurnError';
  }
}

export function isNonRetryableError(error: unknown): error is NonRetryableError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { retryable?: unknown }).retryable === false
  );
}

/**
 * エージェント実行エラーの分類。
 * ランナー (CLI / Local LLM) から上がってくるエラーメッセージを種類別に判別し、
 * ユーザー向け表示・リトライ判断（エラー後フォローアップの可否など）を
 * プラットフォーム間で統一するために使う。
 */
export type AgentErrorKind =
  | 'cancelled' // ユーザーによる Stop / cancel
  | 'timeout' // リクエストタイムアウト（プロセス kill 済み）
  | 'crash' // AI プロセスの予期しない終了
  | 'circuit-breaker' // 連続クラッシュによる一時停止
  | 'usage-limit' // バックエンドの利用枠・支出予算の上限到達
  | 'antigravity-artifact-path' // Agy が通常ファイルを内部 artifact と誤分類
  | 'incomplete-turn' // Process exited without the backend's completion event
  | 'unknown';

const CANCEL_MESSAGE = 'Request cancelled by user';

/** エラーメッセージから種類を判別する */
export function classifyAgentError(error: unknown): AgentErrorKind {
  const msg = error instanceof Error ? error.message : String(error);
  if (error instanceof IncompleteAgentTurnError) return 'incomplete-turn';
  if (msg === CANCEL_MESSAGE) return 'cancelled';
  if (isAntigravityWorkspaceArtifactPathError(error)) return 'antigravity-artifact-path';
  if (msg.includes('timed out')) return 'timeout';
  if (msg.includes('Process exited unexpectedly')) return 'crash';
  if (msg.includes('Circuit breaker')) return 'circuit-breaker';
  if (/usage limit|hit your [^·\r\n]*?(?:limit|budget)\b/i.test(msg)) return 'usage-limit';
  return 'unknown';
}

/**
 * エージェント実行エラーをユーザー向けの一行メッセージに整形する。
 * Discord / Slack / scheduler 等の表示で共通に使う。
 */
export function formatAgentErrorForUser(error: unknown, opts?: { timeoutMs?: number }): string {
  const msg = error instanceof Error ? error.message : String(error);
  const detail = msg.slice(0, 200);
  switch (classifyAgentError(error)) {
    case 'cancelled':
      return '🛑 タスクを停止しました';
    case 'timeout':
      if (error instanceof LlmTimeoutError) {
        return `⏱️ LLM${error.streaming ? '受信待ち' : '応答待ち'}がタイムアウトしました（${Math.round(error.timeoutMs / 1000)}秒）`;
      }
      return opts?.timeoutMs
        ? `⏱️ タイムアウトしました（${Math.round(opts.timeoutMs / 1000)}秒）`
        : '⏱️ タイムアウトしました';
    case 'crash':
      return `💥 AIプロセスが予期せず終了しました: ${detail}`;
    case 'circuit-breaker':
      return '🔌 AIプロセスが連続でクラッシュしたため一時停止中です。しばらくしてから再試行してください';
    case 'usage-limit':
      return `💳 バックエンドの利用上限に達しています: ${detail}`;
    case 'antigravity-artifact-path':
      return '❌ Agyがワークスペースへの書き込みを内部artifactと誤判定しました。自動回復にも失敗したため、もう一度お試しください';
    case 'incomplete-turn':
      return '⚠️ AIの完了通知を受け取れないまま処理が終了しました。作業が一部実行された可能性があります。自動再実行はしていません。続ける前に変更・送信済みの内容を確認してください。';
    case 'unknown':
    default:
      return `❌ エラーが発生しました: ${detail}`;
  }
}

/**
 * 一時的なネットワーク起因のエラーか（リトライで回復する見込みがあるもの）。
 * scheduler のジョブ実行リトライ判断などに使う。
 * DNS 一時失敗 (EAI_AGAIN) / 接続タイムアウト / 接続リセット / fetch 失敗系を対象とし、
 * エージェント実行のタイムアウトや利用上限はリトライ対象にしない。
 */
export function isTransientNetworkError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const parts: string[] = [];

  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);

    if (typeof current !== 'object') {
      parts.push(String(current));
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const field of ['message', 'code', 'errno']) {
      if (record[field] !== undefined) parts.push(String(record[field]));
    }
    if (record.cause !== undefined) pending.push(record.cause);
    if (record.error !== undefined) pending.push(record.error);
    if (record.original !== undefined) pending.push(record.original);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }

  return /EAI_AGAIN|ENOTFOUND|ENETDOWN|ENETRESET|ENETUNREACH|EHOSTDOWN|EHOSTUNREACH|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|ConnectTimeoutError|Connect Timeout|fetch failed|socket hang up/i.test(
    parts.join(' ')
  );
}

/**
 * Error.cause を含む通信エラーの診断情報を、ログへ残せる短い文字列にする。
 * Node.js の fetch は最上位を `TypeError: fetch failed` に丸めるため、cause 側の
 * code / errno / address / port を残さないと接続拒否・reset・DNS失敗を区別できない。
 */
export function formatErrorDiagnostic(error: unknown): string {
  const pending: Array<{ value: unknown; label: string }> = [{ value: error, label: 'error' }];
  const seen = new Set<unknown>();
  const entries: string[] = [];

  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (!current || current.value === undefined || current.value === null) continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);

    if (typeof current.value !== 'object') {
      entries.push(
        `${current.label}=${String(current.value)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 300)}`
      );
      continue;
    }

    const record = current.value as Record<string, unknown>;
    const fields: string[] = [];
    for (const field of [
      'name',
      'message',
      'code',
      'errno',
      'syscall',
      'address',
      'port',
      'status',
      'code_kind',
      'error_code',
      'retryable',
      'error_id',
    ]) {
      const value = record[field];
      if (value === undefined || value === null || value === '') continue;
      fields.push(
        `${field}=${String(value)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 300)}`
      );
    }
    if (fields.length > 0) entries.push(`${current.label}(${fields.join(', ')})`);

    if (record.cause !== undefined) pending.push({ value: record.cause, label: 'cause' });
    if (record.error !== undefined) pending.push({ value: record.error, label: 'nested_error' });
    if (record.original !== undefined) {
      pending.push({ value: record.original, label: 'original' });
    }
    const providerDiagnostic = record.providerDiagnostic;
    if (providerDiagnostic && typeof providerDiagnostic === 'object') {
      for (const [provider, value] of Object.entries(providerDiagnostic)) {
        pending.push({ value, label: `providerDiagnostic.${provider}` });
      }
    }
    if (Array.isArray(record.errors)) {
      record.errors.forEach((value, index) => pending.push({ value, label: `errors[${index}]` }));
    }
  }

  return entries.join(' <- ').slice(0, 1200) || 'unknown error';
}
