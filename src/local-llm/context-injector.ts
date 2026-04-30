/**
 * izuna-workspace の context_provider.py を呼び出して
 * live state をシステムプロンプトに注入する。
 * 長期記憶は RLM-lite 方針で ACTION:memory_recall に寄せる。
 *
 * - 60秒キャッシュ（毎メッセージで呼ばない）
 * - 失敗時は空文字を返す（graceful degradation）
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const IZUNA_WORKSPACE = join(process.env.HOME || '/Users/suguru', 'projects', 'izuna-workspace');
const CONTEXT_PROVIDER_SCRIPT = join(IZUNA_WORKSPACE, 'scripts', 'context_provider.py');
/** izuna venv python (duckdb/pyarrow 等が入っている専用環境) */
const IZUNA_PYTHON = join(process.env.HOME || '/Users/suguru', 'venvs', 'izuna', 'bin', 'python3');

/** キャッシュ有効期間（ミリ秒） */
const CACHE_TTL_MS = 60_000;

/** context_provider.py のトークン上限。RLM-lite では live state 中心に使う */
const MAX_TOKENS = 3500;

/** RLM-lite context mode. 長期記憶の大量注入を避け、memory_recall を使わせる。 */
const RLM_LITE_CONTEXT = process.env.IZUNA_CONTEXT_MODE !== 'full';

/** 直近会話ターン数（システムプロンプトには少なめで十分） */
const RECENT_TURNS = 3;

/** 実行タイムアウト（ミリ秒） */
const EXEC_TIMEOUT_MS = 30_000;

let cachedContext: string = '';
let cachedAt: number = 0;
let inflightRefresh: Promise<void> | null = null;
let inflightInitial: Promise<string> | null = null;

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as NodeJS.ErrnoException & { signal?: string; killed?: boolean; stderr?: string };
  const headline = e.message.split('\n')[0];
  const parts = [headline];
  if (e.code !== undefined) parts.push(`code=${e.code}`);
  if (e.signal) parts.push(`signal=${e.signal}`);
  if (e.killed) parts.push(`killed=true`);
  if (e.stderr) parts.push(`stderr=${JSON.stringify(e.stderr.trim())}`);
  return parts.join(' ');
}

function triggerBackgroundRefresh(): void {
  if (inflightRefresh) return;
  inflightRefresh = (async () => {
    const started = Date.now();
    try {
      const result = await runContextProvider();
      cachedContext = result;
      cachedAt = Date.now();
      console.log(
        `[context-injector] bg refresh ok (${result.length} chars, ${Date.now() - started}ms)`
      );
    } catch (err) {
      const msg = describeError(err);
      const age = cachedContext ? Math.round((Date.now() - cachedAt) / 1000) : -1;
      console.warn(
        `[context-injector] bg refresh failed: ${msg} (keep prev: ${cachedContext ? `${age}s old, ${cachedContext.length} chars` : 'empty'})`
      );
    } finally {
      inflightRefresh = null;
    }
  })();
}

/**
 * izuna-workspace の context_provider.py からコンテキストを取得する。
 * - 初回のみブロック（キャッシュ空のとき）
 * - それ以降はキャッシュを即時返し、TTL 超過ならバックグラウンドで更新
 * - 更新失敗時も prev cache を返し続ける（cold spawn が 1分超で固まる環境への対策）
 */
export async function getIzunaContext(): Promise<string> {
  const now = Date.now();

  if (!existsSync(CONTEXT_PROVIDER_SCRIPT)) {
    console.warn(`[context-injector] context_provider.py not found: ${CONTEXT_PROVIDER_SCRIPT}`);
    return '';
  }

  if (cachedContext) {
    if (now - cachedAt >= CACHE_TTL_MS) {
      triggerBackgroundRefresh();
    }
    return cachedContext;
  }

  // 初回のみブロック (concurrent 呼び出しは同じ promise を共有)
  if (inflightInitial) {
    return inflightInitial;
  }
  inflightInitial = (async () => {
    const started = Date.now();
    try {
      const result = await runContextProvider();
      cachedContext = result;
      cachedAt = Date.now();
      console.log(
        `[context-injector] initial load ok (${result.length} chars, ${Date.now() - started}ms)`
      );
      return result;
    } catch (err) {
      const msg = describeError(err);
      console.warn(
        `[context-injector] initial load failed: ${msg} (${Date.now() - started}ms, fallback: empty)`
      );
      return '';
    } finally {
      inflightInitial = null;
    }
  })();
  return inflightInitial;
}

/**
 * channel ごとの直近会話 (session.db) を整形して返す。
 * オーケストレーターチャンネル (#一般) 等で「前の発言が通じない場合」に参照できるよう
 * system prompt に入れる。
 *
 * - 30秒キャッシュ (channel 別)
 * - 失敗時は空文字
 */
const RECENT_CONV_SCRIPT = join(IZUNA_WORKSPACE, 'scripts', 'recent_conversation.py');
const RECENT_CACHE_TTL_MS = 30_000;
const RECENT_MINUTES = 30;
const RECENT_LIMIT = 20;
interface RecentCacheEntry {
  text: string;
  cachedAt: number;
}
const recentCache = new Map<string, RecentCacheEntry>();

export async function getRecentConversation(channelId: string, channelLabel = ''): Promise<string> {
  if (!channelId) return '';
  const now = Date.now();
  const cached = recentCache.get(channelId);
  if (cached && now - cached.cachedAt < RECENT_CACHE_TTL_MS) {
    return cached.text;
  }
  if (!existsSync(RECENT_CONV_SCRIPT)) return '';
  const pythonBin = existsSync(IZUNA_PYTHON) ? IZUNA_PYTHON : 'python3';

  return new Promise<string>((resolve) => {
    execFile(
      pythonBin,
      [
        RECENT_CONV_SCRIPT,
        '--channel-id',
        channelId,
        '--channel-label',
        channelLabel,
        '--minutes',
        String(RECENT_MINUTES),
        '--limit',
        String(RECENT_LIMIT),
      ],
      {
        timeout: 5_000,
        cwd: IZUNA_WORKSPACE,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      },
      (err, stdout) => {
        if (err) {
          resolve(cached?.text ?? '');
          return;
        }
        const text = stdout.trim();
        recentCache.set(channelId, { text, cachedAt: Date.now() });
        resolve(text);
      }
    );
  });
}

function runContextProvider(): Promise<string> {
  // izuna venv があればそちらを使う (duckdb/pyarrow が必要なため)
  const pythonBin = existsSync(IZUNA_PYTHON) ? IZUNA_PYTHON : 'python3';
  const args = [
    CONTEXT_PROVIDER_SCRIPT,
    '--max-tokens',
    String(MAX_TOKENS),
    '--recent-turns',
    String(RECENT_TURNS),
  ];
  if (RLM_LITE_CONTEXT) {
    args.push('--rlm-lite');
  }
  return new Promise((resolve, reject) => {
    execFile(
      pythonBin,
      args,
      {
        timeout: EXEC_TIMEOUT_MS,
        cwd: IZUNA_WORKSPACE,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as NodeJS.ErrnoException & { stderr?: string };
          if (stderr) e.stderr = stderr.slice(-800);
          reject(error);
          return;
        }
        const text = stdout.trim();
        if (!text) {
          resolve('');
          return;
        }
        resolve(text);
      }
    );
  });
}
