/**
 * システムコマンドCLIモジュール
 *
 * tool-server (xangi 本体プロセス) 内で実行される前提。
 * 再起動は自プロセスへ SIGTERM を送って pm2 / Docker などの supervisor に任せる。
 */
import { canSelfRestart, getSelfLifecyclePermission } from '../self-lifecycle.js';
import { requestProcessRestart } from '../restart-process.js';
import { assertRuntimeStateCanStart } from '../runtime-state-validation.js';

/**
 * 自プロセスに SIGTERM を送って再起動を依頼する。
 *
 * 前提: tool-server 経由で xangi 本体プロセス内から呼ばれる。
 * レスポンスを先に返してから kill するため、kill は次の tick (100ms 後) に遅延させる。
 * pm2 / Docker の restart policy で復活する想定。
 */
async function systemRestart(): Promise<string> {
  const selfLifecycle = getSelfLifecyclePermission();
  if (!canSelfRestart(selfLifecycle)) {
    return '⚠️ 自己再起動が無効です。管理者が .env の XANGI_SELF_LIFECYCLE=restart-only を設定し、xangi を再起動してください。';
  }

  assertRuntimeStateCanStart();

  requestProcessRestart(100);

  return '🔄 再起動をリクエストしました';
}

// ─── Router ─────────────────────────────────────────────────────────

export async function systemCmd(command: string, _flags: Record<string, string>): Promise<string> {
  switch (command) {
    case 'system_restart':
      return systemRestart();
    default:
      throw new Error(`Unknown system command: ${command}`);
  }
}
