import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type {
  AgentRunContext,
  AgentRunFn,
  Platform,
  PlatformDeliveryReceipt,
  Schedule,
  Scheduler,
} from './scheduler.js';
import { formatAgentErrorForUser } from './errors.js';

type ScheduleRelay = (
  agentId: string,
  platform: Platform,
  prompt: string,
  destination: string,
  schedule?: Schedule,
  context?: AgentRunContext
) => Promise<string> | undefined;
let relay: ScheduleRelay | undefined;

export function registerAgentConnectionScheduleRelay(handler: ScheduleRelay): () => void {
  relay = handler;
  return () => {
    if (relay === handler) relay = undefined;
  };
}

/** undefined keeps the ordinary platform path; a selected dedicated Bot never falls back. */
export function relayAgentConnectionSchedule(
  agentId: string | undefined,
  platform: Platform,
  prompt: string,
  destination: string,
  schedule?: Schedule,
  context?: AgentRunContext
) {
  if (!agentId || process.env.XANGI_AGENT_CONNECTION_ID) return undefined;
  return relay?.(agentId, platform, prompt, destination, schedule, context);
}

interface Request {
  type: 'agent-connection-schedule';
  requestId: string;
  platform: Platform;
  prompt: string;
  destination: string;
  schedule?: Schedule;
}
type Reply =
  | { type: 'agent-connection-schedule-start'; requestId: string }
  | {
      type: 'agent-connection-schedule-delivery';
      requestId: string;
      receipt: PlatformDeliveryReceipt;
    }
  | {
      type: 'agent-connection-schedule-complete';
      requestId: string;
      result?: string;
      error?: string;
    };

/** Parent requests execute through the child's own registered platform runner and credentials. */
export function installAgentConnectionScheduleWorker(
  scheduler: Scheduler,
  platform: 'discord' | 'slack'
): void {
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const request = message as Request;
    if (
      request.type !== 'agent-connection-schedule' ||
      typeof request.requestId !== 'string' ||
      typeof request.prompt !== 'string' ||
      typeof request.destination !== 'string'
    )
      return;
    const send = (reply: Reply) => {
      if (process.connected) process.send?.(reply, () => undefined);
    };
    void (async () => {
      try {
        const runner =
          request.platform === platform ? scheduler.getAgentRunner(request.platform) : undefined;
        if (!runner) throw new Error('専用Botの配信先サービスが一致しません');
        const result = await runner(request.prompt, request.destination, request.schedule, {
          onStart: () =>
            send({ type: 'agent-connection-schedule-start', requestId: request.requestId }),
          onDelivery: (receipt) =>
            send({
              type: 'agent-connection-schedule-delivery',
              requestId: request.requestId,
              receipt,
            }),
        });
        send({ type: 'agent-connection-schedule-complete', requestId: request.requestId, result });
      } catch (error) {
        send({
          type: 'agent-connection-schedule-complete',
          requestId: request.requestId,
          error: formatAgentErrorForUser(error),
        });
      }
    })();
  });
}

/** Correlate requests and delivery receipts without exposing child HTTP listeners or credentials. */
export class AgentConnectionScheduleClient {
  private pending = new Map<
    string,
    {
      resolve: (result: string) => void;
      reject: (error: Error) => void;
      context?: AgentRunContext;
    }
  >();
  constructor(
    private child: ChildProcess,
    private platform: Platform
  ) {
    child.on('message', (message: unknown) => this.receive(message));
    child.once('close', () => this.close());
  }

  run: AgentRunFn = (prompt, destination, schedule, context) =>
    new Promise((resolve, reject) => {
      if (!this.child.connected) {
        reject(new Error('専用Botが接続されていません'));
        return;
      }
      const requestId = randomUUID();
      this.pending.set(requestId, { resolve, reject, context });
      const request: Request = {
        type: 'agent-connection-schedule',
        requestId,
        platform: this.platform,
        prompt,
        destination,
        schedule,
      };
      try {
        this.child.send(request, (error) => {
          if (error) this.fail(requestId, '専用Botへ予定を渡せませんでした');
        });
      } catch {
        this.fail(requestId, '専用Botへ予定を渡せませんでした');
      }
    });

  private receive(message: unknown) {
    if (!message || typeof message !== 'object') return;
    const reply = message as Reply;
    const pending = this.pending.get(reply.requestId);
    if (!pending) return;
    try {
      if (reply.type === 'agent-connection-schedule-start') pending.context?.onStart?.();
      else if (reply.type === 'agent-connection-schedule-delivery')
        pending.context?.onDelivery?.(reply.receipt);
      else if (reply.type === 'agent-connection-schedule-complete') {
        this.pending.delete(reply.requestId);
        if (reply.error) pending.reject(new Error(reply.error));
        else if (typeof reply.result === 'string') pending.resolve(reply.result);
        else pending.reject(new Error('専用Botから実行結果を取得できませんでした'));
      }
    } catch {
      this.fail(reply.requestId, '専用Botの予定実行状態を更新できませんでした');
    }
  }
  private fail(requestId: string, message: string) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.reject(new Error(message));
  }
  close() {
    for (const requestId of this.pending.keys())
      this.fail(requestId, '専用Botの接続が終了しました');
  }
}
