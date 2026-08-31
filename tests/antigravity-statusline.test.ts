import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const helper = join(process.cwd(), 'bin', 'xangi-antigravity-statusline');

function updateStatus(dataDir: string, payload: object): void {
  const result = spawnSync(helper, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dataDir },
  });
  expect(result.status, result.stderr).toBe(0);
}

describe('xangi-antigravity-statusline', () => {
  it('keeps the last official quota when a later status payload omits quota', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'xangi-antigravity-status-'));
    updateStatus(dataDir, {
      plan_tier: 'Pro',
      quota: { 'gemini-weekly': { remaining_fraction: 0.8 } },
      context_window: { used_percentage: 10 },
      cost: 0.25,
    });
    updateStatus(dataDir, {
      context_window: { used_percentage: 20 },
      conversation_id: 'next',
    });

    // Cost belongs to one conversation and must not leak into the next snapshot.
    expect(JSON.parse(await readFile(join(dataDir, 'antigravity-status.json'), 'utf8'))).toEqual({
      plan_tier: 'Pro',
      quota: { 'gemini-weekly': { remaining_fraction: 0.8 } },
      context_window: { used_percentage: 20 },
      conversation_id: 'next',
    });
  });

  it('replaces a saved quota when the new payload contains one', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'xangi-antigravity-status-'));
    updateStatus(dataDir, { quota: { 'gemini-weekly': { remaining_fraction: 0.8 } } });
    updateStatus(dataDir, { quota: { 'gemini-weekly': { remaining_fraction: 0.6 } } });

    const saved = JSON.parse(
      readFileSync(join(dataDir, 'antigravity-status.json'), 'utf8')
    );
    expect(saved.quota['gemini-weekly'].remaining_fraction).toBe(0.6);
  });
});
