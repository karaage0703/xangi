import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { webhook } from '@line/bot-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleLineEvent,
  LineChatQueue,
  LineImageSetBuffer,
  startLineBot,
  type HandlerContext,
} from '../src/line.js';
import { LineLatencyTrace, lineLogKey } from '../src/line-latency.js';
import { initSessions } from '../src/sessions.js';

const USER = `U${'a'.repeat(32)}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function event(id: string, ageMs = 0): webhook.Event {
  return {
    type: 'message',
    message: { type: 'text', id, text: 'PRIVATE_MESSAGE_BODY' },
    source: { type: 'user', userId: USER },
    replyToken: 'PRIVATE_REPLY_TOKEN',
    timestamp: Date.now() - ageMs,
    webhookEventId: `event-${id}`,
    deliveryContext: { isRedelivery: false },
  } as webhook.Event;
}
function harness(run = async () => undefined): HandlerContext {
  return {
    path: '/webhook',
    channelSecret: 'PRIVATE_SECRET',
    channelAccessToken: 'PRIVATE_ACCESS_TOKEN',
    agentRunner: {
      runStream: vi.fn(async (_prompt, callbacks) => {
        callbacks.onBackendReady?.();
        await run();
        return { result: 'reply', sessionId: 'provider-test' };
      }),
      cancel: vi.fn(() => true),
    } as never,
    resolver: {} as never,
    client: {
      replyMessage: vi.fn().mockResolvedValue({}),
      pushMessage: vi.fn().mockResolvedValue({}),
      showLoadingAnimation: vi.fn().mockResolvedValue({}),
    } as never,
    queue: new LineChatQueue(),
    imageSets: new LineImageSetBuffer(),
    allowedUsers: [USER],
    allowAll: false,
    loadingAnimationEnabled: false,
    loadingAnimationSeconds: 60,
    slowResponseEnabled: false,
    slowResponseThresholdMs: 45000,
    idleResetEnabled: false,
    idleResetMs: 0,
    resetTextPatterns: ['/reset'],
    completionDisplay: { showElapsed: true },
    completionNotifyAfterMs: 10_000,
  };
}
let temp: string;
let log: ReturnType<typeof vi.spyOn>;
const servers: Server[] = [];
function records() {
  return log.mock.calls
    .filter((args) => args[0] === '[line-latency]')
    .map((args) => JSON.parse(String(args[1])));
}
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'line-latency-'));
  initSessions(temp);
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(temp, { recursive: true, force: true });
});

describe('LINE latency evidence', () => {
  it('separates four minutes before receipt from a short AI run, with safe logs and an honest footer', async () => {
    const ctx = harness();
    await handleLineEvent(event('m1', 240_000), ctx);
    const rows = records();
    expect(rows[0]).toMatchObject({ stage: 'webhook_received', redelivery: false });
    expect(rows[0].deliveryLagMs).toBeGreaterThanOrEqual(240_000);
    expect(rows.map((r) => r.stage)).toEqual([
      'webhook_received',
      'queue_enqueued',
      'processing_start',
      'agent_start',
      'agent_backend_ready',
      'agent_success',
      'send_start',
      'send_success',
      'processing_end',
    ]);
    expect(rows.find((r) => r.stage === 'agent_success').durationMs).toBeLessThan(1000);
    expect(
      rows.find((r) => r.stage === 'send_success').eventToApiAcceptedMs
    ).toBeGreaterThanOrEqual(240_000);
    const text = vi.mocked(ctx.client.replyMessage).mock.calls[0][0].messages[0];
    expect(text).toMatchObject({ text: expect.stringContaining('送信→返信準備 4分') });
    for (const secret of [
      USER,
      'PRIVATE_MESSAGE_BODY',
      'PRIVATE_REPLY_TOKEN',
      'PRIVATE_SECRET',
      'PRIVATE_ACCESS_TOKEN',
    ])
      expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('records queue wait and the trace that blocked the next turn', async () => {
    const gate = deferred();
    const ctx = harness(() => gate.promise);
    const first = handleLineEvent(event('m1'), ctx);
    await sleep(5);
    const second = handleLineEvent(event('m2'), ctx);
    await sleep(40);
    gate.resolve();
    await Promise.all([first, second]);
    const rows = records();
    const firstId = rows.find((r) => r.messageKey === lineLogKey('m1')).traceId;
    const secondRows = rows.filter((r) => r.messageKey === lineLogKey('m2'));
    expect(secondRows.find((r) => r.stage === 'queue_enqueued')).toMatchObject({
      queueDepth: 1,
      blockingTraceId: firstId,
    });
    expect(
      secondRows.find((r) => r.stage === 'processing_start').queueWaitMs
    ).toBeGreaterThanOrEqual(30);
    expect(secondRows.find((r) => r.stage === 'agent_success').durationMs).toBeLessThan(30);
  });

  it('expires a stuck agent, cancels it, answers followers without overlapping agents, and recovers on settlement', async () => {
    const gate = deferred();
    const ctx = harness(() => gate.promise);
    ctx.agentTimeoutMs = 40;
    const first = handleLineEvent(event('m1'), ctx);
    const second = handleLineEvent(event('m2'), ctx);
    await Promise.all([first, second]);
    expect(ctx.agentRunner.cancel).toHaveBeenCalledWith(`line:${USER}`);
    expect(ctx.agentRunner.runStream).toHaveBeenCalledTimes(1);
    expect(ctx.client.replyMessage).toHaveBeenCalledTimes(2);
    expect(
      records()
        .filter((r) => r.stage === 'agent_failure')
        .map((r) => r.errorKind)
    ).toEqual(['timeout', 'previous_agent_pending']);
    gate.resolve();
    await sleep(5);
    await handleLineEvent(event('m3'), ctx);
    expect(ctx.agentRunner.runStream).toHaveBeenCalledTimes(2);
    expect(ctx.queue.isBusy(`line:${USER}`)).toBe(false);
  });

  it('falls back only for definite reply rejection; an ambiguous send never duplicates a message', async () => {
    for (const [status, expectedPush] of [
      [400, 1],
      [500, 0],
      [0, 0],
    ]) {
      const ctx = harness();
      vi.mocked(ctx.client.replyMessage).mockRejectedValue(
        Object.assign(new Error('PRIVATE_ERROR_DETAIL'), {
          status,
          name: status ? 'Error' : 'TimeoutError',
        })
      );
      await handleLineEvent(event(`status-${status}`), ctx);
      expect(ctx.client.pushMessage).toHaveBeenCalledTimes(expectedPush);
    }
    expect(JSON.stringify(records())).not.toContain('PRIVATE_ERROR_DETAIL');
  });

  it('uses receipt time when timestamp is absent or in the future', () => {
    for (const timestamp of [undefined, Date.now() + 60_000]) {
      const trace = new LineLatencyTrace(USER, 'm', undefined, timestamp);
      expect(trace.completionSummary(14_000, true)).toContain('受信→返信準備');
      expect(trace.completionSummary(14_000, true)).toContain('AI 14秒');
    }
  });

  it('acknowledges a signed webhook before a blocked agent finishes and records redelivery metadata', async () => {
    const gate = deferred();
    const ctx = harness(() => gate.promise);
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input, init) =>
        String(input).startsWith('https://api.line.me')
          ? Promise.resolve(new Response('{}', { status: 200 }))
          : realFetch(input, init)
      )
    );
    const server = await startLineBot({
      agentRunner: ctx.agentRunner,
      resolver: ctx.resolver,
      channelSecret: ctx.channelSecret,
      channelAccessToken: ctx.channelAccessToken,
      allowedUsers: [USER],
      port: 0,
      loadingAnimationEnabled: false,
      slowResponseEnabled: false,
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const e = { ...event('http1', 120_000), deliveryContext: { isRedelivery: true } };
    const body = JSON.stringify({ events: [e] });
    const response = await realFetch(`http://127.0.0.1:${address.port}/webhook`, {
      method: 'POST',
      body,
      headers: {
        'x-line-signature': createHmac('sha256', ctx.channelSecret).update(body).digest('base64'),
      },
    });
    expect(response.status).toBe(200);
    expect(records()[0]).toMatchObject({ stage: 'webhook_received', redelivery: true });
    expect(records().some((r) => r.stage === 'agent_success')).toBe(false);
    gate.resolve();
    for (let i = 0; i < 50 && !records().some((r) => r.stage === 'send_success'); i++)
      await sleep(5);
    expect(records().some((r) => r.stage === 'send_success')).toBe(true);
  });
});
