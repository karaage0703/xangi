import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createLinuxServiceAdapter,
  isWsl,
  openLinuxBrowser,
  renderSystemdUserUnit,
  type LinuxCommandRunner,
  type SystemdUserServiceOptions,
} from '../src/installer/platform/linux.js';
import { managedServicePath } from '../src/installer/service-environment.js';
import { resolveAppLayout } from '../src/installer/layout.js';

const SETUP_TOKEN = 'A'.repeat(43);
const SETUP_URL = `http://127.0.0.1:1234/setup?token=${SETUP_TOKEN}`;

function fixture(root: string, wsl = false): SystemdUserServiceOptions {
  return {
    unitName: 'xangi.service',
    unitPath: join(root, '.config', 'systemd', 'user', 'xangi.service'),
    nodePath: '/home/Test User/.local/share/xangi/app/current/runtime/bin/node',
    configLoaderPath:
      '/home/Test User/.local/share/xangi/app/current/dist/installer/runtime-config-main.js',
    configPath: '/home/Test User/.config/xangi/xangi.json',
    stateDir: '/home/Test User/.local/state/xangi',
    entrypoint: '/home/Test User/.local/share/xangi/app/current/dist/index.js',
    workingDirectory: '/home/Test User/.local/share/xangi/app/current',
    path: '/home/Test User/.local/bin:/usr/bin:/bin',
    wsl,
  };
}

describe('renderSystemdUserUnit', () => {
  it('includes a user-local backend directory in the managed systemd PATH', () => {
    const homeDir = '/home/tester';
    const layout = resolveAppLayout({ platform: 'linux', arch: 'x64', homeDir });
    const executable = `${homeDir}/.local/bin/claude`;
    const unit = renderSystemdUserUnit({
      ...fixture('/tmp'),
      path: managedServicePath(layout, homeDir, executable),
    });
    expect(unit).toContain(`PATH=${homeDir}/.local/bin`);
    expect(unit).toContain('/usr/local/bin:/usr/bin:/bin');
  });

  it('renders quoted paths, restart behavior, and an explicit PATH', () => {
    const unit = renderSystemdUserUnit(fixture('/home/test'));
    expect(unit).toContain(
      'ExecStart="/home/Test User/.local/share/xangi/app/current/runtime/bin/node"'
    );
    expect(unit).toContain('WorkingDirectory="/home/Test User/.local/share/xangi/app/current"');
    expect(unit).toContain('Environment="PATH=/home/Test User/.local/bin:/usr/bin:/bin"');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('rejects unsafe unit names and values', () => {
    expect(() =>
      renderSystemdUserUnit({ ...fixture('/tmp'), unitName: '../xangi.service' })
    ).toThrow(/unit name/i);
    expect(() =>
      renderSystemdUserUnit({ ...fixture('/tmp'), configPath: '/tmp/config\nother' })
    ).toThrow(/control/i);
  });
});

describe('WSL detection and browser opening', () => {
  it('detects WSL from environment or the kernel version', () => {
    expect(isWsl({ env: { WSL_INTEROP: '/run/WSL/1_interop' }, procVersion: '' })).toBe(true);
    expect(isWsl({ env: {}, procVersion: 'Linux version 6.6.87.2-microsoft-standard-WSL2' })).toBe(
      true
    );
    expect(isWsl({ env: {}, procVersion: 'Linux version 6.8.0-generic' })).toBe(false);
  });

  it('uses xdg-open natively, wslview when available, and cmd.exe as WSL fallback', () => {
    const calls: Array<[string, string[], boolean | undefined]> = [];
    const native = runner(calls, () => ({ status: 1, output: '' }));
    openLinuxBrowser(SETUP_URL, native, false);
    expect(calls.pop()).toEqual(['xdg-open', [SETUP_URL], undefined]);

    const withWslView = runner(calls, () => ({ status: 0, output: 'wslview 1' }));
    openLinuxBrowser(SETUP_URL, withWslView, true);
    expect(calls.pop()).toEqual(['wslview', [SETUP_URL], undefined]);

    const withoutWslView = runner(calls, () => ({ status: 1, output: '' }));
    openLinuxBrowser(SETUP_URL, withoutWslView, true);
    expect(calls.pop()).toEqual(['cmd.exe', ['/c', 'start', '', SETUP_URL], undefined]);
    for (const unsafe of [
      'https://example.com/setup?token=' + SETUP_TOKEN,
      'http://127.0.0.1:1234/other?token=' + SETUP_TOKEN,
      'http://127.0.0.1:1234/setup?token=' + SETUP_TOKEN + '&extra=1',
      'http://127.0.0.1:1234/setup?token=' + SETUP_TOKEN + '#fragment',
      'http://user@127.0.0.1:1234/setup?token=' + SETUP_TOKEN,
      'http://127.0.0.1:1234/setup?token=' + SETUP_TOKEN + '%26calc.exe',
    ]) {
      expect(() => openLinuxBrowser(unsafe, native, false)).toThrow(/loopback/i);
    }
  });
});

describe('Linux systemd user service adapter', () => {
  it('installs, starts, stops, restarts, reports status, and uninstalls the user unit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-linux-'));
    const calls: Array<[string, string[], boolean | undefined]> = [];
    const commands: LinuxCommandRunner = {
      run: vi.fn((command, args, allowFailure) => {
        calls.push([command, args, allowFailure]);
        return '';
      }),
      status: vi.fn((command, args) => {
        if (command === 'systemctl' && args.includes('show-environment')) {
          return { status: 0, output: 'PATH=/usr/bin' };
        }
        return { status: 0, output: 'active' };
      }),
    };
    const options = fixture(root);
    const adapter = createLinuxServiceAdapter(options, commands);

    await adapter.install();
    expect(await readFile(options.unitPath, 'utf8')).toContain('xangi AI assistant');
    expect((await stat(options.unitPath)).mode & 0o777).toBe(0o644);
    await adapter.stop();
    await adapter.start();
    await adapter.autostart(true);
    await adapter.autostart(false);
    await adapter.restart();
    expect(await adapter.status()).toEqual({ running: true, detail: 'active' });
    await adapter.uninstall();
    await expect(access(options.unitPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toEqual([
      ['systemctl', ['--user', 'daemon-reload'], undefined],
      ['systemctl', ['--user', 'start', 'xangi.service'], undefined],
      ['systemctl', ['--user', 'stop', 'xangi.service'], undefined],
      ['systemctl', ['--user', 'start', 'xangi.service'], undefined],
      ['systemctl', ['--user', 'enable', 'xangi.service'], undefined],
      ['systemctl', ['--user', 'disable', 'xangi.service'], undefined],
      ['systemctl', ['--user', 'restart', 'xangi.service'], undefined],
      ['systemctl', ['--user', 'disable', '--now', 'xangi.service'], true],
      ['systemctl', ['--user', 'daemon-reload'], true],
    ]);
  });

  it('gives an actionable WSL error when systemd is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-wsl-'));
    const commands = runner([], () => ({ status: 1, output: 'Failed to connect to bus' }));
    const adapter = createLinuxServiceAdapter(fixture(root, true), commands);
    await expect(adapter.install()).rejects.toThrow(/\/etc\/wsl\.conf/);
    await expect(access(fixture(root, true).unitPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function runner(
  calls: Array<[string, string[]]> | Array<[string, string[], boolean | undefined]>,
  status: LinuxCommandRunner['status']
): LinuxCommandRunner {
  return {
    run(command, args, allowFailure) {
      (calls as Array<[string, string[], boolean | undefined]>).push([command, args, allowFailure]);
      return '';
    },
    status,
  };
}
