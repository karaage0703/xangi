import { spawnSync } from 'node:child_process';
import { statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentManagedInvocation,
  planRestart,
  restartComponents,
} from '../src/cli/restart-cmd.js';
import { lifecycleSubmission, queueLifecycle, runLifecycle } from '../src/cli/lifecycle-cmd.js';
import { restartMacWorkerNow, workerInstallLayout } from '../src/remote-worker/install.js';
import { manageLinuxWorker, workerUnitPath } from '../src/remote-worker/systemd.js';
import type { ServiceAdapter } from '../src/installer/platform/service.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(), execFile: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(spawnSync).mockReset();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'xangi-restart-'));
  roots.push(root);
  return root;
}
function success(output = '') {
  return {
    pid: 1,
    output: [null, output, ''],
    stdout: output,
    stderr: '',
    status: 0,
    signal: null,
  } as ReturnType<typeof spawnSync>;
}
const plan = { kind: 'managed' as const, root: '/app/current', service: true, worker: true };

describe('local lifecycle orchestration', () => {
  it('restarts worker before app and reports skipped components', async () => {
    const events: string[] = [];
    const actions = {
      worker: async () => {
        events.push('worker');
        return 'worker done';
      },
      service: async () => {
        events.push('app');
        return 'app done';
      },
    };
    expect(await restartComponents(plan, actions)).toBe('worker done\napp done');
    expect(events).toEqual(['worker', 'app']);
    events.length = 0;
    expect(await restartComponents({ ...plan, service: false, worker: false }, actions)).toContain(
      'Skipped worker'
    );
    expect(events).toEqual([]);
  });
  it('propagates failures without restarting the app after worker failure', async () => {
    const service = vi.fn();
    await expect(
      restartComponents(plan, {
        worker: async () => {
          throw new Error('worker failed');
        },
        service,
      })
    ).rejects.toThrow('worker failed');
    expect(service).not.toHaveBeenCalled();
    await expect(
      restartComponents(plan, {
        worker: async () => 'ok',
        service: async () => {
          throw new Error('app failed');
        },
      })
    ).rejects.toThrow('app failed');
  });
  it.each(['darwin', 'linux'])(
    '%s hands off to an OS-owned job, without shell interpolation',
    (host) => {
      const submission = lifecycleSubmission(
        host,
        'dev.xangi.lifecycle.test',
        '/a b/out.log',
        '/a b/node',
        ['/a b/cli.js', 'lifecycle-run', '--request', '/a b/request.json']
      );
      expect(submission.command).toBe(host === 'darwin' ? 'launchctl' : 'systemd-run');
      expect(submission.args).toContain('/a b/node');
      expect(submission.args).toContain('/a b/request.json');
      expect(submission.args).not.toContain('sh');
    }
  );
  it('returns only acceptance with private durable result/log paths and propagates submission failure', async () => {
    const root = temp();
    vi.stubEnv('XANGI_INSTALLATION_KIND', 'managed');
    vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
    vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
    vi.mocked(spawnSync).mockReturnValue(success('active'));
    vi.stubEnv('XANGI_WORKER_HOME', root);
    const receipt = await queueLifecycle('restart', {});
    const path = /Result: (.+)/.exec(receipt)![1];
    expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('accepted');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(receipt).toContain('not completed');
    const request = JSON.parse(readFileSync(join(path, '..', 'request.json'), 'utf8'));
    expect(request.env.DATA_DIR).toBeUndefined();
    vi.mocked(spawnSync).mockImplementation((name) =>
      name === 'systemctl'
        ? success('active')
        : {
            ...success(),
            status: 1,
            stderr: 'manager unavailable',
          }
    );
    await expect(queueLifecycle('restart', {})).rejects.toThrow('manager unavailable');
  });
  it('records helper failures with a nonzero exit code after acceptance', async () => {
    const root = temp();
    const dir = join(root, 'lifecycle', 'test');
    mkdirSync(dir, { recursive: true });
    const resultPath = join(dir, 'result.json');
    const requestPath = join(dir, 'request.json');
    const previousEnv = { ...process.env };
    const previousExit = process.exitCode;
    writeFileSync(
      requestPath,
      JSON.stringify({
        operation: 'restart',
        flags: {},
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XANGI_INSTALLATION_KIND: 'checkout',
          XANGI_WORKER_HOME: root,
        },
        requesterPid: 2147483647,
        resultPath,
        logPath: join(dir, 'output.log'),
        label: 'dev.xangi.lifecycle.test',
      })
    );
    vi.mocked(spawnSync).mockReturnValue({ ...success(), status: 1, stderr: 'PM2 probe failed' });
    try {
      await expect(runLifecycle(requestPath)).rejects.toThrow('PM2 probe failed');
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
        state: 'failed',
        exitCode: 1,
      });
      expect(process.exitCode).toBe(1);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      process.exitCode = previousExit;
    }
  });
  it('skips an absent worker and absent PM2, and refuses a matching PM2 name in another checkout', async () => {
    vi.stubEnv('XANGI_INSTALLATION_KIND', 'checkout');
    vi.stubEnv('XANGI_WORKER_HOME', temp());
    vi.mocked(spawnSync).mockReturnValue({
      ...success(),
      error: Object.assign(new Error('not found'), { code: 'ENOENT' }),
    });
    expect(await planRestart()).toMatchObject({ service: false, worker: false });
    vi.mocked(spawnSync).mockImplementation((_name, _args, opts) =>
      success(
        JSON.stringify([
          {
            name: opts?.env?.XANGI_PROCESS_NAME,
            pm2_env: { status: 'online', pm_cwd: '/another-checkout' },
          },
        ])
      )
    );
    await expect(planRestart()).rejects.toThrow('belongs to another checkout');
  });
  it('selects only its own online PM2 app and a running local Linux worker', async () => {
    const root = temp();
    vi.stubEnv('XANGI_INSTALLATION_KIND', 'checkout');
    vi.stubEnv('XANGI_WORKER_HOME', root);
    vi.stubEnv('XDG_CONFIG_HOME', root);
    vi.mocked(spawnSync).mockReturnValue(success('[]'));
    const checkoutRoot = (await planRestart()).root;
    writeFileSync(join(root, 'worker.json'), '{}');
    mkdirSync(join(root, 'systemd', 'user'), { recursive: true });
    writeFileSync(workerUnitPath(), 'unit');
    vi.mocked(spawnSync).mockImplementation((name, _args, opts) =>
      name === 'pm2'
        ? success(
            JSON.stringify([
              {
                name: opts?.env?.XANGI_PROCESS_NAME,
                pm2_env: { status: 'online', pm_cwd: checkoutRoot },
              },
            ])
          )
        : success('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123')
    );
    expect(await planRestart()).toMatchObject({ root: checkoutRoot, service: true, worker: true });
  });
  it('preserves a stopped managed app and installed but inactive Linux worker', async () => {
    const root = temp();
    vi.stubEnv('XANGI_INSTALLATION_KIND', 'managed');
    vi.stubEnv('XANGI_WORKER_HOME', root);
    vi.stubEnv('XDG_CONFIG_HOME', root);
    writeFileSync(join(root, 'worker.json'), '{}');
    mkdirSync(join(root, 'systemd', 'user'), { recursive: true });
    writeFileSync(workerUnitPath(), 'unit');
    vi.mocked(spawnSync).mockReturnValue(
      success('LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0')
    );
    expect(
      await planRestart({ status: async () => ({ running: false, detail: '' }) } as ServiceAdapter)
    ).toMatchObject({ service: false, worker: false });
  });
});

describe('updated worker executable resolution', () => {
  it('renders managed current Node and CLI on Linux without pinning the helper version', () => {
    const root = temp();
    vi.stubEnv('XANGI_WORKER_HOME', root);
    vi.stubEnv('XDG_CONFIG_HOME', root);
    writeFileSync(join(root, 'worker.json'), '{}');
    vi.mocked(spawnSync).mockReturnValue(success());
    const invocation = currentManagedInvocation('/app/current');
    manageLinuxWorker('restart', invocation);
    const unit = readFileSync(workerUnitPath(), 'utf8');
    expect(unit).toContain('"/app/current/runtime/bin/node" "/app/current/dist/cli/xangi-main.js"');
    expect(unit).not.toContain('versions/');
    expect(vi.mocked(spawnSync).mock.calls.map((call) => call[1])).toEqual([
      ['--user', 'show-environment'],
      ['--user', 'daemon-reload'],
      ['--user', 'restart', 'xangi-worker.service'],
    ]);
  });
  it('refreshes the Mac plist and waits for bootout before bootstrap, preserving credentials', () => {
    const root = temp();
    vi.stubEnv('XANGI_WORKER_HOME', root);
    vi.stubEnv('XANGI_WORKER_LAUNCH_AGENTS_DIR', root);
    const layout = workerInstallLayout();
    writeFileSync(layout.configPath, '{}');
    writeFileSync(layout.tokenPath, 'keep-token');
    vi.mocked(spawnSync).mockImplementation((_name, args) => ({
      ...success(),
      status: args?.[0] === 'print' ? 113 : 0,
    }));
    restartMacWorkerNow(currentManagedInvocation('/app/current'));
    const plist = readFileSync(layout.plistPath, 'utf8');
    expect(plist).toContain('/app/current/runtime/bin/node');
    expect(plist).toContain('/app/current/dist/cli/xangi-main.js');
    expect(readFileSync(layout.tokenPath, 'utf8')).toBe('keep-token');
    expect(vi.mocked(spawnSync).mock.calls.map((call) => call[1]?.[0])).toEqual([
      'bootout',
      'print',
      'bootstrap',
    ]);
  });
});
