import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lifecycleStatus, queueLifecycle, runLifecycle } from '../src/cli/lifecycle-cmd.js';
import { planRestart } from '../src/cli/restart-cmd.js';
import { resolveAppLayout, versionPath } from '../src/installer/layout.js';
import { canonicalManifestPayload, ManifestVerifier } from '../src/installer/manifest.js';
import { updateCmd } from '../src/cli/update-cmd.js';
import type { UnsignedReleaseManifest } from '../src/installer/types.js';
import { workerUnitPath } from '../src/remote-worker/systemd.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(), execFile: vi.fn() }));
const roots: string[] = [];
const checkoutJobs: string[] = [];
const originalEnv = { ...process.env };
const originalExit = process.exitCode;
function ok(stdout = '') {
  return {
    status: 0,
    stdout,
    stderr: '',
    pid: 1,
    signal: null,
    output: [null, stdout, ''],
  } as ReturnType<typeof spawnSync>;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xangi-lifecycle-flow-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XANGI_WORKER_HOME', join(root, 'worker'));
  vi.stubEnv('XANGI_INSTALLATION_KIND', 'managed');
  const layout = resolveAppLayout({
    platform: 'linux',
    arch: 'x64',
    homeDir: root,
    xdgDataHome: join(root, 'data'),
    xdgStateHome: join(root, 'state'),
    xdgConfigHome: join(root, 'config'),
  });
  mkdirSync(versionPath(layout, '1.0.0'), { recursive: true });
  symlinkSync(versionPath(layout, '1.0.0'), layout.currentLink);
  vi.mocked(spawnSync).mockReturnValue(ok());
  return { root, layout };
}
function requestFrom(receipt: string) {
  const resultPath = /Result: (.+)/.exec(receipt)![1];
  const requestPath = join(dirname(resultPath), 'request.json');
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  request.requesterPid = 2147483647;
  writeFileSync(requestPath, JSON.stringify(request));
  if (resultPath.includes('/.xangi/')) checkoutJobs.push(dirname(resultPath));
  return {
    resultPath,
    path: join(dirname(resultPath), 'request.json'),
    id: basename(dirname(resultPath)),
    result: () => JSON.parse(readFileSync(resultPath, 'utf8')),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  process.exitCode = originalExit;
  vi.mocked(spawnSync).mockReset();
  [...roots.splice(0), ...checkoutJobs.splice(0)].forEach((root) =>
    rmSync(root, { recursive: true, force: true })
  );
});

describe('synchronous managed update without lifecycle jobs', () => {
  const keys = generateKeyPairSync('ed25519');
  const artifact = Buffer.from('test bundle');
  it.each([
    'changed',
    'unchanged',
    'hash failure',
    'download failure',
    'extract failure',
    'first install',
    'no service manager',
    'missing current target',
  ])(
    '%s verifies and selects a release without service/worker control or health probes',
    async (mode) => {
      const { layout } = fixture();
      if (mode === 'first install') rmSync(layout.currentLink);
      if (mode === 'missing current target')
        rmSync(versionPath(layout, '1.0.0'), { recursive: true });
      const events: string[] = [];
      const unsigned: UnsignedReleaseManifest = {
        schemaVersion: 1,
        version: ['unchanged', 'missing current target'].includes(mode) ? '1.0.0' : '2.0.0',
        platform: 'linux',
        arch: 'x64',
        asset: {
          url: 'https://example.com/bundle.tar.gz',
          size: artifact.length,
          sha256: createHash('sha256').update(artifact).digest('hex'),
        },
      };
      const manifest = {
        ...unsigned,
        signature: sign(
          null,
          Buffer.from(canonicalManifestPayload(unsigned)),
          keys.privateKey
        ).toString('base64'),
      };
      const restart = vi.fn(async () => {
        throw new Error('must not restart');
      });
      const healthCheck = vi.fn(async () => {
        throw new Error('must not probe old process health');
      });
      const serviceStatus = vi.fn(async () => {
        throw new Error('must not require OS service manager');
      });
      const dependencies = {
        layout,
        service:
          mode === 'no service manager'
            ? undefined
            : ({
                restart,
                status: serviceStatus,
              } as unknown as import('../src/installer/platform/service.js').ServiceAdapter),
        manifestVerifier: new ManifestVerifier(keys.publicKey),
        fetchManifest: async () => manifest,
        download: async () => {
          events.push('download');
          if (mode === 'download failure') throw new Error('download failed');
          return mode === 'hash failure' ? Buffer.from('tampered') : artifact;
        },
        extractArtifact: async (_data: Uint8Array, destination: string) => {
          events.push('extract');
          if (mode === 'extract failure') throw new Error('extract failed');
          writeFileSync(join(destination, 'release.txt'), 'new');
        },
        healthCheck,
        // The public update command cannot opt into install-only activation.
        forceActivate: true,
      };
      const pending = updateCmd({ manifest: 'https://example.com/manifest.json' }, dependencies);
      if (mode.includes('failure')) {
        await expect(pending).rejects.toThrow();
        expect(readlinkSync(layout.currentLink)).toBe(versionPath(layout, '1.0.0'));
      } else {
        const result = await pending;
        expect(readlinkSync(layout.currentLink)).toBe(versionPath(layout, unsigned.version));
        if (mode === 'unchanged') {
          expect(result).toContain('already up to date');
          expect(result).not.toContain('To apply the update');
          expect(events).toEqual([]);
        } else {
          expect(result).toContain('To apply the update, run `xangi restart`.');
          expect(result).toContain(
            `Managed launcher: '${join(layout.appRoot, 'bin', 'xangi')}' restart`
          );
          expect(events).toEqual(['download', 'extract']);
        }
      }
      expect(restart).not.toHaveBeenCalled();
      expect(healthCheck).not.toHaveBeenCalled();
      expect(serviceStatus).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
      expect(existsSync(join(layout.stateDir, 'lifecycle'))).toBe(false);
      expect(existsSync(layout.updateLock + '.lease')).toBe(false);
    }
  );
});

describe('Linux supervisor selection and terminal UX', () => {
  async function checkout(running = true, worker: 'absent' | 'stopped' | 'running' = 'absent') {
    const { root } = fixture();
    vi.stubEnv('XANGI_INSTALLATION_KIND', 'checkout');
    vi.mocked(spawnSync).mockReturnValue(ok('[]'));
    const plan = await planRestart();
    if (worker !== 'absent') {
      mkdirSync(join(root, 'worker'), { recursive: true });
      writeFileSync(join(root, 'worker', 'worker.json'), '{}');
      mkdirSync(dirname(workerUnitPath()), { recursive: true });
      writeFileSync(workerUnitPath(), 'test');
    }
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      if (command === 'pm2' && args?.[0] === 'jlist')
        return ok(
          JSON.stringify([
            {
              name: options?.env?.XANGI_PROCESS_NAME,
              pm2_env: { pm_cwd: plan.root, status: running ? 'online' : 'stopped' },
            },
          ])
        );
      if (command === 'systemctl' && worker !== 'absent')
        return ok(
          worker === 'running'
            ? 'ActiveState=active\nSubState=running\nMainPID=42'
            : 'ActiveState=inactive\nSubState=dead\nMainPID=0'
        );
      if (command !== 'pm2')
        return { ...ok(), status: 1, stderr: 'systemd user manager unavailable' };
      return ok();
    });
    return plan;
  }
  it.each(['absent', 'stopped'] as const)(
    'selects PM2 explicitly with %s worker, independently of systemd-run',
    async (worker) => {
      await checkout(true, worker);
      const receipt = await queueLifecycle('restart', {});
      const job = requestFrom(receipt);
      expect(receipt).toContain('Supervisor: pm2 (checkout has only a running PM2 app)');
      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls.some(([name]) => name === 'systemd-run')).toBe(false);
      const args = calls.find(([name, args]) => name === 'pm2' && args?.[0] === 'start')![1]!;
      expect(args).toEqual(
        expect.arrayContaining(['--no-autorestart', '--interpreter', 'none', '--force'])
      );
      expect(args).toContain(job.path);
      // The helper's own cleanup is exact-name only and follows durable completion.
      const label = JSON.parse(readFileSync(job.path, 'utf8')).label;
      vi.mocked(spawnSync).mockImplementation((name, args) => {
        if (name === 'pm2' && args?.[0] === 'delete') {
          expect(args).toEqual(['delete', label]);
          expect(job.result().state).toBe('completed');
          expect(readFileSync(join(dirname(job.path), 'output.log'), 'utf8')).toContain(
            'completed:'
          );
        }
        return ok();
      });
      await runLifecycle(job.path, {
        plan: async () => ({ kind: 'checkout', root: '/', service: true, worker: false }),
        restart: async () => 'app done',
      });
      expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
        'pm2',
        ['delete', label],
        expect.anything()
      );
    }
  );
  it('skips all stopped targets without starting any supervisor job', async () => {
    await checkout(false);
    expect(await queueLifecycle('restart', {})).toContain('No supervisor job needed');
    expect(vi.mocked(spawnSync).mock.calls.every(([, args]) => args?.[0] === 'jlist')).toBe(true);
  });
  it('refuses systemd submission failure with a running worker, without PM2 fallback', async () => {
    await checkout(true, 'running');
    const error = await queueLifecycle('restart', {}).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const job = requestFrom((error as Error).message);
    expect(job.result()).toMatchObject({ state: 'failed', exitCode: 1 });
    expect((error as Error).message).toContain('systemd user manager unavailable');
    expect(
      vi
        .mocked(spawnSync)
        .mock.calls.some(([name, args]) => name === 'pm2' && args?.[0] === 'start')
    ).toBe(false);
  });
  it.each(['completed', 'failed'])(
    '--wait passes the final %s exit code without changing the independent submission',
    async (state) => {
      fixture();
      vi.mocked(spawnSync).mockImplementation((command, args) => {
        if (command === 'systemctl') return ok('active');
        const requestPath = args![args!.indexOf('--request') + 1] as string;
        const request = JSON.parse(readFileSync(requestPath, 'utf8'));
        expect(request.wait).toBe(true);
        expect(request.flags).toBeUndefined();
        writeFileSync(
          request.resultPath,
          JSON.stringify({
            operation: 'restart',
            state,
            detail: 'final fixture outcome',
            exitCode: state === 'failed' ? 1 : 0,
          })
        );
        return ok();
      });
      const result = await queueLifecycle('restart', { wait: true });
      expect(result).toContain(state);
      expect(process.exitCode).toBe(state === 'failed' ? 1 : 0);
    }
  );
  it('status waiting times out as pending, leaves the helper untouched, and rejects path traversal', async () => {
    fixture();
    vi.mocked(spawnSync).mockReturnValue(ok('active'));
    const job = requestFrom(await queueLifecycle('restart', {}));
    vi.mocked(spawnSync).mockClear();
    vi.useFakeTimers();
    const pending = lifecycleStatus(job.id, { managed: true, wait: true });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await pending).toContain('helper was not cancelled');
    expect(process.exitCode).toBe(2);
    expect(job.result().state).toBe('accepted');
    expect(spawnSync).not.toHaveBeenCalled();
    await expect(lifecycleStatus('../escape')).rejects.toThrow('Usage:');
  });
});

it('rejects a worker activated after PM2-only acceptance before touching either target', async () => {
  fixture();
  vi.mocked(spawnSync).mockReturnValue(ok('active'));
  const job = requestFrom(await queueLifecycle('restart', {}));
  const request = JSON.parse(readFileSync(job.path, 'utf8'));
  request.operation = 'restart';
  request.supervisor = 'pm2';
  writeFileSync(job.path, JSON.stringify(request));
  const restart = vi.fn();
  await expect(
    runLifecycle(job.path, {
      plan: async () => ({ kind: 'checkout', root: '/', service: true, worker: true }),
      restart,
    })
  ).rejects.toThrow('Worker became active');
  expect(restart).not.toHaveBeenCalled();
  expect(job.result()).toMatchObject({ state: 'failed', exitCode: 1 });
});

it('rejects an obsolete queued update before inspecting or restarting targets', async () => {
  fixture();
  vi.mocked(spawnSync).mockReturnValue(ok('active'));
  const job = requestFrom(await queueLifecycle('restart', {}));
  const request = JSON.parse(readFileSync(job.path, 'utf8'));
  request.operation = 'update';
  writeFileSync(job.path, JSON.stringify(request));
  const plan = vi.fn();
  const restart = vi.fn();
  await expect(runLifecycle(job.path, { plan, restart })).rejects.toThrow(
    'Unsupported lifecycle operation'
  );
  expect(plan).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
  expect(job.result()).toMatchObject({ state: 'failed', exitCode: 1 });
});
