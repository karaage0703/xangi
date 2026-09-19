export interface LineScheduleTarget {
  /** push 先の LINE userId */
  userId: string;
  /** セッションとキューの単位になる contextKey */
  contextKey: string;
}

const LINE_CONTEXT_PREFIX = 'line:';

/** LINE予定の保存先をpush可能なuser IDと会話keyへ正規化する。 */
export function parseLineScheduleTarget(channelId: string): LineScheduleTarget {
  const withPrefix = channelId.match(/^line:(U[0-9a-f]{32})$/i);
  if (withPrefix) {
    return { userId: withPrefix[1], contextKey: channelId };
  }
  if (/^U[0-9a-f]{32}$/i.test(channelId)) {
    return { userId: channelId, contextKey: `${LINE_CONTEXT_PREFIX}${channelId}` };
  }
  throw new Error(`[xangi-line] Unsupported schedule channelId: ${channelId}`);
}
