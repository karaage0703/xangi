import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createDarwinServiceAdapter,
  renderLaunchAgentPlist,
  type DarwinCommandRunner,
  type DarwinServiceOptions,
} from '../src/installer/platform/darwin.js';
import { managedServicePath } from '../src/installer/service-environment.js';
import { resolveAppLayout } from '../src/installer/layout.js';

describe('renderLaunchAgentPlist', () => {
  it('includes an NVM backend directory in the managed LaunchAgent PATH', () => {
    const homeDir = '/Users/tester';
    const layout = resolveAppLayout({ platform: 'darwin', arch: 'arm64', homeDir });
    const executable = `${homeDir}/.nvm/versions/node/v22.16.0/bin/codex`;
    const plist = renderLaunchAgentPlist({
      label: 'dev.xangi.app',
      nodePath: '/opt/xangi/node',
      entrypoint: '/opt/xangi/dist/index.js',
      configLoaderPath: '/opt/xangi/dist/installer/runtime-config-main.js',
      configPath: `${homeDir}/Library/Application Support/xangi/config/xangi.json`,
      stateDir: `${homeDir}/Library/Application Support/xangi/state`,
      workingDirectory: `${homeDir}/Library/Application Support/xangi/app/current`,
      stdoutPath: '/tmp/xangi.log',
      stderrPath: '/tmp/xangi.error.log',
      path: managedServicePath(layout, homeDir, executable),
    });
    expect(plist).toContain(`${homeDir}/.nvm/versions/node/v22.16.0/bin`);
    expect(plist).toContain('/opt/homebrew/bin');
  });

  it('renders explicit executable, config, workdir, logs, and a deterministic PATH', () => {
    const plist = renderLaunchAgentPlist({
      label: 'jp.example.xangi',
      nodePath: '/Users/Test User/xangi/node',
      entrypoint: '/Users/Test User/xangi/current/dist/index.js',
      configLoaderPath: '/Users/Test User/xangi/current/dist/installer/runtime-config-main.js',
      configPath: '/Users/Test User/Library/Application Support/xangi/config/xangi.json',
      stateDir: '/Users/Test User/Library/Application Support/xangi/state',
      workingDirectory: '/Users/Test User/Library/Application Support/xangi/app/current',
      stdoutPath: '/Users/Test User/Library/Logs/xangi/out.log',
      stderrPath: '/Users/Test User/Library/Logs/xangi/err.log',
      path: '/Users/Test User/.local/bin:/usr/bin:/bin',
    });

    expect(plist).toContain('<string>/Users/Test User/xangi/node</string>');
    expect(plist).toContain(
      '<string>/Users/Test User/Library/Application Support/xangi/config/xangi.json</string>'
    );
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('/Users/Test User/.local/bin:/usr/bin:/bin');
  });

  it('escapes XML metacharacters', () => {
    const plist = renderLaunchAgentPlist({
      label: 'jp.example.xangi',
      nodePath: '/tmp/a&b/node',
      entrypoint: '/tmp/<current>/index.js',
      configLoaderPath: '/tmp/runtime-config-main.js',
      configPath: '/tmp/"config".json',
      stateDir: '/tmp/state',
      workingDirectory: "/tmp/a'b",
      stdoutPath: '/tmp/out.log',
      stderrPath: '/tmp/err.log',
      path: '/usr/bin:/bin',
    });
    expect(plist).toContain('a&amp;b');
    expect(plist).toContain('&lt;current&gt;');
    expect(plist).toContain('&quot;config&quot;');
    expect(plist).toContain('a&apos;b');
  });
});

describe('Darwin service adapter', () => {
  function fixture(root: string): DarwinServiceOptions {
    return {
      label: 'dev.xangi.app',
      nodePath: '/opt/xangi/node',
      entrypoint: '/opt/xangi/dist/index.js',
      configLoaderPath: '/opt/xangi/dist/installer/runtime-config-main.js',
      configPath: '/Users/me/Library/Application Support/xangi/config/xangi.json',
      stateDir: '/Users/me/Library/Application Support/xangi/state',
      workingDirectory: '/Users/me/Library/Application Support/xangi/app/current',
      stdoutPath: join(root, 'logs', 'out', 'xangi.log'),
      stderrPath: join(root, 'logs', 'err', 'xangi.log'),
      path: '/usr/local/bin:/usr/bin:/bin',
      plistPath: join(root, 'config', 'service', 'dev.xangi.app.plist'),
      autostartPlistPath: join(root, 'LaunchAgents', 'dev.xangi.app.plist'),
    };
  }

  it('installs, restarts, reports status, and opens only loopback URLs through the adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-darwin-'));
    const calls: Array<[string, string[], boolean | undefined]> = [];
    const commands: DarwinCommandRunner = {
      run: vi.fn((command, args, allowFailure) => {
        calls.push([command, args, allowFailure]);
        return '';
      }),
      status: vi.fn(() => ({ status: 0, output: 'running' })),
    };
    const options = fixture(root);
    const adapter = createDarwinServiceAdapter(options, commands);

    await adapter.install();
    await adapter.restart();
    expect(await adapter.status()).toEqual({ running: true, detail: 'running' });
    await adapter.openBrowser('http://127.0.0.1:1234/setup');
    await expect(adapter.openBrowser('https://example.com/setup')).rejects.toThrow(/loopback/i);

    expect(await readFile(options.plistPath, 'utf8')).toContain('dev.xangi.app');
    await adapter.uninstall();
    await expect(access(options.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(root, 'logs', 'out'))).isDirectory()).toBe(true);
    expect((await stat(join(root, 'logs', 'err'))).isDirectory()).toBe(true);
    expect(calls.map(([command]) => command)).toEqual([
      'launchctl',
      'launchctl',
      'launchctl',
      'open',
      'launchctl',
    ]);
  });

  it('starts and stops a registered LaunchAgent without enabling autostart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-darwin-lifecycle-'));
    const calls: Array<[string, string[], boolean | undefined]> = [];
    let running = false;
    const commands: DarwinCommandRunner = {
      run: vi.fn((command, args, allowFailure) => {
        calls.push([command, args, allowFailure]);
        if (command === 'launchctl' && args[0] === 'bootstrap') running = true;
        if (command === 'launchctl' && args[0] === 'bootout') running = false;
        return '';
      }),
      status: vi.fn(() => ({ status: running ? 0 : 1, output: running ? 'running' : '' })),
    };
    const options = fixture(root);
    const adapter = createDarwinServiceAdapter(options, commands);
    await adapter.install();
    await adapter.stop();
    await adapter.stop();
    await adapter.start();
    await adapter.start();

    await expect(access(options.plistPath)).resolves.toBeUndefined();
    await expect(access(options.autostartPlistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls.map(([, args]) => args[0])).toEqual([
      'bootout',
      'bootstrap',
      'bootout',
      'bootstrap',
    ]);
  });

  it('enables and disables autostart without stopping the current service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-darwin-autostart-'));
    const commands: DarwinCommandRunner = {
      run: vi.fn(() => ''),
      status: vi.fn(() => ({ status: 0, output: 'running' })),
    };
    const options = fixture(root);
    const adapter = createDarwinServiceAdapter(options, commands);

    await adapter.install();
    await expect(access(options.autostartPlistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await adapter.autostart(true);
    expect(await readFile(options.autostartPlistPath, 'utf8')).toContain('dev.xangi.app');
    await adapter.autostart(false);
    await expect(access(options.autostartPlistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(commands.run).toHaveBeenCalledTimes(2);
    await adapter.autostart(true);
    await adapter.uninstall();
    await expect(access(options.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(options.autostartPlistPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
