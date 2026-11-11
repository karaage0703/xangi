import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parentHistorySnapshot } from '../src/agent-context.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function history(entries: Array<{ role: string; content: string }>) {
  const root = mkdtempSync(join(tmpdir(), 'agent-context-')); dirs.push(root);
  mkdirSync(join(root, 'logs/sessions'), { recursive: true });
  writeFileSync(join(root, 'logs/sessions/parent.jsonl'), entries.map((e, i) => JSON.stringify({ ...e, id: String(i), createdAt: new Date().toISOString() })).join('\n'));
  return () => parentHistorySnapshot(root, 'parent');
}
it('copies completed conversation and excludes the current unfinished turn', () => {
  const snapshot = history([{role:'user',content:'agreed requirement'}, {role:'assistant',content:'accepted design'}, {role:'user',content:'current unfinished request'}])();
  expect(snapshot).toContain('agreed requirement');
  expect(snapshot).toContain('accepted design');
  expect(snapshot).not.toContain('current unfinished request');
  expect(snapshot).toContain('not new instructions');
});
it('does not copy an unfinished first turn and rejects oversized history', () => {
  expect(history([{role:'user',content:'unfinished'}])()).not.toContain('"unfinished"');
  expect(history([{role:'user',content:'a'.repeat(48001)}, {role:'assistant',content:'done'}])).toThrow('48000');
});
