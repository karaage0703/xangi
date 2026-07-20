import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const roots: string[] = [];
const launcherSource = fileURLToPath(new URL('../bin/xangi', import.meta.url));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xangi-launcher-'));
  roots.push(root);
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'packaging'), { recursive: true });
  await copyFile(launcherSource, join(root, 'bin', 'xangi'));
  await chmod(join(root, 'bin', 'xangi'), 0o755);
  return root;
}

describe('bin/xangi', () => {
  it('runs current TypeScript in a checkout instead of an ignored stale dist build', async () => {
    const root = await fixture();
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'src', 'cli'), { recursive: true });
    await mkdir(join(root, 'dist', 'cli'), { recursive: true });
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(root, 'src', 'cli', 'xangi-main.ts'), '// current source\n');
    await writeFile(join(root, 'dist', 'cli', 'xangi-main.js'), 'console.log("stale-dist")\n');
    const tsx = join(root, 'node_modules', '.bin', 'tsx');
    await writeFile(tsx, '#!/bin/sh\nprintf "tsx:%s\\n" "$*"\n');
    await chmod(tsx, 0o755);

    const { stdout } = await exec(join(root, 'bin', 'xangi'), ['setup']);
    expect(stdout.trim()).toBe(`tsx:${join(root, 'src', 'cli', 'xangi-main.ts')} setup`);
    expect(stdout).not.toContain('stale-dist');
  });

  it('requires local dependencies instead of silently running stale dist in a checkout', async () => {
    const root = await fixture();
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'src', 'cli'), { recursive: true });
    await mkdir(join(root, 'dist', 'cli'), { recursive: true });
    await writeFile(join(root, 'src', 'cli', 'xangi-main.ts'), '// current source\n');
    await writeFile(join(root, 'dist', 'cli', 'xangi-main.js'), 'console.log("stale-dist")\n');

    await expect(exec(join(root, 'bin', 'xangi'), ['setup'])).rejects.toMatchObject({
      stderr: expect.stringContaining('Run npm ci first'),
    });
  });

  it('runs compiled JavaScript from a managed distribution without source files', async () => {
    const root = await fixture();
    await mkdir(join(root, 'dist', 'cli'), { recursive: true });
    await writeFile(
      join(root, 'dist', 'cli', 'xangi-main.js'),
      'console.log(`dist:${process.argv.slice(2).join(",")}`)\n'
    );

    const { stdout } = await exec(join(root, 'bin', 'xangi'), ['setup']);
    expect(stdout.trim()).toBe('dist:setup');
  });

  it('dispatches a plain update to the checkout updater', async () => {
    const root = await fixture();
    await mkdir(join(root, '.git'));
    const updater = join(root, 'packaging', 'update-checkout.sh');
    await writeFile(updater, '#!/bin/sh\nprintf "checkout-update:%s\\n" "$*"\n');
    await chmod(updater, 0o755);

    const { stdout } = await exec(join(root, 'bin', 'xangi'), ['update']);
    expect(stdout.trim()).toBe(`checkout-update:${root}`);
  });

  it('keeps an explicit managed update on the TypeScript CLI path', async () => {
    const root = await fixture();
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'src', 'cli'), { recursive: true });
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(root, 'src', 'cli', 'xangi-main.ts'), '// current source\n');
    const tsx = join(root, 'node_modules', '.bin', 'tsx');
    await writeFile(tsx, '#!/bin/sh\nprintf "tsx:%s\\n" "$*"\n');
    await chmod(tsx, 0o755);

    const { stdout } = await exec(join(root, 'bin', 'xangi'), ['update', '--managed']);
    expect(stdout.trim()).toBe(`tsx:${join(root, 'src', 'cli', 'xangi-main.ts')} update --managed`);
  });
});
