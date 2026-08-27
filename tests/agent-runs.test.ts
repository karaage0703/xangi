import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunStore } from '../src/agent-runs.js';

describe('AgentRunStore', () => {
  it('persists a reproducible manifest and terminal usage', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-runs-test-'));
    const store = AgentRunStore.fromDataDir(dataDir);
    const created = store.create({
      task: 'Implement the task',
      backend: 'codex',
      model: 'gpt-test',
      effort: 'high',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/workspace-1',
      appSessionId: 'session-1',
    });

    expect(created.status).toBe('queued');
    expect(created.taskHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.trajectoryPath).toBeUndefined();

    store.markRunning(created.id);
    const completed = store.markSucceeded(created.id, {
      result: 'done',
      sessionId: 'provider-1',
      usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3 },
    });

    expect(completed).toMatchObject({
      status: 'succeeded',
      providerSessionId: 'provider-1',
      result: 'done',
      usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3 },
    });
    expect(JSON.parse(readFileSync(join(dataDir, 'agent-runs.json'), 'utf8'))).toMatchObject({
      version: 1,
      runs: [expect.objectContaining({ id: created.id, status: 'succeeded' })],
    });
  });

  it('rejects an empty task', () => {
    const store = AgentRunStore.fromDataDir(mkdtempSync(join(tmpdir(), 'agent-runs-test-')));
    expect(() =>
      store.create({
        task: ' ',
        backend: 'codex',
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/workspace-1',
        appSessionId: 'session-1',
      })
    ).toThrow('task is required');
  });

  it('only exposes a trajectory path after the file exists', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-runs-test-'));
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-runs-workspace-'));
    const store = AgentRunStore.fromDataDir(dataDir);
    const created = store.create({
      task: 'Inspect the workspace',
      backend: 'codex',
      workspaceId: 'workspace-1',
      workspacePath,
      appSessionId: 'session-trajectory',
    });
    const trajectoryPath = join(
      workspacePath,
      'logs',
      'tool-trajectory',
      'session-trajectory.jsonl'
    );
    mkdirSync(join(workspacePath, 'logs', 'tool-trajectory'), { recursive: true });
    writeFileSync(trajectoryPath, '{}\n');

    store.markRunning(created.id);
    const completed = store.markSucceeded(created.id, {
      result: 'done',
      sessionId: 'provider-1',
    });
    expect(completed.trajectoryPath).toBe(trajectoryPath);
  });

  it('marks unfinished persisted runs as failed after restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-runs-test-'));
    const store = AgentRunStore.fromDataDir(dataDir);
    const created = store.create({
      task: 'Long task',
      backend: 'codex',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/workspace-1',
      appSessionId: 'session-1',
    });
    store.markRunning(created.id);

    const restored = AgentRunStore.fromDataDir(dataDir).get(created.id);
    expect(restored).toMatchObject({
      status: 'failed',
      error: 'xangi restarted before the Agent Run completed',
    });
  });
});
