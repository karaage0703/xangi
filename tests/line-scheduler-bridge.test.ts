import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineBotClient } from '@line/bot-sdk';
import type { AgentRunner } from '../src/agent-runner.js';
import { Scheduler } from '../src/scheduler.js';
import {
  initSessions,
  clearSessions,
  createSession,
  getActiveSessionId,
  getSessionEntry,
} from '../src/sessions.js';
import {
  LineChatQueue,
  parseLineScheduleTarget,
  registerLineSchedulerBridge,
} from '../src/line.js';

const USER_ID = `U${'a'.repeat(32)}`;
const CONTEXT_KEY = `line:${USER_ID}`;

function createClient(): { client: LineBotClient; pushMessage: ReturnType<typeof vi.fn> } {
  const pushMessage = vi.fn().mockResolvedValue({});
  return { client: { pushMessage } as unknown as LineBotClient, pushMessage };
}

function createRunner(result: string): AgentRunner {
  return {
    runStream: vi.fn(async (_prompt, callbacks) => {
      const payload = { result, sessionId: 'provider-1' };
      callbacks.onComplete?.(payload);
      return payload;
    }),
  } as unknown as AgentRunner;
}

describe('parseLineScheduleTarget', () => {
  it('accepts the contextKey form produced by XANGI_CHANNEL_ID', () => {
    expect(parseLineScheduleTarget(CONTEXT_KEY)).toEqual({
      userId: USER_ID,
      contextKey: CONTEXT_KEY,
    });
  });

  it('accepts a bare LINE userId', () => {
    expect(parseLineScheduleTarget(USER_ID)).toEqual({
      userId: USER_ID,
      contextKey: CONTEXT_KEY,
    });
  });

  it('rejects an id that is not a LINE userId', () => {
    expect(() => parseLineScheduleTarget('C123')).toThrow(/Unsupported schedule channelId/);
  });
});

describe('registerLineSchedulerBridge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'xangi-line-scheduler-'));
    initSessions(tmpDir);
  });

  afterEach(() => {
    clearSessions();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pushes scheduled messages and splits beyond the LINE 5000 char limit', async () => {
    const scheduler = new Scheduler(tmpDir, { quiet: true });
    const { client, pushMessage } = createClient();
    registerLineSchedulerBridge({
      scheduler,
      client,
      queue: new LineChatQueue(),
      agentRunner: createRunner('unused'),
      allowedUsers: [USER_ID],
      allowAll: false,
    });

    const sender = scheduler.getSender('line');
    expect(sender).toBeDefined();

    await sender?.(CONTEXT_KEY, 'reminder');
    expect(pushMessage).toHaveBeenCalledWith({
      to: USER_ID,
      messages: [{ type: 'text', text: 'reminder' }],
    });

    pushMessage.mockClear();
    const long = Array.from({ length: 600 }, () => '0123456789').join('\n');
    await sender?.(USER_ID, long);
    expect(pushMessage.mock.calls.length).toBeGreaterThan(1);
    for (const [payload] of pushMessage.mock.calls) {
      const { text } = (payload as { messages: Array<{ text: string }> }).messages[0];
      expect(text.length).toBeLessThanOrEqual(5000);
    }
  });

  it('runs the agent for a contextKey channelId and pushes the result with elapsed time', async () => {
    const interactiveId = createSession(CONTEXT_KEY, { platform: 'line' });
    const interactiveBefore = structuredClone(getSessionEntry(interactiveId));
    const scheduler = new Scheduler(tmpDir, { quiet: true });
    const { client, pushMessage } = createClient();
    const agentRunner = createRunner('おはよう');

    registerLineSchedulerBridge({
      scheduler,
      client,
      queue: new LineChatQueue(),
      agentRunner,
      allowedUsers: [USER_ID],
      allowAll: false,
    });

    const runner = scheduler.getAgentRunner('line');
    expect(runner).toBeDefined();

    const onStart = vi.fn();
    const onDelivery = vi.fn();
    const result = await runner?.('今日の予定', CONTEXT_KEY, undefined, { onStart, onDelivery });

    // scheduler はログ用途で生の結果を受け取る（Discord / Slack と同じ規約）
    expect(result).toBe('おはよう');
    expect(vi.mocked(agentRunner.runStream).mock.calls[0][2]?.codexLineTransport).toBeUndefined();
    expect(onStart).toHaveBeenCalledOnce();
    expect(onDelivery).toHaveBeenCalledWith({ platform: 'line', destinationId: USER_ID });

    const pushed = pushMessage.mock.calls[0][0] as {
      to: string;
      messages: Array<{ text: string }>;
    };
    expect(pushed.to).toBe(USER_ID);
    expect(pushed.messages[0].text.replaceAll('​', '')).toMatch(/^おはよう\n\n✅ 完了（⏱ /);

    expect(agentRunner.runStream).toHaveBeenCalledWith(
      '今日の予定',
      expect.any(Object),
      expect.objectContaining({
        channelId: CONTEXT_KEY,
        appSessionId: expect.stringMatching(/^scheduler-run-line-/),
      })
    );

    // スケジュール実行は対話セッションを奪わず、専用セッションを閉じて終わる
    const appSessionId = vi.mocked(agentRunner.runStream).mock.calls[0]?.[2]
      ?.appSessionId as string;
    expect(getActiveSessionId(CONTEXT_KEY)).toBe(interactiveId);
    expect(getSessionEntry(interactiveId)).toEqual(interactiveBefore);
    expect(getSessionEntry(appSessionId)).toMatchObject({
      scope: 'scheduler',
      lifecycle: 'closed',
    });
  });

  it('pushes the fallback text and rethrows so the scheduler can decide on a retry', async () => {
    const scheduler = new Scheduler(tmpDir, { quiet: true });
    const { client, pushMessage } = createClient();
    const failure = new Error('backend exploded');
    const agentRunner = {
      runStream: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as AgentRunner;

    registerLineSchedulerBridge({
      scheduler,
      client,
      queue: new LineChatQueue(),
      agentRunner,
      allowedUsers: [USER_ID],
      allowAll: false,
    });

    const runner = scheduler.getAgentRunner('line');
    await expect(runner?.('壊れる指示', USER_ID)).rejects.toThrow('backend exploded');

    const pushed = pushMessage.mock.calls.at(-1)?.[0] as { messages: Array<{ text: string }> };
    expect(pushed.messages[0].text).toContain('ごめんなさい');
  });

  it('rejects scheduled targets outside the LINE allowlist before running the agent', async () => {
    const scheduler = new Scheduler(tmpDir, { quiet: true });
    const { client, pushMessage } = createClient();
    const agentRunner = createRunner('must not run');
    registerLineSchedulerBridge({
      scheduler,
      client,
      queue: new LineChatQueue(),
      agentRunner,
      allowedUsers: [],
      allowAll: false,
    });

    await expect(scheduler.getSender('line')?.(USER_ID, 'reminder')).rejects.toMatchObject({
      name: 'NonRetryableError',
      retryable: false,
    });
    await expect(scheduler.getAgentRunner('line')?.('run', USER_ID)).rejects.toMatchObject({
      name: 'NonRetryableError',
      retryable: false,
    });
    expect(agentRunner.runStream).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('reports final delivery failure without retrying the completed agent run', async () => {
    const scheduler = new Scheduler(tmpDir, { quiet: true });
    const pushFailure = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    const pushMessage = vi.fn().mockRejectedValue(pushFailure);
    const client = { pushMessage } as unknown as LineBotClient;
    const agentRunner = createRunner('generated once');
    registerLineSchedulerBridge({
      scheduler,
      client,
      queue: new LineChatQueue(),
      agentRunner,
      allowedUsers: [USER_ID],
      allowAll: false,
    });

    await expect(scheduler.getAgentRunner('line')?.('run', USER_ID)).rejects.toMatchObject({
      name: 'NonRetryableError',
      retryable: false,
    });
    expect(agentRunner.runStream).toHaveBeenCalledOnce();
    expect(pushMessage).toHaveBeenCalledOnce();
  });
});
