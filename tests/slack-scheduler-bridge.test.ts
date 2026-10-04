import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { AgentRunner } from '../src/agent-runner.js';
import type { Config } from '../src/config.js';
import { Scheduler } from '../src/scheduler.js';
import {
  initSessions,
  clearSessions,
  createSession,
  getActiveSessionId,
  getSessionEntry,
} from '../src/sessions.js';
import { registerSlackSchedulerBridge } from '../src/slack.js';

describe('registerSlackSchedulerBridge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'xangi-slack-scheduler-'));
    initSessions(tmpDir);
  });

  afterEach(() => {
    clearSessions();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes parent completion and progress to the original Slack thread', async () => {
    const scheduler = new Scheduler(tmpDir, { quiet: true });
    const postMessage = vi.fn().mockResolvedValue({ ts: '1700000000.000100' });
    const update = vi.fn().mockResolvedValue({});
    const runner = {
      runStream: vi.fn().mockResolvedValue({ result: 'done', sessionId: 'provider' }),
    } as unknown as AgentRunner;
    registerSlackSchedulerBridge({
      scheduler,
      client: { chat: { postMessage, update } } as unknown as WebClient,
      config: { agent: { config: {} } } as Config,
      agentRunner: runner,
    });
    await scheduler.getSender('slack')!('C123:1700.123', 'progress');
    expect(postMessage).toHaveBeenLastCalledWith({
      channel: 'C123',
      thread_ts: '1700.123',
      text: 'progress',
    });
    await scheduler.getAgentRunner('slack')!('child failed', 'C123:1700.123');
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ channel: 'C123', thread_ts: '1700.123' })
    );
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'C123' }));
    expect(runner.runStream).toHaveBeenCalledWith(
      'child failed',
      expect.anything(),
      expect.objectContaining({ channelId: 'C123:1700.123' })
    );
  });

  it('registers a Slack agent runner for scheduler and trigger paths', async () => {
    const interactiveId = createSession('C123', { platform: 'slack' });
    const interactiveBefore = structuredClone(getSessionEntry(interactiveId));
    const scheduler = new Scheduler(tmpDir, { quiet: true });
    const postMessage = vi.fn().mockResolvedValue({ ts: '1700000000.000100' });
    const update = vi.fn().mockResolvedValue({});
    const client = {
      chat: { postMessage, update },
    } as unknown as WebClient;
    const agentRunner = {
      runStream: vi.fn(async (_prompt, callbacks) => {
        callbacks.onToolUse?.('Read', { file_path: 'skills/xs-example/SKILL.md' });
        callbacks.onToolUse?.('Bash', { command: 'uv run example.py' });
        const result = {
          result: '**done** [Docs](https://example.com)',
          sessionId: 'provider-1',
        };
        callbacks.onComplete?.(result);
        return result;
      }),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: true } },
    } as Config;

    registerSlackSchedulerBridge({ scheduler, client, config, agentRunner });

    const runner = scheduler.getAgentRunner('slack');
    expect(runner).toBeDefined();

    const onDelivery = vi.fn();
    const result = await runner?.('trigger payload', 'C123', undefined, { onDelivery });

    expect(result).toBe('**done** [Docs](https://example.com)');
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: '🤔 考え中...',
      blocks: expect.any(Array),
    });
    const initialPayload = postMessage.mock.calls[0][0] as { blocks: unknown[] };
    expect(JSON.stringify(initialPayload.blocks)).toContain('Stop');
    expect(agentRunner.runStream).toHaveBeenCalledWith(
      'trigger payload',
      expect.any(Object),
      expect.objectContaining({
        skipPermissions: true,
        sessionId: undefined,
        channelId: 'C123',
        appSessionId: expect.stringMatching(/^scheduler-run-slack-/),
      })
    );
    const completedPayload = update.mock.calls.at(-1)?.[0] as {
      channel: string;
      ts: string;
      text: string;
      blocks: unknown[];
    };
    expect(completedPayload).toEqual({
      channel: 'C123',
      ts: '1700000000.000100',
      text: expect.any(String),
      blocks: [],
    });
    expect(completedPayload.text.replaceAll('\u200B', '')).toMatch(
      /^\*done\* <https:\/\/example\.com\|Docs>\n\n✅ 完了（⏱ /
    );
    expect(onDelivery).toHaveBeenCalledWith({
      platform: 'slack',
      destinationId: 'C123',
      messageIds: ['1700000000.000100'],
    });

    const activity = await import('../src/activity-store.js');
    const appSessionId = vi.mocked(agentRunner.runStream).mock.calls[0]?.[2]
      ?.appSessionId as string;
    const snapshot = activity.getActivity(`slack-schedule:${appSessionId}`);
    expect(snapshot?.toolLines).toEqual([
      'Read: skills/xs-example/SKILL.md',
      'Bash: uv run example.py',
    ]);
    expect(snapshot?.state).toBe('complete');
    expect(getActiveSessionId('C123')).toBe(interactiveId);
    expect(getSessionEntry(interactiveId)).toEqual(interactiveBefore);
    expect(getSessionEntry(appSessionId)).toMatchObject({
      scope: 'scheduler',
      lifecycle: 'closed',
      messageCount: 1,
    });
  });
});
