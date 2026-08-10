import type { TurnHistoryEntry } from './types';

export interface ToolHistoryMessage {
  role: string;
  content?: string;
  createdAt?: string;
  platformMessageId?: string;
}

function timestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Associate persisted tool events with the assistant reply for the same turn.
 *
 * Discord and Slack can use the incoming platform message ID exactly. Web
 * turns (and older transcripts without that ID) fall back to the interval
 * between a user message and the final consecutive assistant reply.
 */
export function associateToolHistory(
  messages: ToolHistoryMessage[],
  platform: string | undefined,
  history: TurnHistoryEntry[]
): TurnHistoryEntry[][] {
  const associated = messages.map(() => [] as TurnHistoryEntry[]);
  let pendingUser: ToolHistoryMessage | undefined;
  let pendingAssistantIndexes: number[] = [];

  const associatePendingTurn = () => {
    const targetIndex = pendingAssistantIndexes.at(-1);
    if (!pendingUser || targetIndex === undefined) return;
    const targetMessage = messages[targetIndex];

    const exactTurnId =
      pendingUser.platformMessageId && (platform === 'discord' || platform === 'slack')
        ? `${platform}-msg-${pendingUser.platformMessageId}`
        : undefined;
    let matches = exactTurnId ? history.filter((entry) => entry.turnId === exactTurnId) : [];

    if (matches.length === 0) {
      const start = timestamp(pendingUser.createdAt);
      const end = timestamp(targetMessage.createdAt);
      if (start !== undefined && end !== undefined) {
        matches = history.filter((entry) => entry.at >= start && entry.at <= end + 5_000);
      }
    }

    const last = matches.at(-1);
    if (
      last?.kind === 'text' &&
      last.text.trim() &&
      targetMessage.content?.trim() &&
      targetMessage.content.trim().endsWith(last.text.trim())
    ) {
      matches = matches.slice(0, -1);
    }

    associated[targetIndex] = matches;
    pendingUser = undefined;
    pendingAssistantIndexes = [];
  };

  messages.forEach((message, index) => {
    if (message.role === 'user') {
      associatePendingTurn();
      pendingUser = message;
      pendingAssistantIndexes = [];
      return;
    }
    if (message.role === 'assistant' && pendingUser) {
      pendingAssistantIndexes.push(index);
    }
  });
  associatePendingTurn();

  return associated;
}
