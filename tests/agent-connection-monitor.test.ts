import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentConnectionMonitor,
  connectionSessionId,
  createConnectionMonitorPublisher,
  installAgentConnectionMonitorWorker,
} from '../src/agent-connection-monitor.js';
import { startActivity, updateActivityTool, clearActivities } from '../src/activity-store.js';

const row = (id = 'same') => ({
  id,
  title: 'Dedicated conversation',
  platform: 'discord',
  contextKey: 'same-channel',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:01:00Z',
  lifecycle: 'open',
  isActive: true,
  isCurrent: true,
  activity: {
    state: 'tool',
    active: true,
    summary: 'Testing',
    toolLines: ['run tests'],
    history: [{ state: 'tool', summary: 'Testing', at: 1 }],
  },
});
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'connection-monitor-'));
  vi.stubEnv('WORKSPACE_PATH', directory);
  vi.stubEnv('DATA_DIR', directory);
});
afterEach(() => {
  vi.useRealTimers();
  clearActivities();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it('keeps connections and activity identities separate, including a shared channel/session', () => {
  const store = new AgentConnectionMonitor();
  const changed = vi.fn();
  store.subscribe(changed);
  for (const id of ['a', 'b'])
    store.receive(id, 'agent-' + id, { type: 'agent-connection-monitor', sessions: [row()] });
  expect(store.sessions()).toHaveLength(2);
  expect(store.sessions().map((s) => s.id)).toEqual([
    connectionSessionId('a', 'same'),
    connectionSessionId('b', 'same'),
  ]);
  expect(store.sessions().map((s) => s.selectedAgentId)).toEqual(['agent-a', 'agent-b']);
  expect(store.sessions()[0].contextKey).not.toBe(store.sessions()[1].contextKey);
  expect(store.sessions()[0].activity).toMatchObject({
    threadId: `discord:${connectionSessionId('a', 'same-channel')}`,
    active: true,
  });
  store.receive('a', 'agent-a', {
    type: 'agent-connection-monitor',
    sessions: [{ ...row(), isActive: false, activity: { state: 'complete', active: false } }],
  });
  expect(store.sessions()[0].isActive).toBe(false);
  expect(store.sessions()[1].isActive).toBe(true);
  store.remove('a');
  expect(store.sessions()).toHaveLength(1);
  expect(store.sessions()[0].selectedAgentId).toBe('agent-b');
  expect(changed).toHaveBeenCalledTimes(4);
});

it('keeps more than a page of child sessions and rejects private/unrecognized metadata', () => {
  const store = new AgentConnectionMonitor();
  store.receive('a', 'agent', {
    type: 'agent-connection-monitor',
    sessions: [
      ...Array.from({ length: 125 }, (_, i) => ({
        ...row('s' + i),
        botToken: 'private',
        transcript: 'private',
        selectedAgentConfig: { prompt: 'private' },
      })),
      { ...row('secret_hidden'), title: 'private secret' },
    ],
  });
  expect(store.sessions()).toHaveLength(125);
  expect(JSON.stringify(store.sessions())).not.toContain('private');
  store.receive('a', 'agent', {
    type: 'agent-connection-monitor',
    sessions: [{ id: 'malformed' }],
  });
  expect(store.sessions()).toHaveLength(125);
  store.receive('a', 'agent', { type: 'agent-connection-monitor', sessions: [] });
  expect(store.sessions()).toEqual([]);
});

it('coalesces updates, excludes secret sessions, and sends the latest state after IPC backpressure', async () => {
  vi.useFakeTimers();
  let active = true;
  const messages: unknown[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  const publisher = createConnectionMonitorPublisher(
    () => [
      {
        ...row(),
        isActive: active,
        botToken: 'private',
        activity: { ...row().activity, userTextPreview: 'private', textPreview: 'private' },
      },
      row('secret_hidden'),
    ],
    (message, done) => {
      messages.push(message);
      callbacks.push(done);
    }
  );
  publisher.request();
  publisher.request();
  await vi.advanceTimersByTimeAsync(150);
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages)).not.toContain('private');
  expect(messages[0]).toMatchObject({ sessions: [{ id: 'same', isActive: true }] });
  active = false;
  publisher.request();
  await vi.advanceTimersByTimeAsync(150);
  expect(messages).toHaveLength(1);
  callbacks.shift()!();
  await vi.advanceTimersByTimeAsync(150);
  expect(messages).toHaveLength(2);
  expect(messages[1]).toMatchObject({ sessions: [{ isActive: false }] });
  callbacks.shift()!();
  publisher.request();
  publisher.stop();
  await vi.advanceTimersByTimeAsync(150);
  expect(messages).toHaveLength(2);
});

it('publishes on actual activity changes and releases observers on shutdown', async () => {
  const send = Object.getOwnPropertyDescriptor(process, 'send');
  const connected = Object.getOwnPropertyDescriptor(process, 'connected');
  const messages: unknown[] = [];
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: (message: unknown, done: () => void) => {
      messages.push(message);
      done();
    },
  });
  const stop = installAgentConnectionMonitorWorker(() => [row()]);
  try {
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    const context = { threadId: 'discord:channel', turnId: 'turn', platform: 'discord' as const };
    startActivity(context);
    updateActivityTool(context, 'exec_command', { cmd: 'run tests' });
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    stop();
    updateActivityTool(context, 'exec_command', { cmd: 'after shutdown' });
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(messages).toHaveLength(2);
  } finally {
    stop();
    if (send) Object.defineProperty(process, 'send', send);
    else Reflect.deleteProperty(process, 'send');
    if (connected) Object.defineProperty(process, 'connected', connected);
    else Reflect.deleteProperty(process, 'connected');
  }
});
