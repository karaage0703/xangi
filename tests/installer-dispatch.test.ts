import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runBootstrap(system: string, machine: string) {
  const root = await mkdtemp(join(tmpdir(), 'xangi-dispatch-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const requestedUrl = join(root, 'requested-url');
  const installerRan = join(root, 'installer-ran');
  const fixtureInstaller = join(root, 'fixture-installer.sh');
  await mkdir(bin);
  await writeFile(
    join(bin, 'uname'),
    `#!/bin/sh\n[ "\${1:-}" = -s ] && printf '%s\\n' "$FIXTURE_SYSTEM" || printf '%s\\n' "$FIXTURE_MACHINE"\n`
  );
  await writeFile(
    join(bin, 'curl'),
    `#!/bin/sh
set -eu
output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) output="$2"; shift 2 ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\n' "$url" > "$FIXTURE_URL_LOG"
cp "$FIXTURE_INSTALLER" "$output"
`
  );
  await writeFile(
    fixtureInstaller,
    '#!/bin/sh\nprintf "defer=%s tty=%s\\n" "${XANGI_INSTALL_DEFER_SETUP:-0}" "$([ -t 0 ] && echo yes || echo no)" > "$FIXTURE_RUN_LOG"\n'
  );
  await Promise.all([chmod(join(bin, 'uname'), 0o755), chmod(join(bin, 'curl'), 0o755)]);

  const result = await exec('bash', ['packaging/bootstrap.sh'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || ''}`,
      FIXTURE_SYSTEM: system,
      FIXTURE_MACHINE: machine,
      FIXTURE_URL_LOG: requestedUrl,
      FIXTURE_INSTALLER: fixtureInstaller,
      FIXTURE_RUN_LOG: installerRan,
      XANGI_RELEASE_BASE_URL: 'https://releases.example/latest/download',
    },
  });

  return {
    ...result,
    requestedUrl: await readFile(requestedUrl, 'utf8'),
    installerRan: await readFile(installerRan, 'utf8'),
  };
}

describe('cross-platform release bootstrap', () => {
  it.each([
    ['Darwin', 'arm64', 'xangi-installer-darwin-arm64.sh'],
    ['Darwin', 'x86_64', 'xangi-installer-darwin-x64.sh'],
    ['Linux', 'aarch64', 'xangi-installer-linux-arm64.sh'],
    ['Linux', 'x86_64', 'xangi-installer-linux-x64.sh'],
  ])('dispatches %s/%s to %s', async (system, machine, asset) => {
    const result = await runBootstrap(system, machine);

    expect(result.stderr).toBe('');
    expect(result.requestedUrl).toBe(`https://releases.example/latest/download/${asset}\n`);
    expect(result.installerRan).toBe('defer=1 tty=no\n');
  });

  it('reconnects a piped bootstrap to the controlling terminal when one exists', async () => {
    const bootstrap = await readFile('packaging/bootstrap.sh', 'utf8');

    expect(bootstrap).toContain('exec 3</dev/tty');
    expect(bootstrap).toContain('bash "$installer" <&3');
    expect(bootstrap).toContain('XANGI_INSTALL_DEFER_SETUP=1 bash "$installer"');
  });

  it('rejects unsupported operating systems', async () => {
    await expect(runBootstrap('Windows_NT', 'x86_64')).rejects.toMatchObject({
      stderr: expect.stringContaining('supports macOS, Linux, and WSL2 only'),
    });
  });
});
