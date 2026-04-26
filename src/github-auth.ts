/**
 * GitHub App認証
 *
 * GitHub App設定があれば gh ラッパースクリプトを自動生成し、
 * エージェントの PATH に差し込む。gh 実行時にtool-server経由でトークンを取得。
 *
 * 秘密鍵は起動時にメモリに読み込み、ファイルシステムには残さない。
 * トークン生成はtool-serverのHTTPエンドポイント経由で行い、
 * 子プロセス（Claude Code等）から秘密鍵にアクセスできないようにする。
 */
import { writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface GitHubAppConfig {
  appId: string;
  installationId: string;
  /** メモリ上に保持した秘密鍵の内容 */
  privateKey: string;
}

let appConfig: GitHubAppConfig | null = null;

// ラッパースクリプトの配置先
const WRAPPER_DIR = '/tmp/xangi-gh-wrapper';
const WRAPPER_PATH = join(WRAPPER_DIR, 'gh');

/**
 * GitHub App設定を初期化しラッパーを生成
 *
 * 秘密鍵をファイルから読み込んでメモリに保持する。
 * ファイル自体は読み込み後にアクセス不要。
 */
export function initGitHubAuth(): void {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

  if (appId && installationId && privateKeyPath) {
    // Docker環境ではマウント先の固定パスを使用
    const dockerPemPath = '/secrets/github-app.pem';
    const resolvedKeyPath = existsSync(dockerPemPath) ? dockerPemPath : privateKeyPath;

    // 秘密鍵をメモリに読み込み
    let privateKey: string;
    try {
      privateKey = readFileSync(resolvedKeyPath, 'utf-8');
    } catch (err) {
      console.error(`[github-auth] Failed to read private key from ${resolvedKeyPath}:`, err);
      console.log('[github-auth] Falling back to default gh authentication');
      return;
    }

    appConfig = { appId, installationId, privateKey };
    generateWrapper();
    console.log(`[github-auth] GitHub App mode enabled (App ID: ${appId})`);
  } else {
    console.log('[github-auth] Using default gh authentication');
  }
}

/**
 * GitHub App が有効かどうか
 */
export function isGitHubAppEnabled(): boolean {
  return appConfig !== null;
}

/**
 * エージェントの PATH に追加すべきディレクトリ
 * App モード: ラッパーディレクトリを返す
 * 通常モード: undefined
 */
export function getGitHubWrapperDir(): string | undefined {
  return appConfig ? WRAPPER_DIR : undefined;
}

/**
 * エージェントプロセスに渡す環境変数を取得
 * App モード: PATH にラッパーディレクトリを先頭追加
 * 通常モード: 空オブジェクト
 */
export function getGitHubEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string>
): Record<string, string> {
  if (!appConfig) return {};
  const currentPath = baseEnv['PATH'] || process.env.PATH || '';
  return { PATH: `${WRAPPER_DIR}:${currentPath}` };
}

/**
 * GitHub App Installation Tokenを生成
 *
 * tool-serverから呼ばれる。メモリ上の秘密鍵を使って
 * 短寿命（1時間）のInstallation Tokenを生成する。
 */
export async function generateInstallationToken(): Promise<string> {
  if (!appConfig) {
    throw new Error('GitHub App is not configured');
  }

  // 動的import（パッケージがインストールされていない環境でもビルドが通るように）
  const { createAppAuth } = (await import('@octokit/auth-app' as string)) as {
    createAppAuth: (...args: unknown[]) => { (opts: { type: string }): Promise<{ token: string }> };
  };

  const auth = createAppAuth({
    appId: appConfig.appId,
    privateKey: appConfig.privateKey,
    installationId: parseInt(appConfig.installationId, 10),
  });

  const { token } = await auth({ type: 'installation' });
  return token;
}

/**
 * ghラッパースクリプトを生成
 *
 * tool-serverのHTTPエンドポイント経由でトークンを取得するラッパー。
 * 秘密鍵へのアクセスは不要。
 */
function generateWrapper(): void {
  mkdirSync(WRAPPER_DIR, { recursive: true });

  // gh ラッパーシェルスクリプト
  // XANGI_TOOL_SERVER経由でトークンを取得（秘密鍵不要）
  const wrapper = `#!/bin/bash
if [ -z "$XANGI_TOOL_SERVER" ]; then
  echo "Error: XANGI_TOOL_SERVER is not set" >&2
  exit 1
fi
export GH_TOKEN="$(curl -sf "$XANGI_TOOL_SERVER/github-token")"
if [ -z "$GH_TOKEN" ]; then
  echo "Error: Failed to get GitHub App token from tool-server" >&2
  exit 1
fi
exec "$(which -a gh | grep -v "${WRAPPER_DIR}" | head -1)" "$@"
`;
  writeFileSync(WRAPPER_PATH, wrapper, 'utf-8');
  chmodSync(WRAPPER_PATH, 0o755);
}
