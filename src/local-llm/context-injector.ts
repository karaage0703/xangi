/**
 * izuna-workspace の context_provider.py を呼び出して
 * L1メモリ・タスク・MEMORY.md の内容をシステムプロンプトに注入する。
 *
 * - 60秒キャッシュ（毎メッセージで呼ばない）
 * - 失敗時は空文字を返す（graceful degradation）
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const IZUNA_WORKSPACE = join(process.env.HOME || '/Users/suguru', 'projects', 'izuna-workspace');
const CONTEXT_PROVIDER_SCRIPT = join(IZUNA_WORKSPACE, 'scripts', 'context_provider.py');

/** キャッシュ有効期間（ミリ秒） */
const CACHE_TTL_MS = 60_000;

/** context_provider.py のトークン上限（コンパクトに保つ） */
const MAX_TOKENS = 800;

/** 直近会話ターン数（システムプロンプトには少なめで十分） */
const RECENT_TURNS = 3;

/** 実行タイムアウト（ミリ秒） */
const EXEC_TIMEOUT_MS = 10_000;

let cachedContext: string = '';
let cachedAt: number = 0;

/**
 * izuna-workspace の context_provider.py からコンテキストを取得する。
 * 60秒以内に再呼び出しされた場合はキャッシュを返す。
 * 失敗時は空文字を返す。
 */
export async function getIzunaContext(): Promise<string> {
  const now = Date.now();
  if (cachedContext && now - cachedAt < CACHE_TTL_MS) {
    return cachedContext;
  }

  if (!existsSync(CONTEXT_PROVIDER_SCRIPT)) {
    console.warn(`[context-injector] context_provider.py not found: ${CONTEXT_PROVIDER_SCRIPT}`);
    return '';
  }

  try {
    const result = await runContextProvider();
    cachedContext = result;
    cachedAt = Date.now();
    console.log(`[context-injector] Context loaded (${result.length} chars)`);
    return result;
  } catch (err) {
    console.warn(
      `[context-injector] Failed to load context: ${err instanceof Error ? err.message : String(err)}`
    );
    // 前回のキャッシュがあればそれを返す（古くても無いよりマシ）
    return cachedContext;
  }
}

function runContextProvider(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [
        CONTEXT_PROVIDER_SCRIPT,
        '--max-tokens',
        String(MAX_TOKENS),
        '--recent-turns',
        String(RECENT_TURNS),
        '--no-todo',
      ],
      {
        timeout: EXEC_TIMEOUT_MS,
        cwd: IZUNA_WORKSPACE,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      },
      (error, stdout, _stderr) => {
        if (error) {
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
