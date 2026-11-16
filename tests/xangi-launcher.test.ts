import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it.each(['changed', 'unchanged', 'pull failure', 'ci failure', 'build failure'])(
    'checkout update through the real launcher never calls restart after %s',
    async (mode) => {
      const root = await fixture();
      await mkdir(join(root, '.git'));
      await writeFile(join(root, 'package.json'), '{}');
      await copyFile(
        new URL('../packaging/update-checkout.sh', import.meta.url),
        join(root, 'packaging', 'update-checkout.sh')
      );
      const fakeBin = join(root, 'fake-bin');
      await mkdir(fakeBin);
      await writeFile(
        join(fakeBin, 'git'),
        `#!/bin/sh
case "$1" in
  status) exit 0;;
  symbolic-ref) echo main;;
  rev-parse) if [ "$2" = HEAD ] && [ -f pulled ] && [ "$MODE" != unchanged ]; then echo def5678; else echo abc1234; fi;;
  pull) [ "$MODE" != 'pull failure' ] || exit 7; touch pulled;;
esac
`
      );
      await writeFile(
        join(fakeBin, 'npm'),
        `#!/bin/sh
echo "$*" >> npm-calls
[ "$MODE" != "$1 failure" ] || exit 7
[ "$MODE" != 'build failure' ] || [ "$1" != run ] || exit 7
if [ "$1" = run ]; then
  # Any use of the newly built launcher would be observable and fail.
  printf '#!/bin/sh\necho "$*" >> launcher-calls\nexit 9\n' > bin/xangi
fi
`
      );
      await chmod(join(fakeBin, 'git'), 0o755);
      await chmod(join(fakeBin, 'npm'), 0o755);
      const result = await exec(join(root, 'bin', 'xangi'), ['update'], {
        env: { ...process.env, MODE: mode, BASH_ENV: '', PATH: `${fakeBin}:/usr/bin:/bin` },
      }).then(
        (value) => ({ ...value, code: 0 }),
        (error) => error
      );
      expect(result.code, result.stderr).toBe(mode.includes('failure') ? 7 : 0);
      await expect(readFile(join(root, 'launcher-calls'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      if (mode.includes('failure')) expect(result.stdout).not.toContain('run `xangi restart`');
      else expect(result.stdout).toContain('run `xangi restart`');
    }
  );
});
