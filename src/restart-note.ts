/**
 * プロセス再起動アーティファクトの注記。
 *
 * xangi が再起動（pm2 restart / 自己再起動 / クラッシュ復旧）した直後に
 * 既存セッションを resume すると、エージェント側のトランスクリプトには
 * 直前の未完了 tool 呼び出しが 'rejected'（拒否）形式で記録されている。
 * エージェントはこれを「ユーザーに拒否された」と誤解しがちなので、
 * 再起動後の各チャンネル最初の resume プロンプトに一度だけ注記を入れて
 * 誤解釈を防ぐ。
 */

const bootTime = new Date();
const notifiedChannels = new Set<string>();

/**
 * 再起動注記を取得する（チャンネルごとに一度だけ返す）。
 * - 既存セッションが無い（新規セッション）なら注記不要 → null
 * - 同じチャンネルで 2 回目以降 → null
 */
export function consumeRestartNote(channelId: string, hasExistingSession: boolean): string | null {
  if (notifiedChannels.has(channelId)) return null;
  notifiedChannels.add(channelId);
  if (!hasExistingSession) return null;

  const t = bootTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  return (
    `[システム注記: The xangi process started (or restarted) at ${t}. ` +
    `If unfinished tool calls earlier in the conversation are recorded as 'rejected' or interrupted, ` +
    `this is an artifact of the process restart, not a rejection by the user. ` +
    `Do not interpret this as rejection; check results as needed and continue working]`
  );
}

/** テスト用: 通知済みチャンネルの記録をリセットする */
export function resetRestartNoteStateForTest(): void {
  notifiedChannels.clear();
}
