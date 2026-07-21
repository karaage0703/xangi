import { access, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { uninstallCmd } from '../src/cli/uninstall-cmd.js';
import { resolveAppLayout } from '../src/installer/layout.js';
import type { ServiceAdapter } from '../src/installer/platform/service.js';
import type { UpdateSchedulerAdapter } from '../src/installer/platform/update-scheduler.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeService(): ServiceAdapter & { uninstalls: number } {
  return {
    uninstalls: 0,
    async install() {},
    async start() {},
    async stop() {},
    async autostart(_enabled: boolean) {},
    async restart() {},
    async uninstall() {
      this.uninstalls += 1;
    },
    async status() {
      return { running: true, detail: 'fixture' };
    },
    async openBrowser() {},
  };
}

function fakeScheduler(): UpdateSchedulerAdapter & { uninstalls: number } {
  return {
    uninstalls: 0,
    async install() {},
    async uninstall() {
      this.uninstalls += 1;
    },
    async status() {
      return { installed: true, detail: 'fixture' };
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xangi-uninstall-'));
  roots.push(root);
  const layout = resolveAppLayout({ platform: 'linux', arch: 'x64', homeDir: root });
  await Promise.all([
    mkdir(layout.appRoot, { recursive: true }),
    mkdir(layout.configDir, { recursive: true }),
    mkdir(layout.stateDir, { recursive: true }),
    mkdir(layout.workspaceDir, { recursive: true }),
    mkdir(join(root, '.local', 'bin'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(layout.appRoot, 'version.txt'), '1.0.0'),
    writeFile(join(layout.configDir, 'secrets.json'), '{"kept":true}'),
    writeFile(join(layout.stateDir, 'session.json'), '{"kept":true}'),
    writeFile(join(layout.workspaceDir, 'AGENTS.md'), 'my workspace'),
  ]);
  await symlink(join(layout.appRoot, 'bin', 'xangi'), join(root, '.local', 'bin', 'xangi'));
  return { root, layout, service: fakeService(), scheduler: fakeScheduler() };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('managed uninstall command', () => {
  it('removes the service, scheduler, and app while preserving reinstall data', async () => {
    const { root, layout, service, scheduler } = await fixture();

    const output = await uninstallCmd(
      {},
      {
        layout,
        service,
        updateScheduler: scheduler,
        platform: 'linux',
        arch: 'x64',
        homeDir: root,
      }
    );

    expect(service.uninstalls).toBe(1);
    expect(scheduler.uninstalls).toBe(1);
    expect(await exists(layout.appRoot)).toBe(false);
    expect(await exists(join(root, '.local', 'bin', 'xangi'))).toBe(false);
    expect(await readFile(join(layout.configDir, 'secrets.json'), 'utf8')).toBe('{"kept":true}');
    expect(await readFile(join(layout.stateDir, 'session.json'), 'utf8')).toBe('{"kept":true}');
    expect(await readFile(join(layout.workspaceDir, 'AGENTS.md'), 'utf8')).toBe('my workspace');
    expect(output).toContain('Kept workspace, settings, tokens, and state.');
    expect(output).toContain('install.sh | bash');
  });

  it('requires explicit confirmation before purging config and state', async () => {
    const { layout, service, scheduler } = await fixture();

    await expect(
      uninstallCmd(
        { purge: true },
        { layout, service, updateScheduler: scheduler, platform: 'linux', arch: 'x64' }
      )
    ).rejects.toThrow('--purge --yes');

    expect(service.uninstalls).toBe(0);
    expect(scheduler.uninstalls).toBe(0);
    expect(await exists(layout.appRoot)).toBe(true);
    expect(await exists(layout.configDir)).toBe(true);
    expect(await exists(layout.stateDir)).toBe(true);
  });

  it('preserves a ~/.local/bin/xangi symlink that it does not own', async () => {
    const { root, layout, service, scheduler } = await fixture();
    const commandLink = join(root, '.local', 'bin', 'xangi');
    await rm(commandLink);
    const unrelatedTarget = join(root, 'another-xangi');
    await symlink(unrelatedTarget, commandLink);

    await uninstallCmd(
      {},
      {
        layout,
        service,
        updateScheduler: scheduler,
        platform: 'linux',
        arch: 'x64',
        homeDir: root,
      }
    );

    await expect(readlink(commandLink)).resolves.toBe(unrelatedTarget);
  });

  it('purges config and state but never removes the workspace', async () => {
    const { layout, service, scheduler } = await fixture();

    const output = await uninstallCmd(
      { purge: true, yes: true },
      { layout, service, updateScheduler: scheduler, platform: 'linux', arch: 'x64' }
    );

    expect(service.uninstalls).toBe(1);
    expect(scheduler.uninstalls).toBe(1);
    expect(await exists(layout.appRoot)).toBe(false);
    expect(await exists(layout.configDir)).toBe(false);
    expect(await exists(layout.stateDir)).toBe(false);
    expect(await readFile(join(layout.workspaceDir, 'AGENTS.md'), 'utf8')).toBe('my workspace');
    expect(output).toContain('Kept workspace.');
  });
});
