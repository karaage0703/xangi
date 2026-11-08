import { ApiError, requestJson } from './api';
import { jsonInit } from './chatPresentation';

export interface SubmittedFile {
  path: string;
  name: string;
  localUrl?: string;
}
export interface ConversationSubmission {
  requestId: string;
  message: string;
  files: SubmittedFile[];
  accepted?: boolean;
}
export interface AcceptedConversationTurn {
  id: string;
  state: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  delivery: 'none' | 'pending' | 'sending' | 'delivered' | 'failed' | 'unknown';
  result?: string;
  updatedAt?: string;
  error?: string;
  deliveryError?: string;
}

export const submissionKey = (sessionId: string) => `xangi_conversation_submission:${sessionId}`;
export const newRequestId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
    n.toString(16).padStart(2, '0')
  ).join('');

export function saveSubmission(sessionId: string, submission: ConversationSubmission): void {
  window.sessionStorage.setItem(
    submissionKey(sessionId),
    JSON.stringify({
      ...submission,
      files: submission.files.map(({ path, name }) => ({ path, name })),
    })
  );
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function receiptRequest<T>(url: string, init: RequestInit, signal: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error('受付状態の取得がタイムアウトしました')),
    10000
  );
  try {
    return await requestJson<T>(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** Only a definite rejection before acceptance restores the composer. */
export async function followConversationTurn(
  sessionId: string,
  submission: ConversationSubmission,
  signal: AbortSignal,
  accepted: () => void,
  uncertain: () => void
): Promise<AcceptedConversationTurn> {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
  let shouldSubmit = !submission.accepted;
  let wasUncertain = false;
  let after: string | undefined;
  while (!signal.aborted) {
    try {
      const response = shouldSubmit
        ? await receiptRequest<{ turn: AcceptedConversationTurn }>(
            `${base}/turns`,
            {
              ...jsonInit('POST', {
                requestId: submission.requestId,
                message: submission.message,
                attachments: submission.files.map((f) => f.path),
              }),
            },
            signal
          )
        : await receiptRequest<{ turn: AcceptedConversationTurn }>(
            `${base}/turn-requests/${submission.requestId}${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`,
            {},
            signal
          );
      if (!submission.accepted) {
        submission.accepted = true;
        saveSubmission(sessionId, submission);
      }
      accepted();
      shouldSubmit = false;
      wasUncertain = false;
      const turn = response.turn;
      after = JSON.stringify([turn.state, turn.delivery, turn.updatedAt]);
      if (
        turn.state !== 'accepted' &&
        turn.state !== 'running' &&
        !['pending', 'sending'].includes(turn.delivery)
      )
        return turn;
      continue;
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        !submission.accepted &&
        !wasUncertain &&
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500
      )
        throw error;
      // The POST may have arrived. Look up its receipt before retrying the same ID.
      if (!submission.accepted && error instanceof ApiError && error.status === 404)
        shouldSubmit = true;
      else shouldSubmit = false;
      wasUncertain = true;
      uncertain();
    }
    await pause(signal);
  }
  throw signal.reason;
}
