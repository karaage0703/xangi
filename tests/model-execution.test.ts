import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendResolver } from '../src/backend-resolver.js';
import type { StreamCallbacks } from '../src/agent-runner.js';
import type { Config } from '../src/config.js';
import { DynamicRunnerManager } from '../src/dynamic-runner.js';
import { observeExecutionModel, type ModelExecution } from '../src/model-execution.js';
import { createSession, getSessionEntry, initSessions, setProviderSessionId, recordSessionModelExecution } from '../src/sessions.js';
import { logPrompt, logResponse, readSessionMessages, resetTranscriptStorageForTests } from '../src/transcript-logger.js';

const fake = vi.hoisted(() => ({ run: vi.fn(), runStream: vi.fn() }));
vi.mock('../src/agent-runner.js', () => ({
  createAgentRunner: () => fake,
  getBackendDisplayName: (name: string) => name,
}));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-execution-'));
  resetTranscriptStorageForTests();
  initSessions(dir);
  vi.clearAllMocks();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(backend: string, model?: string) {
  const config = { agent: { backend, config: { workdir: dir, model }, platform: 'web' } } as Config;
  const resolved = { backend, model };
  const resolver = { resolve: () => resolved, getDefault: () => resolved } as unknown as BackendResolver;
  const manager = new DynamicRunnerManager(config, resolver);
  const appSessionId = createSession('thread', { platform: 'web', workspacePath: dir });
  return { manager, resolved, appSessionId, options: { channelId: 'thread', appSessionId, workdir: dir, platform: 'web' as const } };
}

it.each(['codex', 'claude-code', 'cursor', 'grok', 'antigravity', 'github-copilot', 'opencode', 'local-llm', 'custom-extension'])('stores default model evidence for %s and preserves it after reload', async (backend) => {
  const { manager, appSessionId, options } = setup(backend);
  fake.run.mockResolvedValue({ result: 'ok', sessionId: 'provider', model: 'model-actual' });
  await manager.run('hello', options);
  const before = getSessionEntry(appSessionId)!;
  expect(before.agent?.model).toBeUndefined();
  expect(before.modelExecution).toMatchObject({ backend, effectiveModel: 'model-actual', observedModels: ['model-actual'], source: 'provider', status: 'completed' });
  initSessions(dir);
  expect(getSessionEntry(appSessionId)?.modelHistory).toEqual(before.modelHistory);
});

it('persists live model changes, the final model, and response metadata before onComplete', async () => {
  const { manager, appSessionId, options } = setup('codex', 'auto-alias');
  fake.runStream.mockImplementation(async (_prompt: string, cb: StreamCallbacks) => {
    logPrompt(dir, appSessionId, 'hello');
    cb.onModel?.('model-a');
    expect(getSessionEntry(appSessionId)?.modelExecution).toMatchObject({ source: 'provider', effectiveModel: 'model-a', status: 'running' });
    cb.onModel?.('model-b');
    cb.onModel?.('model-a');
    logResponse(dir, appSessionId, { result: 'ok' });
    const result = { result: 'ok', sessionId: 'provider', model: 'model-a', models: ['model-a', 'model-b'] };
    cb.onComplete?.(result);
    return result;
  });
  const complete = vi.fn(() => expect(getSessionEntry(appSessionId)?.modelExecution?.status).toBe('completed'));
  await manager.runStream('hello', { onComplete: complete }, options);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(getSessionEntry(appSessionId)?.modelExecution).toMatchObject({ configuredModel: 'auto-alias', effectiveModel: 'model-a', observedModels: ['model-a', 'model-b'] });
  expect(readSessionMessages(dir, appSessionId).at(-1)?.modelExecution?.effectiveModel).toBe('model-a');
});

it('preserves completed turns after settings changes and never labels the next unobserved run with an old model', async () => {
  const { manager, resolved, appSessionId, options } = setup('cursor');
  fake.run.mockResolvedValueOnce({ result: 'one', sessionId: 'provider', model: 'old-model' }).mockResolvedValueOnce({ result: 'two', sessionId: 'provider' });
  await manager.run('one', options);
  resolved.model = 'new-config';
  await manager.run('two', options);
  const entry = getSessionEntry(appSessionId)!;
  expect(entry.modelHistory).toHaveLength(2);
  expect(entry.modelHistory![0].effectiveModel).toBe('old-model');
  expect(entry.modelExecution).toMatchObject({ configuredModel: 'new-config', source: 'configuration', observedModels: [] });
  expect(entry.modelExecution?.effectiveModel).toBeUndefined();
});

it('keeps provider evidence even when a request fails and does not annotate the previous response', async () => {
  const { manager, appSessionId, options } = setup('claude-code');
  logPrompt(dir, appSessionId, 'old');
  logResponse(dir, appSessionId, { result: 'old response' });
  fake.runStream.mockImplementation(async (_prompt: string, cb: StreamCallbacks) => {
    logPrompt(dir, appSessionId, 'new');
    cb.onModel?.('observed-before-error');
    throw new Error('connection lost');
  });
  await expect(manager.runStream('new', {}, options)).rejects.toThrow('connection lost');
  expect(getSessionEntry(appSessionId)?.modelExecution).toMatchObject({ status: 'failed', effectiveModel: 'observed-before-error' });
  expect(readSessionMessages(dir, appSessionId)[1].modelExecution).toBeUndefined();
});

it('does not pollute a user session with internal tasks or workspace mismatch', async () => {
  const { manager, appSessionId, options } = setup('codex');
  fake.run.mockResolvedValue({ result: 'title', sessionId: 'internal', model: 'title-model' });
  await manager.run('title', { ...options, internalTask: true });
  expect(getSessionEntry(appSessionId)?.modelHistory).toBeUndefined();
  const other = mkdtempSync(join(tmpdir(), 'model-other-'));
  try {
    await manager.run('other', { ...options, workdir: other });
    expect(getSessionEntry(appSessionId)?.modelHistory).toBeUndefined();
  } finally { rmSync(other, { recursive: true, force: true }); }
});

it('stores exact execution snapshots without mutating prior turns, title or lifecycle', () => {
  const appSessionId = createSession('thread', { title: 'original' });
  const snapshot: ModelExecution = { turnId: 'newer', backend: 'custom', observedModels: ['b'], effectiveModel: 'b', source: 'provider', status: 'running', startedAt: '2025-01-02T00:00:00Z', updatedAt: '2025-01-02T00:00:00Z' };
  recordSessionModelExecution(appSessionId, snapshot);
  snapshot.observedModels.push('mutation');
  recordSessionModelExecution(appSessionId, { ...snapshot, observedModels: ['a'], effectiveModel: 'a', turnId: 'older', startedAt: '2025-01-01T00:00:00Z', status: 'completed' });
  const stored = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).sessions[appSessionId];
  expect(stored.modelExecution.effectiveModel).toBe('b');
  expect(stored.modelHistory[0].observedModels).toEqual(['b']);
  expect(stored.title).toBe('original');
  expect(stored.lifecycle).toBe('open');
});

it('rejects placeholder/control values and tracks a return to a previous model', () => {
  const snapshot: ModelExecution = { turnId: 'one', backend: 'custom', observedModels: [], source: 'unknown', status: 'running', startedAt: '', updatedAt: '' };
  for (const invalid of ['', '(default)', 'unknown', 'foo\nbar', 4]) expect(observeExecutionModel(snapshot, invalid)).toBe(false);
  for (const model of ['a', 'b', 'a']) expect(observeExecutionModel(snapshot, model)).toBe(true);
  expect(snapshot.effectiveModel).toBe('a');
  expect(snapshot.observedModels).toEqual(['a', 'b']);
});

it('keeps the latest streaming model when the final result only supplies deduplicated models', async () => {
  const { manager, appSessionId, options } = setup('custom-extension');
  fake.runStream.mockImplementation(async (_prompt: string, cb: StreamCallbacks) => {
    for (const model of ['a', 'b', 'a']) cb.onModel?.(model);
    return { result: 'ok', sessionId: 'provider', models: ['a', 'b'] };
  });
  const result = await manager.runStream('hello', {}, options);
  expect(result.model).toBe('a');
  expect(getSessionEntry(appSessionId)?.modelExecution?.effectiveModel).toBe('a');
});

it('does not reclassify a completed provider run when a UI completion callback throws', async () => {
  const { manager, appSessionId, options } = setup('custom-extension');
  fake.runStream.mockResolvedValue({ result: 'ok', sessionId: 'provider', model: 'a' });
  await expect(manager.runStream('hello', { onComplete() { throw new Error('UI error'); } }, options)).rejects.toThrow('UI error');
  expect(getSessionEntry(appSessionId)?.modelExecution?.status).toBe('completed');
});

it('matches resume configuration before updating backend mode, and clears a removed explicit model', async () => {
  const { manager, resolved, appSessionId, options } = setup('codex');
  setProviderSessionId(appSessionId, 'old-provider', 'cursor');
  fake.run.mockResolvedValue({ result: 'ok', sessionId: 'new-provider', model: 'observed' });
  await manager.run('hello', { ...options, sessionId: 'old-provider' });
  expect(fake.run.mock.calls[0][1].sessionId).toBeUndefined();
  resolved.model = 'explicit';
  await manager.run('explicit', options);
  resolved.model = undefined;
  await manager.run('default', options);
  expect(getSessionEntry(appSessionId)?.agent?.model).toBeUndefined();
  expect(getSessionEntry(appSessionId)?.modelExecution?.configuredModel).toBeUndefined();
});

it('ignores model notifications arriving after completion', async () => {
  const { manager, appSessionId, options } = setup('custom-extension');
  let saved: StreamCallbacks | undefined;
  fake.runStream.mockImplementation(async (_prompt: string, cb: StreamCallbacks) => {
    saved = cb;
    cb.onModel?.('actual');
    return { result: 'ok', sessionId: 'provider', model: 'actual' };
  });
  await manager.runStream('hello', {}, options);
  saved?.onModel?.('late-other-model');
  expect(getSessionEntry(appSessionId)?.modelExecution?.effectiveModel).toBe('actual');
});

it('persists provider Auto selection without claiming an underlying model', async () => {
  const { manager, appSessionId, options } = setup('cursor');
  fake.runStream.mockImplementation(async (_prompt: string, cb: StreamCallbacks) => {
    cb.onModelSelection?.('Auto');
    expect(getSessionEntry(appSessionId)?.modelExecution?.modelSelection).toBe('Auto');
    return { result: 'ok', sessionId: 'provider', modelSelection: 'Auto' };
  });
  await manager.runStream('hello', {}, options);
  initSessions(dir);
  expect(getSessionEntry(appSessionId)?.modelExecution).toMatchObject({ modelSelection: 'Auto', source: 'unknown', observedModels: [], status: 'completed' });
  expect(getSessionEntry(appSessionId)?.modelExecution?.effectiveModel).toBeUndefined();
});
