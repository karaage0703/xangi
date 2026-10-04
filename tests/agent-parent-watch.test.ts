import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunStore } from '../src/agent-runs.js';
import {
  checkAgentParents,
  parentDeliveryDue,
  parentWatchSettings,
} from '../src/agent-parent-watch.js';
let dir: string;
let store: AgentRunStore;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T00:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'parent-watch-'));
  store = AgentRunStore.fromDataDir(dir);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});
const create = () =>
  store.create({
    task: 'test',
    backend: 'codex',
    workspaceId: 'default',
    workspacePath: dir,
    appSessionId: 'child',
    parentContextKey: 'C123:123.456',
    parentPlatform: 'slack',
  });
const destination = (run: ReturnType<typeof create>) => ({
  parent: run.parentContextKey,
  platform: run.parentPlatform,
});
it('recovers unsent terminal results and persists bounded retries across restart', async () => {
  const run = create();
  store.markFailed(run.id, 'provider missing');
  const notify = vi.fn();
  const send = vi.fn();
  await checkAgentParents({ store, destination, notify, send });
  expect(notify).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 3; i++) {
    expect(parentDeliveryDue(store.get(run.id)!)).toBe(true);
    store.markParentDeliveryAttempt(run.id);
    store.setParentDeliveryError(run.id, 'transport failed');
    expect(parentDeliveryDue(store.get(run.id)!)).toBe(false);
    vi.advanceTimersByTime(30_000);
  }
  store = AgentRunStore.fromDataDir(dir);
  expect(parentDeliveryDue(store.get(run.id)!)).toBe(false);
  await checkAgentParents({ store, destination, notify, send });
  await checkAgentParents({ store, destination, notify, send });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][2]).toContain('provider missing');
  expect(store.get(run.id)?.parentNotifiedAt).toBeUndefined();
  store.markRunning(run.id);
  store.markFailed(run.id, 'new failure');
  expect(parentDeliveryDue(store.get(run.id)!)).toBe(true);
});
it('reports running work without model polling at the configurable interval', async () => {
  const run = create();
  store.markRunning(run.id);
  const notify = vi.fn();
  const send = vi.fn().mockResolvedValue(undefined);
  const opts = { store, destination, notify, send, progressMs: 60_000 };
  await checkAgentParents(opts);
  expect(send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  await checkAgentParents(opts);
  expect(send).toHaveBeenCalledTimes(1);
  expect(notify).not.toHaveBeenCalled();
  await checkAgentParents(opts);
  expect(send).toHaveBeenCalledTimes(1);
  store.markFailed(run.id, 'failed');
  await checkAgentParents(opts);
  expect(notify).toHaveBeenCalledTimes(1);
});
it('validates interval settings and honors custom retry timing', () => {
  expect(parentWatchSettings({})).toEqual({ checkMs: 30000, progressMs: 180000 });
  expect(
    parentWatchSettings({
      AGENT_PARENT_CHECK_INTERVAL_MS: '5000',
      AGENT_PARENT_PROGRESS_INTERVAL_MS: '60000',
    })
  ).toEqual({ checkMs: 5000, progressMs: 60000 });
  expect(() => parentWatchSettings({ AGENT_PARENT_CHECK_INTERVAL_MS: '0' })).toThrow();
  const run = create();
  store.markFailed(run.id, 'error');
  store.markParentDeliveryAttempt(run.id);
  vi.advanceTimersByTime(5000);
  expect(parentDeliveryDue(store.get(run.id)!, Date.now(), 5000)).toBe(true);
  expect(parentDeliveryDue(store.get(run.id)!)).toBe(false);
});

it('never recovers untracked historical results or progress, even with old attempts', async () => {
  const run = create();
  store.markFailed(run.id, 'old error');
  const path = join(dir, 'agent-runs.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  delete state.runs[0].parentDeliveryTracked;
  state.runs[0].parentDeliveryAttempts = 3;
  writeFileSync(path, JSON.stringify(state));
  store = AgentRunStore.fromDataDir(dir);
  const notify = vi.fn();
  const send = vi.fn();
  expect(parentDeliveryDue(store.get(run.id)!)).toBe(false);
  await checkAgentParents({ store, destination, notify, send });
  expect(notify).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  store.markRunning(run.id);
  store.markFailed(run.id, 'explicit new execution');
  expect(parentDeliveryDue(store.get(run.id)!)).toBe(true);
});
