import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, mkdir, copyFile, symlink, writeFile, chmod } from 'node:fs/promises';
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

it('uses bundled Node and an explicit state directory from an unrelated cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xangi bundle '));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'runtime', 'bin'), { recursive: true });
  const installed = join(root, 'bin', 'xangi-antigravity-statusline');
  await copyFile(helper, installed);
  await symlink(process.execPath, join(root, 'runtime', 'bin', 'node'));
  await writeFile(join(root, 'bin', 'node'), '#!/bin/sh\nexit 91\n');
  await chmod(join(root, 'bin', 'node'), 0o755);
  const dataDir = join(root, 'state with spaces');
  const result = spawnSync('/bin/bash', [installed, '--data-dir', dataDir], {
    cwd: tmpdir(),
    input: JSON.stringify({ quota: { 'gemini-weekly': { remaining_fraction: 0.8 } } }),
    encoding: 'utf8',
    env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, DATA_DIR: '/must-not-be-used' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(dataDir, 'antigravity-status.json'), 'utf8')).quota).toBeDefined();
});
