import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { formatElapsedTime } from './completion-summary.js';

export function lineLogKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function lineFailure(error: unknown): { errorKind: string; httpStatus?: number } {
  const e = error as {
    name?: string;
    status?: number;
    statusCode?: number;
    message?: string;
  } | null;
  const status = e?.status ?? e?.statusCode;
  const httpStatus =
    typeof status === 'number' && status >= 100 && status <= 599 ? status : undefined;
  return {
    errorKind:
      e?.name === 'TimeoutError'
        ? 'timeout'
        : e?.name === 'AbortError'
          ? 'aborted'
          : e?.name === 'LineAgentBusyError'
            ? 'previous_agent_pending'
            : e?.message?.includes('already has an active writer')
              ? 'session_busy'
              : httpStatus
                ? 'http_error'
                : 'operation_failed',
    ...(httpStatus ? { httpStatus } : {}),
  };
}

// Only fixed labels and numeric/boolean metadata belong here; never accept payloads or errors.
interface TimingFields {
  durationMs?: number;
  queueWaitMs?: number;
  queueDepth?: number;
  blockingTraceId?: string;
  mode?: 'reply' | 'push' | 'loading';
  purpose?: 'final' | 'notice' | 'command' | 'schedule';
  errorKind?: string;
  httpStatus?: number;
  waitMs?: number;
  attempt?: number;
  reason?: 'busy' | 'stale' | 'reset';
}

export class LineLatencyTrace {
  readonly id = randomUUID();
  private readonly eventAt?: number;
  private readonly keys: { conversationKey: string; messageKey?: string; eventKey?: string };

  constructor(
    conversationId: string,
    messageId?: string,
    eventId?: string,
    eventTimestamp?: number,
    readonly receivedAt = Date.now(),
    readonly kind: 'message' | 'schedule' = 'message',
    readonly redelivery = false
  ) {
    this.keys = {
      conversationKey: lineLogKey(conversationId),
      ...(messageId ? { messageKey: lineLogKey(messageId) } : {}),
      ...(eventId ? { eventKey: lineLogKey(eventId) } : {}),
    };
    if (Number.isSafeInteger(eventTimestamp) && eventTimestamp! > 0 && eventTimestamp! <= 8.64e15)
      this.eventAt = eventTimestamp;
  }

  mark(stage: string, fields: TimingFields = {}): void {
    console.log(
      '[line-latency]',
      JSON.stringify({
        version: 1,
        at: new Date().toISOString(),
        traceId: this.id,
        ...this.keys,
        kind: this.kind,
        stage,
        sinceReceiptMs: Math.max(0, Date.now() - this.receivedAt),
        ...fields,
        ...(stage === 'send_success' && this.eventAt
          ? {
              eventToApiAcceptedMs: Date.now() - this.eventAt,
            }
          : {}),
        ...(stage === 'webhook_received'
          ? {
              receivedAt: new Date(this.receivedAt).toISOString(),
              ...(this.eventAt
                ? {
                    eventAt: new Date(this.eventAt).toISOString(),
                    deliveryLagMs: this.receivedAt - this.eventAt,
                  }
                : {}),
              redelivery: this.redelivery,
            }
          : {}),
      })
    );
  }

  async measure<T>(stage: string, task: () => Promise<T>, fields: TimingFields = {}): Promise<T> {
    const start = performance.now();
    this.mark(`${stage}_start`, fields);
    try {
      const result = await task();
      this.mark(`${stage}_success`, {
        ...fields,
        durationMs: Math.round(performance.now() - start),
      });
      return result;
    } catch (error) {
      this.mark(`${stage}_failure`, {
        ...fields,
        durationMs: Math.round(performance.now() - start),
        ...lineFailure(error),
      });
      throw error;
    }
  }

  completionSummary(agentMs: number, showElapsed: boolean, failed = false): string {
    const label = failed ? '⚠️ 終了' : '✅ 完了';
    if (!showElapsed) return label;
    // Delivery/reading on the handset is not observable before sending this message.
    const useEvent = this.eventAt !== undefined && this.eventAt <= this.receivedAt;
    const elapsed = Math.max(0, Date.now() - (useEvent ? this.eventAt! : this.receivedAt));
    return `${label}（${useEvent ? '送信' : '受信'}→返信準備 ${formatElapsedTime(elapsed)} / AI ${formatElapsedTime(agentMs)}）`;
  }

  totalBeforeSendMs(): number {
    return Math.max(
      0,
      Date.now() -
        (this.eventAt !== undefined && this.eventAt <= this.receivedAt
          ? this.eventAt
          : this.receivedAt)
    );
  }
}
