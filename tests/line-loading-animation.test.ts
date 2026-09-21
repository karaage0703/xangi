import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { webhook } from '@line/bot-sdk';
import { initSessions } from '../src/sessions.js';
import { handleLineEvent, LineChatQueue, LineImageSetBuffer } from '../src/line.js';

const USER = 'U0123456789abcdef0123456789abcdef';

let tempDir: string;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function textEvent(text: string, messageId: string): webhook.Event {
  return {
    type: 'message',
    message: { type: 'text', id: messageId, text },
    source: { type: 'user', userId: USER },
    replyToken: `rt_${messageId}`,
  } as unknown as webhook.Event;
}

function createHarness(run: () => Promise<void>, loadingAnimationEnabled = true) {
  const showLoadingAnimation = vi.fn(async () => undefined);
  const client = {
    replyMessage: vi.fn(async () => undefined),
    pushMessage: vi.fn(async () => undefined),
    showLoadingAnimation,
  };
  const ctx = {
    path: '/webhook',
    channelSecret: 'secret',
    agentRunner: {
      runStream: vi.fn(async (prompt: string) => {
        await run();
        return { result: `答え: ${prompt}`, sessionId: 'provider-session' };
      }),
    } as never,
    resolver: {} as never,
    client: client as never,
    queue: new LineChatQueue(),
    imageSets: new LineImageSetBuffer(),
    allowedUsers: ['*'],
    allowAll: true,
    loadingAnimationEnabled,
    loadingAnimationSeconds: 60,
    slowResponseEnabled: false,
    slowResponseThresholdMs: 45000,
    idleResetEnabled: false,
    idleResetMs: 0,
    resetTextPatterns: ['/reset', '/new', '/clear'],
    completionDisplay: { showElapsed: false },
    completionNotifyAfterMs: 10_000,
  } as unknown as Parameters<typeof handleLineEvent>[1];

  return { ctx, showLoadingAnimation };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'line-loading-'));
  initSessions(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('LINE のローディング表示', () => {
  it('No.1 待機したターンは処理開始時にローディングを出し直す', async () => {
    const gate = deferred();
    const h = createHarness(() => gate.promise);

    const first = handleLineEvent(textEvent('1通目', 'm1'), h.ctx);
    await tick();
    const second = handleLineEvent(textEvent('2通目', 'm2'), h.ctx);
    await tick();
    gate.resolve();
    await first;
    await second;

    expect(h.showLoadingAnimation).toHaveBeenCalledTimes(3);
  });

  it('No.2 待機しなかったターンは受信時の1回だけ', async () => {
    const h = createHarness(async () => undefined);

    await handleLineEvent(textEvent('こんにちは', 'm1'), h.ctx);

    expect(h.showLoadingAnimation).toHaveBeenCalledTimes(1);
  });

  it('No.3 リセットで無効化されたターンはローディングを出し直さない', async () => {
    const gate = deferred();
    const h = createHarness(() => gate.promise);

    const first = handleLineEvent(textEvent('1通目', 'm1'), h.ctx);
    await tick();
    const second = handleLineEvent(textEvent('2通目', 'm2'), h.ctx);
    await tick();
    await handleLineEvent(textEvent('/reset', 'm3'), h.ctx);
    gate.resolve();
    await first;
    await second;

    expect(h.showLoadingAnimation).toHaveBeenCalledTimes(2);
  });

  it('No.4 ローディング無効時は一度も呼ばない', async () => {
    const gate = deferred();
    const h = createHarness(() => gate.promise, false);

    const first = handleLineEvent(textEvent('1通目', 'm1'), h.ctx);
    await tick();
    const second = handleLineEvent(textEvent('2通目', 'm2'), h.ctx);
    await tick();
    gate.resolve();
    await first;
    await second;

    expect(h.showLoadingAnimation).toHaveBeenCalledTimes(0);
  });
});
