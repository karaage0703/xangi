import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { AgentRunner } from '../src/agent-runner.js';
import type { Config } from '../src/config.js';
import { Scheduler } from '../src/scheduler.js';
import { initSessions, clearSessions } from '../src/sessions.js';
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

  it('registers a Slack agent runner for scheduler and trigger paths', async () => {
    const scheduler = new Scheduler(tmpDir, { quiet: true });
    const postMessage = vi.fn().mockResolvedValue({ ts: '1700000000.000100' });
    const update = vi.fn().mockResolvedValue({});
    const client = {
      chat: { postMessage, update },
    } as unknown as WebClient;
    const agentRunner = {
      run: vi.fn().mockResolvedValue({ result: 'done', sessionId: 'provider-1' }),
    } as unknown as AgentRunner;
    const config = {
      agent: { config: { skipPermissions: true } },
    } as Config;

    registerSlackSchedulerBridge({ scheduler, client, config, agentRunner });

    const runner = scheduler.getAgentRunner('slack');
    expect(runner).toBeDefined();

    const result = await runner?.('trigger payload', 'C123');

    expect(result).toBe('done');
    expect(postMessage).toHaveBeenCalledWith({ channel: 'C123', text: '🤔 考え中...' });
    expect(agentRunner.run).toHaveBeenCalledWith(
      'trigger payload',
      expect.objectContaining({
        skipPermissions: true,
        sessionId: undefined,
        channelId: 'C123',
      })
    );
    expect(update).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '1700000000.000100',
      text: 'done',
    });
  });
});
