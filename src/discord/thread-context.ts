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

export function resolveDiscordSettingsChannelId(
  receivedChannelId: string,
  channel: {
    isThread?: () => boolean;
    parentId?: string | null;
  }
): string {
  if (typeof channel.isThread === 'function' && channel.isThread() && channel.parentId) {
    return channel.parentId;
  }
  return receivedChannelId;
}

export function getDiscordChannelTopic(channel: {
  topic?: string | null;
  isThread?: () => boolean;
  parent?: unknown;
}): string | null {
  if (typeof channel.topic === 'string' && channel.topic.length > 0) {
    return channel.topic;
  }
  const parent =
    channel.parent && typeof channel.parent === 'object'
      ? (channel.parent as { topic?: unknown })
      : null;
  if (
    typeof channel.isThread === 'function' &&
    channel.isThread() &&
    typeof parent?.topic === 'string' &&
    parent.topic.length > 0
  ) {
    return parent.topic;
  }
  return null;
}

export function buildDiscordChannelContextLine(params: {
  channelName: string | null;
  conversationChannelId: string;
  settingsChannelId?: string;
  threadName?: string | null;
  parentChannelName?: string | null;
}): string | null {
  const { channelName, conversationChannelId, settingsChannelId, threadName, parentChannelName } =
    params;
  if (threadName && settingsChannelId) {
    const parentLabel = parentChannelName ? `#${parentChannelName} ` : '親チャンネル ';
    return `[チャンネル: ${parentLabel}(ID: ${settingsChannelId}) / thread: ${threadName} (ID: ${conversationChannelId})]`;
  }
  if (!channelName) return null;
  return `[チャンネル: #${channelName} (ID: ${conversationChannelId})]`;
}

export function prependDiscordTimestamp(
  prompt: string,
  enabled: boolean,
  date = new Date()
): string {
  if (!enabled) return prompt;
  const now = date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const day = date.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });
  return `[現在時刻: ${now}(${day})]\n${prompt}`;
}
