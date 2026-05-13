/**
 * Runtime context (cwd / repo) を毎ターンプロンプトに注入するユーティリティ。
 *
 * Bash tool の cwd 持続はメッセージ受信を跨いで保証されないため、各ターンで
 * 「いま観測されている cwd」をプロンプトに差し込み、AI が借りリポと本体リポを
 * 取り違えて push する事故を構造的に減らす。
 *
 * - cwd: `process.cwd()` の同期取得
 * - repo: `git rev-parse --show-toplevel` + `git branch --show-current`
 *   （5 秒キャッシュ）
 *
 * 出力フォーマット (1 行):
 *   `[runtime] cwd=/path/to/dir repo=name@branch`
 *
 * 環境変数:
 * - `XANGI_RUNTIME_CONTEXT_ENABLED` (default: true)
 *   `false` / `0` / `no` / `off` (case-insensitive) で注入をオフにできる。
 */
import { execFileSync } from 'child_process';
import { basename } from 'path';

export interface RuntimeContext {
  cwd: string;
  repo?: { root: string; name: string; branch: string };
}

/** 同一 cwd に対する git 情報の短期キャッシュ。 */
interface RepoCacheEntry {
  cwd: string;
  expiresAt: number;
  value: RuntimeContext['repo'];
}

const REPO_CACHE_TTL_MS = 5_000;
let repoCache: RepoCacheEntry | null = null;

/** runtime context を取得する（同期、テストでも安定）。 */
export function getRuntimeContext(): RuntimeContext {
  const cwd = safeCwd();
  return {
    cwd,
    repo: getRepoInfo(cwd),
  };
}

/**
 * `XANGI_RUNTIME_CONTEXT_ENABLED` を読んで注入を有効にするか判定。
 * 未設定または `true` / `1` で有効、`false` / `0` で無効。
 */
function isEnabled(): boolean {
  const v = process.env.XANGI_RUNTIME_CONTEXT_ENABLED;
  if (v === undefined) return true;
  const lower = v.trim().toLowerCase();
  return lower !== 'false' && lower !== '0' && lower !== 'no' && lower !== 'off';
}

/**
 * プロンプト先頭に prepend する 1 行ブロックを返す。
 * 環境変数で無効化されている場合や、context 取得に失敗した場合は空文字列を返す。
 */
export function buildRuntimeContextBlock(): string {
  if (!isEnabled()) return '';

  let ctx: RuntimeContext;
  try {
    ctx = getRuntimeContext();
  } catch {
    return '';
  }

  const parts: string[] = [];
  parts.push(`cwd=${ctx.cwd}`);
  if (ctx.repo) {
    parts.push(`repo=${ctx.repo.name}@${ctx.repo.branch}`);
  }

  return `[runtime] ${parts.join(' ')}\n\n`;
}

/** prompt 先頭に runtime context ブロックを差し込む。空文字列なら何もしない。 */
export function prependRuntimeContext(prompt: string): string {
  const block = buildRuntimeContextBlock();
  if (!block) return prompt;
  return block + prompt;
}

/** テスト用にキャッシュをリセット。 */
export function _resetRuntimeContextCache(): void {
  repoCache = null;
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '<unknown>';
  }
}

function getRepoInfo(cwd: string): RuntimeContext['repo'] {
  const now = Date.now();
  if (repoCache && repoCache.cwd === cwd && repoCache.expiresAt > now) {
    return repoCache.value;
  }

  let value: RuntimeContext['repo'];
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    })
      .toString()
      .trim();

    let branch = '';
    try {
      branch = execFileSync('git', ['branch', '--show-current'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      })
        .toString()
        .trim();
    } catch {
      // detached HEAD 等で取れなくても repo 表示は続ける
    }

    if (!branch) branch = '(detached)';

    value = { root, name: basename(root), branch };
  } catch {
    value = undefined;
  }

  repoCache = { cwd, expiresAt: now + REPO_CACHE_TTL_MS, value };
  return value;
}
