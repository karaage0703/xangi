import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readlink, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAppLayout, versionPath } from '../src/installer/layout.js';
import { canonicalManifestPayload, ManifestVerifier } from '../src/installer/manifest.js';
import {
  UpdateInProgressError,
  Updater,
  type HealthCheck,
  type ServiceController,
} from '../src/installer/updater.js';
import type {
  AppLayout,
  ReleaseManifest,
  UnsignedReleaseManifest,
} from '../src/installer/types.js';

const keys = generateKeyPairSync('ed25519');
const artifact = Buffer.from('fixture release bundle');
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  layout: AppLayout;
  personalFiles: Record<string, string>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xangi-updater-'));
  roots.push(root);
  const layout = resolveAppLayout({ platform: 'darwin', arch: 'arm64', homeDir: root });
  const oldVersion = versionPath(layout, '1.0.0');
  await mkdir(oldVersion, { recursive: true });
  await writeFile(join(oldVersion, 'release.txt'), 'old release');
  await mkdir(versionPath(layout, '0.9.0'), { recursive: true });
  await mkdir(layout.appRoot, { recursive: true });
  await symlink(oldVersion, layout.currentLink, 'dir');

  const personalFiles = {
    [join(layout.workspaceDir, 'AGENTS.md')]: 'my workspace',
    [join(layout.stateDir, 'sessions.json')]: 'my state',
    [layout.configFile]: 'my config',
  };
  for (const [path, value] of Object.entries(personalFiles)) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, value);
  }
  return { layout, personalFiles };
}

function manifest(overrides: Partial<UnsignedReleaseManifest> = {}): ReleaseManifest {
  const unsigned: UnsignedReleaseManifest = {
    schemaVersion: 1,
    version: '2.0.0',
    platform: 'darwin',
    arch: 'arm64',
    asset: {
      url: 'https://example.com/xangi-2.0.0.tar.gz',
      size: artifact.byteLength,
      sha256: createHash('sha256').update(artifact).digest('hex'),
    },
    ...overrides,
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalManifestPayload(unsigned)),
      keys.privateKey
    ).toString('base64'),
  };
}

function createUpdater(
  layout: AppLayout,
  overrides: {
    download?: (url: string) => Promise<Uint8Array>;
    service?: ServiceController;
    healthCheck?: HealthCheck;
    healthTimeoutMs?: number;
    healthRetryIntervalMs?: number;
  } = {}
): { updater: Updater; events: string[] } {
  const events: string[] = [];
  const updater = new Updater({
    layout,
    manifestVerifier: new ManifestVerifier(keys.publicKey),
    download:
      overrides.download ??
      (async () => {
        events.push('download');
        return artifact;
      }),
    extractArtifact: async (_bytes, destination) => {
      events.push(`extract:${basename(destination)}`);
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'release.txt'), 'new release');
    },
    service:
      overrides.service ??
      ({
        restart: async () => {
          events.push('restart');
        },
      } satisfies ServiceController),
    healthCheck:
      overrides.healthCheck ??
      (async () => {
        events.push('health');
        return true;
      }),
    healthTimeoutMs: overrides.healthTimeoutMs ?? 100,
    healthRetryIntervalMs: overrides.healthRetryIntervalMs ?? 5,
  });
  return { updater, events };
}

async function expectPersonalDataUnchanged(files: Record<string, string>): Promise<void> {
  for (const [path, value] of Object.entries(files)) {
    await expect(readFile(path, 'utf8')).resolves.toBe(value);
  }
}

describe('Updater', () => {
  it('検証後にserviceを再起動せずcurrentをatomicに切り替え、稼働中の可能性がある旧版も保持する', async () => {
    const { layout, personalFiles } = await fixture();
    const { updater, events } = createUpdater(layout);

    const result = await updater.update(manifest());

    expect(result).toEqual({ version: '2.0.0', previousVersion: '1.0.0', changed: true });
    expect(events).toEqual(['download', expect.stringMatching(/^extract:2\.0\.0-/)]);
    expect(await readlink(layout.currentLink)).toBe(versionPath(layout, '2.0.0'));
    expect(await readlink(join(layout.appRoot, 'previous'))).toBe(versionPath(layout, '1.0.0'));
    expect(await readFile(join(versionPath(layout, '2.0.0'), 'release.txt'), 'utf8')).toBe(
      'new release'
    );
    expect((await readdir(layout.versionsDir)).sort()).toEqual(['0.9.0', '1.0.0', '2.0.0']);
    expect(await readdir(layout.stagingDir)).toEqual([]);
    await expectPersonalDataUnchanged(personalFiles);
  });

  it('同じversionを再適用しても個人dataとprevious versionを保持する', async () => {
    const { layout, personalFiles } = await fixture();
    const { updater, events } = createUpdater(layout);

    await updater.update(manifest());
    const eventsAfterInstall = [...events];
    await expect(updater.update(manifest())).resolves.toEqual({ version: '2.0.0', changed: false });

    expect(events).toEqual(eventsAfterInstall);
    expect(await readlink(layout.currentLink)).toBe(versionPath(layout, '2.0.0'));
    expect(await readlink(join(layout.appRoot, 'previous'))).toBe(versionPath(layout, '1.0.0'));
    expect((await readdir(layout.versionsDir)).sort()).toEqual(['0.9.0', '1.0.0', '2.0.0']);
    await expectPersonalDataUnchanged(personalFiles);
  });

  it('install forceActivate provisions an already-current release and checks health', async () => {
    const { layout } = await fixture();
    const { updater, events } = createUpdater(layout);
    await updater.update(manifest());
    await updater.update(manifest(), { forceActivate: true });
    expect(events.slice(-2)).toEqual(['restart', 'health']);
    expect((await readdir(layout.versionsDir)).sort()).toEqual(['1.0.0', '2.0.0']);
  });

  it('hash検証失敗では展開・current切替・service restartを行わない', async () => {
    const { layout } = await fixture();
    const { updater, events } = createUpdater(layout, {
      download: async () => Buffer.from('tampered artifact'),
    });

    await expect(updater.update(manifest())).rejects.toThrow(/size|sha-256/i);

    expect(events).toEqual([]);
    expect(await readlink(layout.currentLink)).toBe(versionPath(layout, '1.0.0'));
    expect(await readdir(layout.stagingDir)).toEqual([]);
  });

  it('health失敗時は旧versionへrollbackしてserviceを再起動する', async () => {
    const { layout, personalFiles } = await fixture();
    const restarts: string[] = [];
    const { updater } = createUpdater(layout, {
      service: { restart: async () => void restarts.push('restart') },
      healthCheck: async () => false,
    });

    await expect(updater.update(manifest(), { forceActivate: true })).rejects.toThrow(/health/i);

    expect(restarts).toEqual(['restart', 'restart']);
    expect(await readlink(layout.currentLink)).toBe(versionPath(layout, '1.0.0'));
    expect(await readdir(layout.versionsDir)).not.toContain('2.0.0');
    await expectPersonalDataUnchanged(personalFiles);
  });

  it('service起動直後の一時的なhealth失敗をtimeout内で再試行する', async () => {
    const { layout } = await fixture();
    let attempts = 0;
    const { updater } = createUpdater(layout, {
      healthCheck: async () => {
        attempts += 1;
        return attempts >= 3;
      },
      healthTimeoutMs: 100,
      healthRetryIntervalMs: 1,
    });

    await expect(updater.update(manifest(), { forceActivate: true })).resolves.toMatchObject({
      version: '2.0.0',
    });
    expect(attempts).toBe(3);
  });

  it('health check timeout時もrollbackする', async () => {
    vi.useFakeTimers();
    const { layout } = await fixture();
    const restarts: string[] = [];
    let timeoutSignal: AbortSignal | undefined;
    let markHealthStarted: (() => void) | undefined;
    const healthStarted = new Promise<void>((resolve) => {
      markHealthStarted = resolve;
    });
    const { updater } = createUpdater(layout, {
      service: { restart: async () => void restarts.push('restart') },
      healthCheck: async (signal) => {
        timeoutSignal = signal;
        markHealthStarted?.();
        return new Promise<boolean>(() => undefined);
      },
      healthTimeoutMs: 25,
    });

    const pending = updater.update(manifest(), { forceActivate: true });
    await healthStarted;
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).rejects.toThrow(/timed out/i);
    expect(await readlink(layout.currentLink)).toBe(versionPath(layout, '1.0.0'));
    expect(restarts).toEqual(['restart', 'restart']);
    expect(timeoutSignal?.aborted).toBe(true);
  });

  it('新versionのservice起動失敗時もrollbackする', async () => {
    const { layout } = await fixture();
    let attempts = 0;
    const { updater } = createUpdater(layout, {
      service: {
        restart: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('boot failed');
        },
      },
    });

    await expect(updater.update(manifest(), { forceActivate: true })).rejects.toThrow(
      /boot failed/i
    );
    expect(attempts).toBe(2);
    expect(await readlink(layout.currentLink)).toBe(versionPath(layout, '1.0.0'));
  });

  it('同一installationへの並行updateをlockで拒否する', async () => {
    const { layout } = await fixture();
    let releaseDownload: ((value: Uint8Array) => void) | undefined;
    const blockedDownload = new Promise<Uint8Array>((resolve) => {
      releaseDownload = resolve;
    });
    const { updater } = createUpdater(layout, { download: async () => blockedDownload });

    const first = updater.update(manifest());
    await vi.waitFor(async () => {
      expect(await readdir(layout.appRoot)).toContain('update.lock.lease');
    });
    await expect(updater.update(manifest())).rejects.toBeInstanceOf(UpdateInProgressError);
    releaseDownload?.(artifact);
    await expect(first).resolves.toEqual({
      version: '2.0.0',
      previousVersion: '1.0.0',
      changed: true,
    });
    expect(await readdir(layout.appRoot)).not.toContain('update.lock.lease');
  });

  it('R22 retains assets from the running version through two non-activating updates', async () => {
    const { layout } = await fixture();
    const { updater } = createUpdater(layout);
    await updater.update(manifest());
    await updater.update(manifest({ version: '3.0.0' }));
    expect(await readFile(join(versionPath(layout, '1.0.0'), 'release.txt'), 'utf8')).toBe(
      'old release'
    );
  });
  it('R31 recovers a stale lease left by an exited updater', async () => {
    const { layout } = await fixture();
    const { utimes } = await import('node:fs/promises');
    await mkdir(layout.updateLock + '.lease');
    const old = new Date(Date.now() - 120_000);
    await utimes(layout.updateLock + '.lease', old, old);
    const { updater } = createUpdater(layout);
    await expect(updater.update(manifest())).resolves.toMatchObject({ version: '2.0.0' });
    expect(await readdir(layout.appRoot)).not.toContain('update.lock.lease');
  });
});
