import type { ToolHistoryEntry } from './types';

export interface ToolHistoryMessage {
  role: string;
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
 * between a user message and the following assistant reply.
 */
export function associateToolHistory(
  messages: ToolHistoryMessage[],
  platform: string | undefined,
  tools: ToolHistoryEntry[]
): ToolHistoryEntry[][] {
  const associated = messages.map(() => [] as ToolHistoryEntry[]);
  let pendingUser: ToolHistoryMessage | undefined;

  messages.forEach((message, index) => {
    if (message.role === 'user') {
      pendingUser = message;
      return;
    }
    if (message.role !== 'assistant' || !pendingUser) return;

    const exactTurnId =
      pendingUser.platformMessageId && (platform === 'discord' || platform === 'slack')
        ? `${platform}-msg-${pendingUser.platformMessageId}`
        : undefined;
    let matches = exactTurnId ? tools.filter((tool) => tool.turnId === exactTurnId) : [];

    if (matches.length === 0) {
      const start = timestamp(pendingUser.createdAt);
      const end = timestamp(message.createdAt);
      if (start !== undefined && end !== undefined) {
        matches = tools.filter((tool) => tool.at >= start && tool.at <= end + 5_000);
      }
    }

    associated[index] = matches;
    pendingUser = undefined;
  });

  return associated;
}
