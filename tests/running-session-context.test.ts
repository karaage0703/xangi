import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRunningSession, resolveRunningSession } from '../src/running-session-context.js';
import { runWithBubbleEvents } from '../src/bubble-events-runner.js';
import { clearSessions, initSessions, createSchedulerSession, createSession, getActiveSessionId, getSessionEntry } from '../src/sessions.js';
import { executeProgressCardCommand } from '../src/progress-card-command.js';
import type { AgentRunner } from '../src/agent-runner.js';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'running-context-')); clearSessions(); initSessions(dir); });
afterEach(() => { clearSessions(); rmSync(dir, { recursive: true, force: true }); });

describe('running context through shared runner', () => {
  it.each(['discord', 'slack', 'line'] as const)('updates the %s reservation using the shared wrapper', async platform => {
    const interactive = createSession('channel', { platform });
    createSchedulerSession('scheduled', 'channel', { platform, title: '予約' });
    const runner = { runStream: async () => {
      executeProgressCardCommand({ note: 'working' }, { channelId: 'channel', platform });
      return { result: 'done', sessionId: 'provider' };
    } } as unknown as AgentRunner;
    await runWithBubbleEvents(runner, 'work', { threadId: 'thread', turnId: 'turn', platform }, {}, { channelId: 'channel', appSessionId: 'scheduled' });
    expect(getSessionEntry('scheduled')?.progressCard?.note).toBe('working');
    expect(getSessionEntry(interactive)?.progressCard).toBeUndefined();
    expect(getActiveSessionId('channel')).toBe(interactive);
    expect(resolveRunningSession('channel')).toBeUndefined();
  });

  it.each(['failure', 'Request cancelled by user'])('cleans context after %s', async reason => {
    createSchedulerSession('scheduled', 'channel', { platform: 'discord', title: '予約' });
    const runner = { runStream: async () => {
      expect(resolveRunningSession('channel')).toBe('scheduled');
      throw new Error(reason);
    } } as unknown as AgentRunner;
    await expect(runWithBubbleEvents(runner, 'work', { threadId: 'thread', turnId: 'turn', platform: 'discord' }, {}, { channelId: 'channel', appSessionId: 'scheduled' })).rejects.toThrow(reason);
    expect(resolveRunningSession('channel')).toBeUndefined();
  });

  it('keeps duplicate registrations until both release and isolates channels', () => {
    createSchedulerSession('scheduled', 'channel', { platform: 'discord', title: '予約' });
    const a = registerRunningSession('channel', 'scheduled');
    const b = registerRunningSession('channel', 'scheduled');
    try {
      a(); a();
      expect(resolveRunningSession('channel')).toBe('scheduled');
      expect(resolveRunningSession('another')).toBeUndefined();
      expect(() => resolveRunningSession('channel', 'slack')).toThrow('does not match');
    } finally { a(); b(); }
    expect(resolveRunningSession('channel')).toBeUndefined();
  });
});
