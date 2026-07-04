/**
 * replyInThread で新規スレッドを作成できた場合、以降の会話コンテキスト（セッション・
 * イベント・UI・ランナー呼び出し）のキーをそのスレッドIDにする。作成できなかった場合
 * （既にスレッド内 / DM / 作成不可）は受信チャンネルIDをそのまま使う。
 *
 * これがないと、親チャンネルで受けた発言から自動作成したスレッド内の続き発言が
 * 別セッション扱いになり、同じ会話を継続できない。
 */
export function resolveConversationChannelId(
  receivedChannelId: string,
  createdThreadId?: string
): string {
  return createdThreadId ?? receivedChannelId;
}

export function buildDiscordChannelContextLine(params: {
  channelName: string | null;
  conversationChannelId: string;
  createdThreadName?: string | null;
}): string | null {
  const { channelName, conversationChannelId, createdThreadName } = params;
  if (!channelName) return null;
  if (createdThreadName) {
    return `[チャンネル: #${channelName} / thread: ${createdThreadName} (ID: ${conversationChannelId})]`;
  }
  return `[チャンネル: #${channelName} (ID: ${conversationChannelId})]`;
}
