import type { LineBotClient } from '@line/bot-sdk';

export type LineClient = Pick<
  LineBotClient,
  'replyMessage' | 'pushMessage' | 'showLoadingAnimation'
>;
export const LINE_API_TIMEOUT_MS = 15_000;
export const LINE_MEDIA_TIMEOUT_MS = 60_000;

export class LineApiError extends Error {
  constructor(readonly status: number) {
    super(`LINE API returned HTTP ${status}`);
    this.name = 'LineApiError';
  }
}

/** The SDK does not expose a request deadline. Abort both headers and response-body reads. */
export function createLineClient(
  channelAccessToken: string,
  timeoutMs = LINE_API_TIMEOUT_MS,
  baseURL = 'https://api.line.me'
): LineClient {
  async function post<T>(path: string, body: unknown, retryKey?: string): Promise<T> {
    const response = await fetch(new URL(path, baseURL), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
        'Content-Type': 'application/json',
        ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new LineApiError(response.status);
    }
    return (await response.json()) as T;
  }
  return {
    replyMessage: (body) => post('/v2/bot/message/reply', body),
    pushMessage: (body, retryKey) => post('/v2/bot/message/push', body, retryKey),
    showLoadingAnimation: (body) => post('/v2/bot/chat/loading/start', body),
  };
}

/** A definite token rejection is safe to fall back from; timeouts/5xx are ambiguous. */
export function canFallbackFromLineReply(error: unknown): boolean {
  const status =
    (error as { status?: number; statusCode?: number } | null)?.status ??
    (error as { statusCode?: number } | null)?.statusCode;
  return status === 400;
}
