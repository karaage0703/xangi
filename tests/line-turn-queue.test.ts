import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { webhook } from '@line/bot-sdk';
import { initSessions } from '../src/sessions.js';
import { handleLineEvent, LineChatQueue, LineImageSetBuffer } from '../src/line.js';

const USER_A = 'U0123456789abcdef0123456789abcdef';
const USER_B = 'Ufedcba9876543210fedcba9876543210';

let tempDir: string;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** マイクロタスクとタイマーを1巡させる */
async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function textEvent(userId: string, text: string, messageId: string): webhook.Event {
  return {
    type: 'message',
    message: { type: 'text', id: messageId, text },
    source: { type: 'user', userId },
    replyToken: `rt_${messageId}`,
  } as unknown as webhook.Event;
}

interface Harness {
  ctx: Parameters<typeof handleLineEvent>[1];
  runStream: ReturnType<typeof vi.fn>;
  replies: string[];
  pushes: string[];
  /** 同時に走っていたランの最大数 */
  maxConcurrent: () => number;
}

function createHarness(run: (prompt: string) => Promise<void>): Harness {
  const replies: string[] = [];
  const pushes: string[] = [];
  let inFlight = 0;
  let peak = 0;

  const runStream = vi.fn(async (prompt: string) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      await run(prompt);
      return { result: `答え: ${prompt}`, sessionId: 'provider-session' };
    } finally {
      inFlight -= 1;
    }
  });

  const client = {
    replyMessage: vi.fn(async (args: { messages: Array<{ text: string }> }) => {
      replies.push(args.messages[0].text);
    }),
    pushMessage: vi.fn(async (args: { messages: Array<{ text: string }> }) => {
      pushes.push(args.messages[0].text);
    }),
    showLoadingAnimation: vi.fn(async () => undefined),
  };

  const ctx = {
    path: '/webhook',
    channelSecret: 'secret',
    agentRunner: { runStream } as never,
    resolver: {} as never,
    client: client as never,
    queue: new LineChatQueue(),
    imageSets: new LineImageSetBuffer(),
    allowedUsers: ['*'],
    allowAll: true,
    loadingAnimationEnabled: false,
    loadingAnimationSeconds: 60,
    slowResponseEnabled: false,
    slowResponseThresholdMs: 45000,
    idleResetEnabled: false,
    idleResetMs: 0,
    resetTextPatterns: ['/reset', '/new', '/clear'],
    completionDisplay: { showElapsed: false },
    completionNotifyAfterMs: 10_000,
  } as unknown as Parameters<typeof handleLineEvent>[1];

  return { ctx, runStream, replies, pushes, maxConcurrent: () => peak };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'line-queue-'));
  initSessions(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('LINE の同一ユーザーのターン直列化', () => {
  it('No.1 実行中の追加メッセージは完了まで起動しない', async () => {
    const gate = deferred();
    const h = createHarness(() => gate.promise);

    void handleLineEvent(textEvent(USER_A, '1通目', 'm1'), h.ctx);
    await tick();
    void handleLineEvent(textEvent(USER_A, '2通目', 'm2'), h.ctx);
    await tick();

    expect(h.runStream).toHaveBeenCalledTimes(1);

    gate.resolve();
    await tick();
  });

  it('No.2 1通目の完了後に2通目が起動する', async () => {
    const gate = deferred();
    const h = createHarness(() => gate.promise);

    const first = handleLineEvent(textEvent(USER_A, '1通目', 'm1'), h.ctx);
    await tick();
    const second = handleLineEvent(textEvent(USER_A, '2通目', 'm2'), h.ctx);
    await tick();

    gate.resolve();
    await first;
    await second;

    expect(h.runStream).toHaveBeenCalledTimes(2);
    expect(h.runStream.mock.calls[1][0]).toBe('2通目');
  });

  it('No.3 実行中でなければ即座に起動する', async () => {
    const h = createHarness(async () => undefined);

    await handleLineEvent(textEvent(USER_A, 'こんにちは', 'm1'), h.ctx);

    expect(h.runStream).toHaveBeenCalledTimes(1);
    expect(h.replies).toEqual(['答え: こんにちは']);
  });

  it('No.4 別ユーザーは互いに待たされない', async () => {
    const gate = deferred();
    const h = createHarness((prompt) => (prompt === 'Aの発言' ? gate.promise : Promise.resolve()));

    void handleLineEvent(textEvent(USER_A, 'Aの発言', 'm1'), h.ctx);
    await tick();
    await handleLineEvent(textEvent(USER_B, 'Bの発言', 'm2'), h.ctx);

    expect(h.runStream).toHaveBeenCalledTimes(2);
    expect(h.replies).toEqual(['答え: Bの発言']);

    gate.resolve();
    await tick();
  });

  it('No.5 キューを持たないランナーでもランが同時に走らない', async () => {
    const gate = deferred();
    const h = createHarness(() => gate.promise);

    const first = handleLineEvent(textEvent(USER_A, '1通目', 'm1'), h.ctx);
    await tick();
    const second = handleLineEvent(textEvent(USER_A, '2通目', 'm2'), h.ctx);
    await tick();
    gate.resolve();
    await first;
    await second;

    expect(h.maxConcurrent()).toBe(1);
  });

  it('No.6 リセットコマンドは完了を待たずに応答する', async () => {
    const gate = deferred();
    const h = createHarness(() => gate.promise);

    const first = handleLineEvent(textEvent(USER_A, '1通目', 'm1'), h.ctx);
    await tick();
    await handleLineEvent(textEvent(USER_A, '/reset', 'm2'), h.ctx);

    expect(h.replies).toEqual(['最初からお話するね！何かあった？']);

    gate.resolve();
    await first;
  });

  it('No.7 リセット後は待機中の発言が実行されない', async () => {
    const gate = deferred();
    const h = createHarness(() => gate.promise);

    const first = handleLineEvent(textEvent(USER_A, '1通目', 'm1'), h.ctx);
    await tick();
    const second = handleLineEvent(textEvent(USER_A, '2通目', 'm2'), h.ctx);
    await tick();
    await handleLineEvent(textEvent(USER_A, '/reset', 'm3'), h.ctx);

    gate.resolve();
    await first;
    await second;

    expect(h.runStream).toHaveBeenCalledTimes(1);
    expect(h.runStream.mock.calls[0][0]).toBe('1通目');
  });

  it('No.8 ランが失敗してもキューが止まらない', async () => {
    const h = createHarness((prompt) => {
      if (prompt === '1通目') return Promise.reject(new Error('boom'));
      return Promise.resolve();
    });

    const first = handleLineEvent(textEvent(USER_A, '1通目', 'm1'), h.ctx);
    await tick();
    const second = handleLineEvent(textEvent(USER_A, '2通目', 'm2'), h.ctx);
    await first;
    await second;

    expect(h.runStream).toHaveBeenCalledTimes(2);
    expect(h.replies).toEqual(['ごめんなさい、ちょっと調子わるいみたい…', '答え: 2通目']);
  });
});

it('passes app-server selection only from the interactive LINE context', async () => {
  const h = createHarness(async () => {});
  h.ctx.codexTransport = 'app-server';
  await handleLineEvent(textEvent(USER_A, 'hello', 'transport-test'), h.ctx);
  await tick();
  expect(h.runStream).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(Object),
    expect.objectContaining({ codexLineTransport: 'app-server' })
  );
});
