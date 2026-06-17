export type DiscordCompletionNotifyMode = 'off' | 'message' | 'mention';

export interface CompletionNotificationInput {
  mode: DiscordCompletionNotifyMode;
  elapsedMs: number;
  thresholdMs: number;
  userId: string;
}

export interface CompletionNotificationPayload {
  content: string;
  allowedMentions: {
    parse: [];
    users?: string[];
  };
}

function formatElapsed(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.round(elapsedMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}秒`;
  return `${min}分${sec.toString().padStart(2, '0')}秒`;
}

export function buildCompletionNotification(
  input: CompletionNotificationInput
): CompletionNotificationPayload | null {
  if (input.mode === 'off') return null;
  if (input.elapsedMs < input.thresholdMs) return null;

  const elapsed = formatElapsed(input.elapsedMs);
  if (input.mode === 'mention') {
    return {
      content: `<@${input.userId}> ✅ 完了しました（${elapsed}）`,
      allowedMentions: { parse: [], users: [input.userId] },
    };
  }

  return {
    content: `✅ 完了しました（${elapsed}）`,
    allowedMentions: { parse: [] },
  };
}
