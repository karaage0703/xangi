import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectAgentRunLogs, logPageOptions } from '../src/agent-run-logs.js';
import type { AgentRun } from '../src/agent-runs.js';
let root: string;
let run: AgentRun;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-logs-'));
  run = { id: 'run1', backend: 'openrouter', appSessionId: 'session1', workspacePath: root,
    workspaceId: 'w', task: 'task', taskHash: 'h', status: 'succeeded', createdAt: new Date().toISOString() };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function trajectory(rows: unknown[]) {
  const dir = join(root, 'logs/tool-trajectory'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session1.jsonl');
  writeFileSync(file, rows.map(row => JSON.stringify({ appSessionId: 'session1', ...row as object })).join('\n'));
  return file;
}
it('counts the full log, paginates evidence, redacts credentials and excludes search-result URLs', async () => {
  const file = trajectory([
    { kind: 'tool_call', tool_name: 'search', status: 'success', args_sanitized: { query: '店', sources: [{ url: 'https://result.example' }], token: 'private' } },
    { kind: 'tool_call', tool_name: 'fetch', status: 'error', args_sanitized: { url: 'https://u:p@example.com/?token=private' }, error_truncated: 'Bearer private failed' },
    { kind: 'runner_event', event: 'session_retry' },
    { kind: 'tool_call', tool_name: 'search', status: 'success', args_sanitized: { query: '店' } },
    { appSessionId: 'someone-else', kind: 'tool_call', tool_name: 'other' },
  ]);
  const result = await inspectAgentRunLogs(run, { offset: 0, limit: 2 });
  expect(result.counts).toEqual({ search: 2, fetch: 1 });
  expect(result.errors).toBe(1); expect(result.retries).toBe(1);
  expect(result.nextOffset).toBe(2); expect(result.totalEvents).toBe(4);
  expect(result.events[0]).toMatchObject({ queries: ['店'], urls: [], source: file, line: 1 });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(result.events[1].urls[0]).not.toContain('u:p');
  const last = await inspectAgentRunLogs(run, { offset: 2, limit: 2 });
  expect(last.events[0].kind).toBe('retry'); expect(last.nextOffset).toBeNull();
});
it('reports missing logs and malformed lines without failing all members', async () => {
  expect((await inspectAgentRunLogs(run, { offset: 0, limit: 20 })).warnings.length).toBeGreaterThan(0);
  const file = trajectory([{ kind: 'tool_call', tool_name: 'read' }]);
  writeFileSync(file, '\n{partial', { flag: 'a' });
  const result = await inspectAgentRunLogs(run, { offset: 0, limit: 20 });
  expect(result.counts).toEqual({ read: 1 }); expect(result.warnings[0]).toContain('1 malformed');
});
it('rejects path traversal and symlink escapes', async () => {
  const file = trajectory([]);
  const outside = join(root, 'secret'); writeFileSync(outside, '{}');
  rmSync(file); symlinkSync(outside, file);
  expect((await inspectAgentRunLogs(run, { offset: 0, limit: 20 })).warnings[0]).toContain('rejected');
  run.appSessionId = '../secret';
  expect((await inspectAgentRunLogs(run, { offset: 0, limit: 20 })).warnings).toEqual(['invalid app session ID']);
});
it('reads Grok native actions without exposing reasoning or counting sources as visited URLs', async () => {
  run.backend = 'grok'; run.providerSessionId = 'provider-1';
  const grokHome = join(root, 'grok');
  const dir = join(grokHome, 'sessions', encodeURIComponent(root), run.providerSessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'chat_history.jsonl'), [
    { type: 'reasoning', summary: 'private reasoning' },
    { type: 'backend_tool_call', kind: { status: 'completed', action: { type: 'search', query: '夕飯', sources: [{ url: 'https://result' }] } } },
    { type: 'backend_tool_call', kind: { status: 'failed', action: { type: 'open_page', url: 'https://example.com' } } },
  ].map(r => JSON.stringify(r)).join('\n'));
  const result = await inspectAgentRunLogs(run, { offset: 0, limit: 20, grokHome });
  expect(result.counts).toEqual({ search: 1, open_page: 1 });
  expect(result.events[0].urls).toEqual([]); expect(result.events[1].line).toBe(3);
  expect(result.errors).toBe(1); expect(JSON.stringify(result)).not.toContain('private reasoning');
});
it('validates bounded pagination', () => {
  for (const flags of [{ limit: '0' }, { limit: '101' }, { offset: '-1' }, { limit: 'wat' }]) expect(() => logPageOptions(flags)).toThrow();
  expect(logPageOptions({})).toEqual({ offset: 0, limit: 20 });
});
