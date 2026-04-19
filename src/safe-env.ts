/**
 * AIエージェントに渡す環境変数のホワイトリスト
 * ここに記載された変数のみ CLI/exec プロセスに渡される
 * シークレット（トークン・APIキー等）は絶対に追加しないこと
 */
export const ALLOWED_ENV_KEYS = [
  // シェル基本環境
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  // Node.js
  'NODE_ENV',
  'NODE_PATH',
  // xangi動作用
  'WORKSPACE_PATH',
  'AGENT_BACKEND',
  'AGENT_MODEL',
  'SKIP_PERMISSIONS',
  'DATA_DIR',
  'XANGI_TOOL_SERVER',
  'XANGI_CHANNEL_ID',
];

/**
 * ホワイトリスト方式で安全な環境変数のみ返す
 */
export function getSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  // xangi-cmd (bin/) をPATHに追加
  if (env.PATH && XANGI_BIN_DIR) {
    env.PATH = `${XANGI_BIN_DIR}:${env.PATH}`;
  }

  return env;
}

// xangiのbin/ディレクトリを起動時に解決
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const XANGI_BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
