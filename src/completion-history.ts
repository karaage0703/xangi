import { getTurnHistory } from './activity-store.js';
import { withoutFinalResponse } from './tool-history.js';

/** Platform-independent history shown by normal responses and delegated work. */
export function completionHistory(
  context: { threadId: string; turnId: string } | undefined,
  finalResponse: string
) {
  if (!context) return [];
  return withoutFinalResponse(
    getTurnHistory(context.threadId, context.turnId),
    finalResponse
  ).filter((entry) => !(entry.kind === 'tool' && entry.fileChanges));
}
