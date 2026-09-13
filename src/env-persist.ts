import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * .env ファイルのパスを解決する。
 *
 * 優先順位:
 * 1. `XANGI_ENV_PATH` 環境変数 (明示的な指定)
 * 2. `process.cwd() + '/.env'` (デフォルト)
 *
 * Docker 環境では env vars は `env_file` ディレクティブで注入されるが、
 * `.env` ファイル自体は `/app/.env` に存在しないことが多い。永続化を有効に
 * したい場合は `XANGI_ENV_PATH=/workspace/.env` のように volume mount された
 * path を指定する。
 */
export function resolveEnvFilePath(): string {
  return process.env.XANGI_ENV_PATH || join(process.cwd(), '.env');
}

/** `.env` 更新結果 */
export interface UpdateEnvResult {
  ok: boolean;
  /** 解決された .env パス (デバッグ表示用) */
  envPath: string;
  /** 失敗理由 (ok=false の場合のみ) */
  reason?: string;
}

/** Multiple `.env` values updated in one read/write cycle. `undefined` removes the key. */
export function updateEnvKeyValues(updates: Record<string, string | undefined>): UpdateEnvResult {
  const envPath = resolveEnvFilePath();

  for (const [key, value] of Object.entries(updates)) {
    if (/[\r\n]/.test(key) || (value !== undefined && /[\r\n]/.test(value))) {
      return { ok: false, envPath, reason: 'Environment keys and values must be single-line' };
    }
  }

  let content: string;
  try {
    content = readFileSync(envPath, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      ok: false,
      envPath,
      reason:
        code === 'ENOENT'
          ? `.env file not found at ${envPath} (set XANGI_ENV_PATH or mount a writable .env to enable persistence)`
          : `Failed to read ${envPath}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${escapeRegExp(key)}=.*(?:\\n|$)`, 'm');
    if (value === undefined) {
      content = content.replace(pattern, '');
    } else {
      const newLine = `${key}=${value}\n`;
      content = pattern.test(content)
        ? content.replace(pattern, newLine)
        : `${content.trimEnd()}\n${newLine}`;
    }
  }

  try {
    writeFileSync(envPath, content, 'utf-8');
    return { ok: true, envPath };
  } catch (e) {
    return {
      ok: false,
      envPath,
      reason: `Failed to write ${envPath}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * `.env` ファイルの 1 行 (`KEY=VALUE`) を更新する。
 * 既存行があれば置換、なければ末尾に追加。
 *
 * ファイル不在の場合は graceful に skip し warning を返す。bot の動作は
 * 続行する (設定はメモリに反映済の前提)。Docker 環境等で `.env` が
 * `/app/.env` に存在しないケースでも例外を投げない。
 */
export function updateEnvKeyValue(key: string, value: string): UpdateEnvResult {
  const envPath = resolveEnvFilePath();

  let content: string;
  try {
    content = readFileSync(envPath, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        envPath,
        reason: `.env file not found at ${envPath} (set XANGI_ENV_PATH or mount a writable .env to enable persistence)`,
      };
    }
    return {
      ok: false,
      envPath,
      reason: `Failed to read ${envPath}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const newLine = `${key}=${value}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
  const updated = pattern.test(content)
    ? content.replace(pattern, newLine)
    : content.trimEnd() + '\n' + newLine + '\n';

  try {
    writeFileSync(envPath, updated, 'utf-8');
    return { ok: true, envPath };
  } catch (e) {
    return {
      ok: false,
      envPath,
      reason: `Failed to write ${envPath}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
