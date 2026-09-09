import * as childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerCmd } from '../src/cli/worker-cmd.js';
import {
  installLinuxWorker,
  manageLinuxWorker,
  renderWorkerUnit,
  workerUnitPath,
} from '../src/remote-worker/systemd.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
}));

let root: string;
let calls: string[][];
let state: string;
let failure: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worker-systemd-'));
  calls = [];
  failure = '';
  state = 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123';
  vi.stubEnv('XANGI_WORKER_HOME', join(root, 'worker'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XANGI_WORKER_CLI', '/opt/xangi/bin/xangi');
  vi.mocked(childProcess.spawnSync).mockImplementation((command, args) => {
    expect(command).toBe('systemctl');
    const argv = args as string[];
    calls.push(argv);
    return {
      pid: 1,
      output: [],
      signal: null,
      status: argv.includes(failure) ? 1 : 0,
      stdout: argv.includes('show') ? state : '',
      stderr: argv.includes(failure) ? 'no user bus' : '',
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function installed(): void {
  mkdirSync(join(root, 'worker'));
  writeFileSync(join(root, 'worker', 'worker.json'), '{"preserve":"config"}', { mode: 0o600 });
  writeFileSync(join(root, 'worker', 'worker.token'), 'keep-token', { mode: 0o600 });
}

describe('Linux/WSL2 worker management', () => {
  it('checks the user manager before consuming a pairing code', async () => {
    failure = 'show-environment';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(installLinuxWorker('invalid', root)).rejects.toThrow('systemd user manager');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('installs a paired worker with private credentials and enables its unit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            workerId: 'wsl',
            gatewayUrl: 'ws://127.0.0.1:1234/connect',
            token: 'new-token',
          })
        )
      )
    );
    const pair =
      'xangi-pair://' +
      Buffer.from(
        JSON.stringify({
          version: 1,
          pairUrl: 'http://127.0.0.1:1234/pair',
          code: 'once',
          workerId: 'wsl',
          expiresAt: Date.now() + 60_000,
        })
      ).toString('base64url');
    await expect(installLinuxWorker(pair, root)).resolves.toContain('installed: wsl');
    expect(readFileSync(join(root, 'worker', 'worker.token'), 'utf8')).toBe('new-token\n');
    for (const file of ['worker.json', 'worker.token']) {
      expect(statSync(join(root, 'worker', file)).mode & 0o777).toBe(0o600);
    }
    const config = JSON.parse(readFileSync(join(root, 'worker', 'worker.json'), 'utf8'));
    expect(config.workspaceRoots).toEqual([root]);
    expect(config.allowedCommands).toContain(process.execPath);
    expect(calls).toContainEqual(['--user', 'enable', '--now', 'xangi-worker.service']);
    expect(readFileSync(workerUnitPath(), 'utf8')).not.toContain('new-token');
  });

  it('does not overwrite an existing installation during install', async () => {
    installed();
    await expect(installLinuxWorker('unused', root)).rejects.toThrow('already installed');
    expect(readFileSync(join(root, 'worker', 'worker.token'), 'utf8')).toBe('keep-token');
  });

  it('refreshes the CLI on restart without changing credentials', () => {
    installed();
    expect(manageLinuxWorker('restart')).toContain('restarted');
    expect(readFileSync(workerUnitPath(), 'utf8')).toContain('/opt/xangi/bin/xangi');
    expect(readFileSync(join(root, 'worker', 'worker.json'), 'utf8')).toBe('{"preserve":"config"}');
    expect(readFileSync(join(root, 'worker', 'worker.token'), 'utf8')).toBe('keep-token');
    expect(calls.slice(-2)).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'restart', 'xangi-worker.service'],
    ]);
  });

  it.each([
    ['LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0', 'not running'],
    ['LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=0', 'not running'],
    ['LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0', 'not running'],
    ['LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0', 'not installed'],
  ])('does not misreport an inactive service: %s', (output, expected) => {
    state = output;
    expect(manageLinuxWorker('status')).toContain(expected);
  });

  it('reports a running PID through the Linux CLI dispatch', async () => {
    if (process.platform !== 'linux') return;
    await expect(workerCmd('status', {})).resolves.toContain('running (PID 123');
  });

  it('propagates restart failures', () => {
    installed();
    failure = 'restart';
    expect(() => manageLinuxWorker('restart')).toThrow('no user bus');
  });

  it('stops and uninstalls without deleting unrelated files', () => {
    installed();
    manageLinuxWorker('start');
    expect(manageLinuxWorker('stop')).toContain('stopped');
    writeFileSync(join(root, 'worker', 'keep.txt'), 'unrelated');
    expect(manageLinuxWorker('uninstall')).toContain('uninstalled');
    expect(calls).toContainEqual(['--user', 'disable', '--now', 'xangi-worker.service']);
    expect(readFileSync(join(root, 'worker', 'keep.txt'), 'utf8')).toBe('unrelated');
  });

  it('escapes systemd expansions and rejects injected directives', () => {
    const unit = renderWorkerUnit('/opt/my node', ['a"b\\c%h${HOME}'], '/tmp/my config');
    expect(unit).toContain('"/opt/my node"');
    expect(unit).toContain('a\\"b\\\\c%%h$${HOME}');
    expect(() => renderWorkerUnit('/bin/node', [], '/tmp/a\nExecStart=/bin/sh')).toThrow(
      'control characters'
    );
  });
});
