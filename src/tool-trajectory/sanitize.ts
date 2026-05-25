import { createHash } from 'crypto';
import { homedir } from 'os';

/**
 * tool-trajectory log の sanitize ヘルパ群。
 *
 * OSS 公開前提のため、log の中身が後で公開されても問題ない設計にする：
 * - secret 系 (token / apiKey / bearer 等) → 固定文字列に replace
 * - Discord channelId / userId / LINE userId → salt 付き hash (8 字)
 * - 絶対 path home prefix → `$HOME` に replace
 * - URL の secret-like query → redact
 * - 長文 args/result → 切り詰め
 *
 * すべて純粋関数で副作用無し。
 */

const SECRET_KEY_PATTERN =
  /(token|apikey|api_key|password|passwd|secret|bearer|cookie|authorization|auth_token|access_token|refresh_token|private_key|client_secret)/i;
const REDACTED = '[REDACTED_SECRET]';
const ID_HASH_PREFIX = 'h_';

/** SHA256 ベースのソルト付き ID hash (12 字)。生 ID を残さない用途。 */
export function hashId(value: string, salt: string): string {
  if (!value) return '';
  const h = createHash('sha256');
  h.update(salt);
  h.update(value);
  return ID_HASH_PREFIX + h.digest('hex').slice(0, 12);
}

/** ホームディレクトリ prefix を `$HOME` に置換。 */
export function maskHomePath(text: string, home: string = homedir()): string {
  if (!text || !home) return text;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'g'), '$HOME');
}

/** URL の secret-like query 値を redact (key 名で判定)。 */
export function maskUrlSecrets(text: string): string {
  return text.replace(/([?&])([a-zA-Z0-9_-]+)=([^&\s]+)/g, (_m, sep, key, _val) => {
    if (SECRET_KEY_PATTERN.test(key)) {
      return `${sep}${key}=${REDACTED}`;
    }
    return `${sep}${key}=${_val}`;
  });
}

/** 文字列を head/tail 方式で切り詰める。 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.4);
  const tail = Math.floor(maxChars * 0.4);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n... [${omitted} chars truncated] ...\n${text.slice(-tail)}`;
}

export interface SanitizeOptions {
  /** Discord channel / user / LINE userId hash 用 salt */
  salt: string;
  /** ホームディレクトリ。テスト時に上書きできるよう注入可能 */
  home?: string;
  /** args 切り詰め上限 (default 8KB) */
  maxArgsChars?: number;
  /** result 切り詰め上限 (default 16KB) */
  maxResultChars?: number;
  /** drift raw text 切り詰め上限 (default 2KB) */
  maxRawTextChars?: number;
}

/**
 * オブジェクト (args など) を再帰的に sanitize する。
 * - secret-like key の value は REDACTED に置換
 * - 文字列 value は maskHomePath + maskUrlSecrets を適用
 * - 配列・ネスト object も再帰
 *
 * 戻り値は元オブジェクトを変更しない (deep clone 結果)。
 */
export function sanitizeArgs(args: unknown, opts: SanitizeOptions): unknown {
  // 循環参照対応のため visited を WeakSet で持つ
  return walk(args, opts, new WeakSet());
}

function walk(value: unknown, opts: SanitizeOptions, visited: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return maskUrlSecrets(maskHomePath(value, opts.home));
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (visited.has(value)) return '[CIRCULAR]';
    visited.add(value);
    return value.map((v) => walk(v, opts, visited));
  }
  if (typeof value === 'object') {
    if (visited.has(value as object)) return '[CIRCULAR]';
    visited.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = walk(v, opts, visited);
      }
    }
    return out;
  }
  return value;
}

/** args 全体を sanitize + truncate して文字列化する (logger 内部用)。 */
export function sanitizeAndTruncateArgs(args: unknown, opts: SanitizeOptions): unknown {
  const sanitized = sanitizeArgs(args, opts);
  const json = JSON.stringify(sanitized);
  const max = opts.maxArgsChars ?? 8192;
  if (json.length <= max) return sanitized;
  return { __truncated__: true, head: json.slice(0, max), original_length: json.length };
}

/** tool 結果テキストを sanitize + truncate する。 */
export function sanitizeAndTruncateResult(text: string, opts: SanitizeOptions): string {
  const max = opts.maxResultChars ?? 16384;
  const masked = maskUrlSecrets(maskHomePath(text, opts.home));
  return truncate(masked, max);
}

/** drift rescue の raw_text_head を sanitize + truncate する (default 2KB)。 */
export function sanitizeAndTruncateRawText(text: string, opts: SanitizeOptions): string {
  const max = opts.maxRawTextChars ?? 2048;
  const masked = maskUrlSecrets(maskHomePath(text, opts.home));
  return truncate(masked, max);
}

/** signature 文字列を sanitize する (loop_detected の signature 用)。 */
export function sanitizeSignature(sig: string, opts: SanitizeOptions): string {
  const max = opts.maxArgsChars ?? 8192;
  const masked = maskUrlSecrets(maskHomePath(sig, opts.home));
  return truncate(masked, Math.min(max, 4096));
}
