import { buildCompletionSummary, type CompletionDisplayOptions } from '../completion-summary.js';

export type DiscordCompletionNotifyMode = 'off' | 'message' | 'mention';

export interface CompletionNotificationInput {
  mode: DiscordCompletionNotifyMode;
  elapsedMs: number;
  thresholdMs: number;
  userId: string;
  display: CompletionDisplayOptions;
}

export interface CompletionNotificationPayload {
  content: string;
  allowedMentions: {
    parse: [];
    users?: string[];
  };
}

export function buildCompletionNotification(
  input: CompletionNotificationInput
): CompletionNotificationPayload | null {
  if (input.mode === 'off') return null;
  if (input.elapsedMs < input.thresholdMs) return null;

  const summary = buildCompletionSummary({ elapsedMs: input.elapsedMs }, input.display);
  if (input.mode === 'mention') {
    return {
      content: `<@${input.userId}> ${summary}`,
      allowedMentions: { parse: [], users: [input.userId] },
    };
  }

  return {
    content: summary,
    allowedMentions: { parse: [] },
  };
}
