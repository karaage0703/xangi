/**
 * Web Chat の現ペイン履歴を取得するCLIモジュール
 *
 * Discord/Slack の `xangi tool discord_history` 相当を Web 用に提供する。
 * Claude Code セッションが切れても xangi の app session jsonl は残るので、
 * これを開けば現ペインの過去会話を取り戻せる。
 *
 * **必ず特定の Web セッションを指定して取得する**:
 * - `--session <id>` 明示指定
 * - 無ければ env `XANGI_CHANNEL_ID` を見る (xangi 内部からの呼び出し時に
 *   `web-chat:<appSessionId>` がセットされている)
 * - どちらも該当しない場合はエラーメッセージを返す。
 *   mtime ベースのフォールバックは入れない (Discord/Slack runner から呼ばれた
 *   とき、別ペインの会話を引っ張ってきて context を汚染する事故があったため)。
 */
import {
  formatHistory,
  getSessionsDirs,
  readHistoryEntries,
  sessionHistoryPath,
} from './session-history.js';

interface WebHistoryFlags {
  count?: string;
  session?: string;
  'max-chars'?: string;
}

/**
 * 現ペイン (= xangi が呼び出した時の Web session) を解決する。
 * `--session` 明示 > env `XANGI_CHANNEL_ID` (`web-chat:<id>` 形式) > undefined
 */
function resolveCurrentSession(f: WebHistoryFlags): string | undefined {
  if (f.session) return f.session;
  const env = process.env.XANGI_CHANNEL_ID;
  if (env && env.startsWith('web-chat:')) {
    return env.slice('web-chat:'.length);
  }
  return undefined;
}

export function webHistoryCmd(flags: Record<string, string>): string {
  const f = flags as WebHistoryFlags;
  const count = Math.max(1, parseInt(f.count ?? '10', 10) || 10);
  const maxChars = Math.max(50, parseInt(f['max-chars'] ?? '500', 10) || 500);

  const currentSession = resolveCurrentSession(f);
  if (!currentSession) {
    return '(no current Web pane; specify --session <appSessionId> or run from a Web Chat session)';
  }

  const name = `${currentSession}.jsonl`;
  const path = sessionHistoryPath(currentSession);
  if (!path) {
    return `(session ${name} not found in ${getSessionsDirs().join(' or ')})`;
  }

  const entries = readHistoryEntries(path);
  return entries
    ? formatHistory(entries, `# session: ${name}`, count, maxChars)
    : `(failed to read ${name})`;
}
