import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const updaterSource = fileURLToPath(new URL('../packaging/update-checkout.sh', import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

describe('checkout updater', () => {
  it.each(['--help', '-h'])('prints update help without inspecting checkout state for %s', async (flag) => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-update-help-'));
    roots.push(root);
    await git(root, 'init');
    await writeFile(join(root, 'package.json'), '{"dirty":true}\n');

    const { stdout, stderr } = await exec(updaterSource, [root, flag]);

    expect(stderr).toBe('');
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('xangi update --managed');
    expect(stdout).toContain('service is not restarted automatically');
  });

  it('refuses a checkout with uncommitted changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-update-dirty-'));
    roots.push(root);
    await git(root, 'init');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'Test');
    await writeFile(join(root, 'package.json'), '{}\n');
    await git(root, 'add', 'package.json');
    await git(root, 'commit', '-m', 'initial');
    await writeFile(join(root, 'package.json'), '{"dirty":true}\n');

    await expect(exec(updaterSource, [root])).rejects.toMatchObject({
      stderr: expect.stringContaining('checkout has uncommitted changes'),
    });
  });

  it('fast-forwards, installs dependencies, and builds a clean checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-update-remote-'));
    roots.push(root);
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const checkout = join(root, 'checkout');
    const fakeBin = join(root, 'bin');
    const npmLog = join(root, 'npm.log');
    const serviceLog = join(root, 'service.log');
    await mkdir(seed);
    await mkdir(fakeBin);
    await mkdir(join(seed, 'bin'));
    await git(root, 'init', '--bare', remote);
    await git(seed, 'init', '-b', 'main');
    await git(seed, 'config', 'user.email', 'test@example.com');
    await git(seed, 'config', 'user.name', 'Test');
    await mkdir(join(seed, 'packaging'));
    await copyFile(updaterSource, join(seed, 'packaging', 'update-checkout.sh'));
    await chmod(join(seed, 'packaging', 'update-checkout.sh'), 0o755);
    await writeFile(join(seed, 'package.json'), '{}\n');
    await writeFile(
      join(seed, 'bin', 'xangi'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SERVICE_LOG"\n'
    );
    await chmod(join(seed, 'bin', 'xangi'), 0o755);
    await git(seed, 'add', 'package.json', 'packaging/update-checkout.sh', 'bin/xangi');
    await git(seed, 'commit', '-m', 'initial');
    await git(seed, 'remote', 'add', 'origin', remote);
    await git(seed, 'push', '-u', 'origin', 'main');
    await git(root, 'clone', '--branch', 'main', remote, checkout);

    await writeFile(join(seed, 'updated.txt'), 'new version\n');
    await git(seed, 'add', 'updated.txt');
    await git(seed, 'commit', '-m', 'update');
    await git(seed, 'push');
    const fakeNpm = join(fakeBin, 'npm');
    await writeFile(fakeNpm, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_LOG"\n');
    await chmod(fakeNpm, 0o755);
    const { stdout } = await exec(join(checkout, 'packaging', 'update-checkout.sh'), [checkout], {
      env: {
        ...process.env,
        NPM_LOG: npmLog,
        SERVICE_LOG: serviceLog,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
    });

    expect(await readFile(join(checkout, 'updated.txt'), 'utf8')).toBe('new version\n');
    expect(await readFile(npmLog, 'utf8')).toBe('ci\nrun build\n');
    await expect(readFile(serviceLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stdout).toContain('Updated xangi checkout: main');
    expect(stdout).toContain('Build: complete');

    await expect(
      exec(join(checkout, 'packaging', 'update-checkout.sh'), [checkout, '--restart'])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('unknown checkout update option: --restart'),
    });
  });
});
