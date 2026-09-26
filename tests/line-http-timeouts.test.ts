import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { webhook } from '@line/bot-sdk';
import { createLineClient } from '../src/line-api.js';
import {
  handleLineEvent,
  LineChatQueue,
  LineImageSetBuffer,
  type HandlerContext,
} from '../src/line.js';
import { initSessions } from '../src/sessions.js';

const USER = `U${'b'.repeat(32)}`;
let server: Server;
let baseURL: string;
let temp: string;
let log: ReturnType<typeof vi.spyOn>;
let replies: number;
let replyMode: 'ok' | 'hang' | 'body-hang' | 'error';
let mediaMode: 'hang' | 'body-hang' | 'error';
function rows() {
  return log.mock.calls
    .filter((a) => a[0] === '[line-latency]')
    .map((a) => JSON.parse(String(a[1])));
}
beforeEach(async () => {
  temp = mkdtempSync(join(tmpdir(), 'line-http-'));
  initSessions(temp);
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  replies = 0;
  replyMode = 'ok';
  mediaMode = 'hang';
  server = createServer((req, res) => {
    if (req.url === '/media') {
      if (mediaMode === 'body-hang') {
        res.writeHead(200);
        res.write('partial');
      }
      if (mediaMode === 'error') {
        res.writeHead(503);
        res.end('PRIVATE_UPSTREAM_BODY');
      }
      return;
    }
    replies++;
    if (replyMode === 'hang' && replies === 1) return;
    if (replyMode === 'body-hang' && replies === 1) {
      res.writeHead(200);
      res.write('{');
      return;
    }
    if (replyMode === 'error' && replies === 1) {
      res.writeHead(503);
      res.end('PRIVATE_UPSTREAM_BODY');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  baseURL = `http://127.0.0.1:${a.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  vi.restoreAllMocks();
  rmSync(temp, { recursive: true, force: true });
});
function ctx(): HandlerContext {
  return {
    path: '/webhook',
    channelSecret: 'secret',
    channelAccessToken: 'token',
    agentRunner: {
      runStream: vi.fn(async () => ({ result: 'reply', sessionId: 'test' })),
    } as never,
    resolver: {} as never,
    queue: new LineChatQueue(),
    imageSets: new LineImageSetBuffer(),
    client: createLineClient('PRIVATE_TOKEN', 80, baseURL),
    allowedUsers: [USER],
    allowAll: false,
    loadingAnimationEnabled: false,
    loadingAnimationSeconds: 60,
    slowResponseEnabled: false,
    slowResponseThresholdMs: 45000,
    idleResetEnabled: false,
    idleResetMs: 0,
    resetTextPatterns: [],
    completionDisplay: { showElapsed: true },
    completionNotifyAfterMs: 10_000,
    mediaTimeoutMs: 80,
  };
}
function event(id: string, media = false): webhook.Event {
  return {
    type: 'message',
    source: { type: 'user', userId: USER },
    replyToken: 'PRIVATE_REPLY_TOKEN',
    timestamp: Date.now(),
    message: media
      ? {
          type: 'image',
          id,
          contentProvider: { type: 'external', originalContentUrl: `${baseURL}/media` },
        }
      : { type: 'text', id, text: 'PRIVATE_TEXT' },
  } as webhook.Event;
}

describe('actual HTTP stalls release the LINE queue', () => {
  it('bounds every download in an image set and completes one turn', async () => {
    mediaMode = 'body-hang';
    const context = ctx();
    const first = event('image-1', true) as webhook.MessageEvent;
    const second = event('image-2', true) as webhook.MessageEvent;
    Object.assign(first.message, { imageSet: { id: 'set-1', index: 1, total: 2 } });
    Object.assign(second.message, { imageSet: { id: 'set-1', index: 2, total: 2 } });
    await Promise.all([handleLineEvent(first, context), handleLineEvent(second, context)]);
    expect(rows().filter((row) => row.stage === 'media_failure')).toHaveLength(2);
    expect(context.agentRunner.runStream).toHaveBeenCalledTimes(1);
    expect(context.queue.isBusy(`line:${USER}`)).toBe(false);
  });

  it.each(['hang', 'body-hang', 'error'] as const)(
    'bounds media %s and continues to the following message',
    async (mode) => {
      mediaMode = mode;
      const context = ctx();
      const first = handleLineEvent(event('image', true), context);
      const next = handleLineEvent(event('text'), context);
      await Promise.all([first, next]);
      expect(context.agentRunner.runStream).toHaveBeenCalledTimes(2);
      expect(context.queue.isBusy(`line:${USER}`)).toBe(false);
      const failure = rows().find((r) => r.stage === 'media_failure');
      expect(failure.errorKind).toBe(mode === 'error' ? 'http_error' : 'timeout');
      expect(failure.durationMs).toBeLessThan(1500);
      expect(rows().filter((r) => r.stage === 'send_success')).toHaveLength(2);
    }
  );

  it.each(['hang', 'body-hang', 'error'] as const)(
    'bounds reply %s without retrying and releases the next message',
    async (mode) => {
      replyMode = mode;
      const context = ctx();
      await Promise.all([
        handleLineEvent(event('first'), context),
        handleLineEvent(event('second'), context),
      ]);
      expect(context.agentRunner.runStream).toHaveBeenCalledTimes(2);
      expect(replies).toBe(2);
      expect(rows().filter((r) => r.stage === 'send_failure')).toHaveLength(1);
      expect(rows().filter((r) => r.stage === 'send_success')).toHaveLength(1);
      expect(JSON.stringify(rows())).not.toMatch(/PRIVATE_|Ubbbb/);
      expect(context.queue.isBusy(`line:${USER}`)).toBe(false);
    }
  );
});
