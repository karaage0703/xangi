import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { webhook } from '@line/bot-sdk';
import { initSessions } from '../src/sessions.js';
import { handleLineEvent, LineChatQueue, LineImageSetBuffer } from '../src/line.js';

const USER = 'U0123456789abcdef0123456789abcdef';
const OTHER_USER = 'Ufedcba9876543210fedcba9876543210';
const SET = 'S0123456789abcdef';

let tempDir: string;
/** downloadFile が作ったファイルのパス。取得回数の確認にも使う */
const downloads: string[] = [];
/** 取得に時間をかけたいテストだけが上げる */
let downloadDelayMs = 0;

// 実ネットワークと実ダウンロード先を触らない
vi.mock('../src/file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/file-utils.js')>();
  return {
    ...actual,
    downloadFile: vi.fn(async (_url: string, filename: string) => {
      if (downloadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, downloadDelayMs));
      const path = join(tempDir, `${downloads.length}_${filename}`);
      writeFileSync(path, 'x');
      downloads.push(path);
      return path;
    }),
  };
});

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function imageEvent(
  messageId: string,
  imageSet?: { id: string; index?: number; total?: number },
  userId: string = USER
): webhook.Event {
  return {
    type: 'message',
    message: { type: 'image', id: messageId, ...(imageSet ? { imageSet } : {}) },
    source: { type: 'user', userId },
    replyToken: `rt_${messageId}`,
  } as unknown as webhook.Event;
}

function textEvent(text: string, messageId: string): webhook.Event {
  return {
    type: 'message',
    message: { type: 'text', id: messageId, text },
    source: { type: 'user', userId: USER },
    replyToken: `rt_${messageId}`,
  } as unknown as webhook.Event;
}

interface Harness {
  ctx: Parameters<typeof handleLineEvent>[1];
  runStream: ReturnType<typeof vi.fn>;
  fetched: string[];
  replies: Array<{ token: string; text: string }>;
  pushes: string[];
}

/** fetchLineMedia は downloadFile 経由。DOWNLOAD_DIR 配下に実ファイルを作らせる */
function createHarness(opts?: {
  run?: () => Promise<void>;
  slowResponseThresholdMs?: number;
  idleResetHours?: number;
}): Harness {
  const fetched: string[] = [];
  const replies: Array<{ token: string; text: string }> = [];
  const pushes: string[] = [];

  const runStream = vi.fn(async (prompt: string) => {
    await (opts?.run?.() ?? Promise.resolve());
    return { result: `答え: ${prompt}`, sessionId: 'provider-session' };
  });

  const client = {
    replyMessage: vi.fn(async (args: { replyToken: string; messages: Array<{ text: string }> }) => {
      replies.push({ token: args.replyToken, text: args.messages[0].text });
    }),
    pushMessage: vi.fn(async (args: { messages: Array<{ text: string }> }) => {
      pushes.push(args.messages[0].text);
    }),
    showLoadingAnimation: vi.fn(async () => undefined),
  };

  const ctx = {
    path: '/webhook',
    channelSecret: 'secret',
    channelAccessToken: 'tok',
    agentRunner: { runStream } as never,
    resolver: {} as never,
    client: client as never,
    queue: new LineChatQueue(),
    imageSets: new LineImageSetBuffer(),
    allowedUsers: ['*'],
    allowAll: true,
    loadingAnimationEnabled: false,
    loadingAnimationSeconds: 60,
    slowResponseEnabled: true,
    slowResponseThresholdMs: opts?.slowResponseThresholdMs ?? 60_000,
    idleResetEnabled: opts?.idleResetHours !== undefined,
    idleResetMs: (opts?.idleResetHours ?? 0) * 3600 * 1000,
    resetTextPatterns: ['/reset', '/new', '/clear'],
    completionDisplay: { showElapsed: false },
    completionNotifyAfterMs: 10_000,
  } as unknown as Parameters<typeof handleLineEvent>[1];

  return { ctx, runStream, fetched, replies, pushes };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'line-imageset-'));
  downloads.length = 0;
  downloadDelayMs = 0;
  initSessions(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('LINE の同時送信画像の束ね', () => {
  it('同時送信の3枚は1ターンにまとまる', async () => {
    const h = createHarness();
    for (const i of [1, 2, 3]) {
      await handleLineEvent(imageEvent(`m${i}`, { id: SET, index: i, total: 3 }), h.ctx);
    }
    await tick();

    expect(h.runStream).toHaveBeenCalledTimes(1);
    const prompt = h.runStream.mock.calls[0][0] as string;
    expect(prompt.match(/line_m[123]\./g)).toHaveLength(3);
  });

  it('添付はindex順に並ぶ', async () => {
    const h = createHarness();
    for (const i of [2, 1, 3]) {
      await handleLineEvent(imageEvent(`m${i}`, { id: SET, index: i, total: 3 }), h.ctx);
    }
    await tick();

    const prompt = h.runStream.mock.calls[0][0] as string;
    expect(prompt.match(/line_m[123]\./g)).toEqual(['line_m1.', 'line_m2.', 'line_m3.']);
  });

  it('揃うまでターンを起動しない', async () => {
    const h = createHarness();
    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    await handleLineEvent(imageEvent('m2', { id: SET, index: 2, total: 3 }), h.ctx);
    await tick();

    expect(h.runStream).toHaveBeenCalledTimes(0);
  });

  it('imageSetの無い画像は待たない', async () => {
    const h = createHarness();
    await handleLineEvent(imageEvent('m1'), h.ctx);
    await tick();

    expect(h.runStream).toHaveBeenCalledTimes(1);
  });

  it('別のセットは別ターンになる', async () => {
    const h = createHarness();
    await handleLineEvent(imageEvent('a1', { id: 'SA', index: 1, total: 2 }), h.ctx);
    await handleLineEvent(imageEvent('b1', { id: 'SB', index: 1, total: 2 }), h.ctx);
    await handleLineEvent(imageEvent('a2', { id: 'SA', index: 2, total: 2 }), h.ctx);
    await handleLineEvent(imageEvent('b2', { id: 'SB', index: 2, total: 2 }), h.ctx);
    await tick();

    expect(h.runStream).toHaveBeenCalledTimes(2);
    for (const call of h.runStream.mock.calls) {
      expect((call[0] as string).match(/line_[ab][12]\./g)).toHaveLength(2);
    }
  });

  it('束ねたターンの返信は1回', async () => {
    const h = createHarness();
    for (const i of [1, 2, 3]) {
      await handleLineEvent(imageEvent(`m${i}`, { id: SET, index: i, total: 3 }), h.ctx);
    }
    await tick();

    expect(h.replies).toHaveLength(1);
    expect(h.pushes).toHaveLength(0);
  });

  it('返信は最後に届いたイベントのreplyTokenを使う', async () => {
    const h = createHarness();
    for (const i of [1, 2, 3]) {
      await handleLineEvent(imageEvent(`m${i}`, { id: SET, index: i, total: 3 }), h.ctx);
    }
    await tick();

    expect(h.replies[0].token).toBe('rt_m3');
  });

  it('揃わないまま45秒で待機の通知を1回だけ送る', async () => {
    const h = createHarness({ slowResponseThresholdMs: 100 });
    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    await handleLineEvent(imageEvent('m2', { id: SET, index: 2, total: 3 }), h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(h.replies).toHaveLength(1);
    expect(h.replies[0].token).toBe('rt_m2');
    expect(h.runStream).toHaveBeenCalledTimes(0);
  });

  it('到着が続くあいだは待機の通知を送らない', async () => {
    const h = createHarness({ slowResponseThresholdMs: 200 });
    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 140));
    await handleLineEvent(imageEvent('m2', { id: SET, index: 2, total: 3 }), h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 140));

    expect(h.replies).toHaveLength(0);
  });

  it('早く終わったターンでは通知を送らない', async () => {
    const h = createHarness({ slowResponseThresholdMs: 300 });
    for (const i of [1, 2, 3]) {
      await handleLineEvent(imageEvent(`m${i}`, { id: SET, index: i, total: 3 }), h.ctx);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(h.replies).toHaveLength(1);
    expect(h.replies[0].text.startsWith('答え:')).toBe(true);
  });

  it('揃ったあとにターンが長引けば考え中を送る', async () => {
    const gate = { resolve: () => {} };
    const promise = new Promise<void>((res) => {
      gate.resolve = res;
    });
    const h = createHarness({ slowResponseThresholdMs: 100, run: () => promise });

    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    await handleLineEvent(imageEvent('m2', { id: SET, index: 2, total: 3 }), h.ctx);
    // 3枚目でターンが始まり、ゲートで止まる。await するとテストが進まない
    void handleLineEvent(imageEvent('m3', { id: SET, index: 3, total: 3 }), h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0].text).toContain('考えてる');

    gate.resolve();
    await tick();
    expect(h.pushes).toHaveLength(1);
  });

  it('揃わないセットは次の発言へ合流する', async () => {
    const h = createHarness();
    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    await handleLineEvent(imageEvent('m2', { id: SET, index: 2, total: 3 }), h.ctx);
    await handleLineEvent(textEvent('これ何？', 'm9'), h.ctx);
    await tick();

    expect(h.runStream).toHaveBeenCalledTimes(1);
    const prompt = h.runStream.mock.calls[0][0] as string;
    expect(prompt).toContain('これ何？');
    expect(prompt.match(/line_m[12]\./g)).toHaveLength(2);
  });

  it('揃わないセットは次の画像へ合流する', async () => {
    const h = createHarness();
    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    await handleLineEvent(imageEvent('m2'), h.ctx);
    await tick();

    expect(h.runStream).toHaveBeenCalledTimes(1);
    const prompt = h.runStream.mock.calls[0][0] as string;
    expect(prompt.match(/line_m[12]\./g)).toEqual(['line_m1.', 'line_m2.']);
  });

  it('idle_resetで控えを捨てる', async () => {
    const h = createHarness({ idleResetHours: 0.0000001 });
    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    await handleLineEvent(imageEvent('m2', { id: SET, index: 2, total: 3 }), h.ctx);
    expect(downloads).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handleLineEvent(textEvent('おはよう', 'm9'), h.ctx);
    await tick();

    const prompt = h.runStream.mock.calls[0][0] as string;
    expect(prompt).not.toContain('line_m1');
    expect(downloads.filter((path) => existsSync(path))).toHaveLength(0);
  });

  it('resetコマンドで控えを捨てる', async () => {
    const h = createHarness();
    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    await handleLineEvent(imageEvent('m2', { id: SET, index: 2, total: 3 }), h.ctx);
    expect(downloads).toHaveLength(2);

    await handleLineEvent(textEvent('/new', 'm8'), h.ctx);
    await handleLineEvent(textEvent('おはよう', 'm9'), h.ctx);
    await tick();

    const prompt = h.runStream.mock.calls[0][0] as string;
    expect(prompt).not.toContain('line_m1');
    expect(downloads.filter((path) => existsSync(path))).toHaveLength(0);
  });

  it('リセットと競合して取得が終わった分もファイルを残さない', async () => {
    const h = createHarness();
    downloadDelayMs = 60;
    const inFlight = handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    downloadDelayMs = 0;
    await handleLineEvent(textEvent('/new', 'm8'), h.ctx);
    await inFlight;
    await tick();

    expect(downloads).toHaveLength(1);
    expect(downloads.filter((path) => existsSync(path))).toHaveLength(0);
  });

  it('同じセットIDでも別ユーザーの画像は混ざらない', async () => {
    const h = createHarness();
    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 2 }), h.ctx);
    await handleLineEvent(imageEvent('m2', { id: SET, index: 2, total: 2 }, OTHER_USER), h.ctx);
    await tick();

    expect(h.runStream).toHaveBeenCalledTimes(0);
  });

  it('再送で揃えば1ターンにまとまる', async () => {
    const h = createHarness({ slowResponseThresholdMs: 100 });
    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    await handleLineEvent(imageEvent('m2', { id: SET, index: 2, total: 3 }), h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(h.replies).toHaveLength(1);

    await handleLineEvent(imageEvent('m3', { id: SET, index: 3, total: 3 }), h.ctx);
    await tick();

    expect(h.runStream).toHaveBeenCalledTimes(1);
    expect((h.runStream.mock.calls[0][0] as string).match(/line_m[123]\./g)).toHaveLength(3);
  });

  it('同じwebhookで並行に届いても待機の通知が出ない', async () => {
    const h = createHarness({ slowResponseThresholdMs: 100 });
    // handleRequest は 1 回の webhook に入った複数イベントを待ち合わせずに回す
    await Promise.all(
      [1, 2, 3].map((i) =>
        handleLineEvent(imageEvent(`m${i}`, { id: SET, index: i, total: 3 }), h.ctx)
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(h.runStream).toHaveBeenCalledTimes(1);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0].text.startsWith('答え:')).toBe(true);
  });

  it('揃う前に届いた分の取得が始まる', async () => {
    const h = createHarness();
    await handleLineEvent(imageEvent('m1', { id: SET, index: 1, total: 3 }), h.ctx);
    await handleLineEvent(imageEvent('m2', { id: SET, index: 2, total: 3 }), h.ctx);
    await tick();

    expect(downloads).toHaveLength(2);
    expect(h.runStream).toHaveBeenCalledTimes(0);
  });
});
