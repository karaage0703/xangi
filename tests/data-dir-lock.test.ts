import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acquireDataDirLock } from '../src/data-dir-lock.js';

describe('acquireDataDirLock', () => {
  it('creates a new DATA_DIR before acquiring its lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-data-dir-lock-'));
    const dataDir = join(root, 'new-state');

    const release = await acquireDataDirLock(dataDir);
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(`${dataDir}.lock`)).toBe(true);

    await release();
    expect(existsSync(`${dataDir}.lock`)).toBe(false);
  });

  it('rejects a second process instead of starting without a lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-data-dir-lock-'));
    const dataDir = join(root, 'shared-state');
    const release = await acquireDataDirLock(dataDir);

    try {
      await expect(acquireDataDirLock(dataDir)).rejects.toThrow(
        /Another xangi process is using the same dataDir/
      );
    } finally {
      await release();
    }
  });

  it('rejects other lock failures instead of continuing startup', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const lock = vi.fn().mockRejectedValue(denied);

    await expect(
      acquireDataDirLock('/fixture/state', {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        lock,
      })
    ).rejects.toThrow(/Failed to acquire dataDir lock/);
  });
});
