import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])])
  );
}

async function fixture(platform: 'darwin' | 'linux' = 'darwin') {
  const root = await mkdtemp(join(tmpdir(), 'xangi-bootstrap-'));
  roots.push(root);
  const archiveRoot = `xangi-1.2.3-${platform}-arm64`;
  const payload = join(root, archiveRoot);
  await mkdir(join(payload, 'runtime', 'bin'), { recursive: true });
  await mkdir(join(payload, 'dist', 'cli'), { recursive: true });
  await writeFile(
    join(payload, 'runtime', 'bin', 'node'),
    '#!/bin/sh\n[ -z "${XANGI_FIXTURE_NODE_LOG:-}" ] || printf "%s\\n" "$*" >> "$XANGI_FIXTURE_NODE_LOG"\n[ "${XANGI_FIXTURE_FAIL_INSTALL:-0}" = 1 ] && [ "${2:-}" = install ] && exit 9\n[ "${XANGI_FIXTURE_SETUP_EXIT:-0}" != 0 ] && [ "${2:-}" = setup ] && exit "$XANGI_FIXTURE_SETUP_EXIT"\nexit 0\n'
  );
  await chmod(join(payload, 'runtime', 'bin', 'node'), 0o755);
  await writeFile(join(payload, 'dist', 'cli', 'xangi.js'), '// fixture\n');
  const artifact = join(root, 'bundle.tar.gz');
  await exec('tar', ['-czf', artifact, '-C', root, archiveRoot]);
  const artifactBytes = await readFile(artifact);

  const keys = generateKeyPairSync('ed25519');
  const unsigned = {
    schemaVersion: 1,
    version: '1.2.3',
    platform,
    arch: 'arm64',
    asset: {
      url: `https://releases.example/xangi-1.2.3-${platform}-arm64.tar.gz`,
      size: artifactBytes.byteLength,
      sha256: createHash('sha256').update(artifactBytes).digest('hex'),
    },
  };
  const manifest = join(root, 'manifest.json');
  await writeFile(
    manifest,
    JSON.stringify({
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(JSON.stringify(canonical(unsigned))),
        keys.privateKey
      ).toString('base64'),
    })
  );
  const publicKey = join(root, 'release-public.pem');
  await writeFile(publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  return {
    root,
    artifact,
    manifest,
    publicKey,
    platform,
  };
}

async function buildInstaller(data: Awaited<ReturnType<typeof fixture>>) {
  const output = join(data.root, 'install-1.2.3.sh');
  await exec('node', [
    'packaging/build-installer.mjs',
    '--manifest',
    data.manifest,
    '--artifact',
    data.artifact,
    '--public-key',
    data.publicKey,
    '--manifest-url',
    'https://releases.example/manifest.json',
    '--installer-url',
    'https://releases.example/install-1.2.3.sh',
    '--output',
    output,
  ]);
  return output;
}

async function fakeHostCommands(root: string, platform: 'darwin' | 'linux') {
  const bin = join(root, 'fake-bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'uname'),
    `#!/bin/sh\n[ "\${1:-}" = -s ] && echo ${platform === 'darwin' ? 'Darwin' : 'Linux'} || echo "\${FIXTURE_MACHINE:-arm64}"\n`
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
case "$url" in
  */manifest.json) cp "$FIXTURE_MANIFEST" "$output" ;;
  */xangi-1.2.3-*-arm64.tar.gz) cp "$FIXTURE_ARTIFACT" "$output" ;;
  *) exit 22 ;;
esac
`
  );
  await writeFile(join(bin, 'git'), '#!/bin/sh\nexit 99\n');
  await chmod(join(bin, 'uname'), 0o755);
  await chmod(join(bin, 'curl'), 0o755);
  await chmod(join(bin, 'git'), 0o755);
  return bin;
}

async function runInstaller(
  installer: string,
  data: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, string> = {},
  includeCommandDir = false
) {
  const fakeBin = await fakeHostCommands(data.root, data.platform);
  const home = join(data.root, 'home');
  await mkdir(home, { recursive: true });
  const commandPath = includeCommandDir ? `${join(home, '.local', 'bin')}:` : '';
  return exec('bash', [installer], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${commandPath}${process.env.PATH}`,
      HOME: home,
      FIXTURE_MANIFEST: data.manifest,
      FIXTURE_ARTIFACT: data.artifact,
      XANGI_INSTALL_SKIP_SETUP: '1',
      XANGI_INSTALL_SKIP_ACTIVATE: '1',
      ...overrides,
    },
  });
}

describe('authenticated macOS bootstrap installer', () => {
  it('signed manifestとartifactをbuild時に検証し、hash-pinned one-commandを生成する', async () => {
    const data = await fixture();
    const installer = await buildInstaller(data);
    const command = await readFile(`${installer}.command`, 'utf8');

    expect(command).toContain('shasum -a 256');
    expect(command).toContain('sha256sum');
    expect(command).not.toContain('curl | bash');
    expect(command).toMatch(/[a-f0-9]{64}/);
    const script = await readFile(installer, 'utf8');
    expect(script).toContain('tar -tvzf');
    expect(script).toContain('only regular files and directories');
    expect(script).toContain('"$launcher" install');
  });

  it('検証済みbundleだけを展開してversion/current/launcherを作る', async () => {
    const data = await fixture();
    const installer = await buildInstaller(data);
    const result = await runInstaller(installer, data);

    const app = join(data.root, 'home', 'Library', 'Application Support', 'xangi', 'app');
    await expect(
      readFile(join(app, 'versions', '1.2.3', 'dist', 'cli', 'xangi.js'), 'utf8')
    ).resolves.toContain('fixture');
    await expect(readFile(join(app, 'bin', 'xangi'), 'utf8')).resolves.toContain(
      'runtime/bin/node'
    );
    await expect(readFile(join(app, 'bin', 'xangi'), 'utf8')).resolves.toContain(
      'XANGI_INSTALLATION_KIND=managed'
    );
    await expect(
      readlink(join(data.root, 'home', '.local', 'bin', 'xangi'))
    ).resolves.toBe(join(app, 'bin', 'xangi'));
    await expect(readFile(join(app, 'trust', 'release-public-key.pem'), 'utf8')).resolves.toContain(
      'BEGIN PUBLIC KEY'
    );
    await expect(
      readFile(
        join(
          data.root,
          'home',
          'Library',
          'Application Support',
          'xangi',
          'config',
          'release.json'
        ),
        'utf8'
      )
    ).resolves.toBe('{"manifestUrl":"https://releases.example/manifest.json"}\n');
    expect(result.stdout).toContain('Setup and service activation complete');
    expect(result.stdout).toContain('Command: ');
    expect(result.stdout).toContain('Add xangi to this shell: export PATH=');
    expect(result.stdout).toContain('Verify: "');
    expect(result.stdout).toContain(' doctor');
    expect(result.stdout).toContain('Token settings: "');
    expect(result.stdout).toContain(' settings');
  });

  it('refuses to overwrite an unrelated command at ~/.local/bin/xangi', async () => {
    const data = await fixture();
    const installer = await buildInstaller(data);
    const commandDir = join(data.root, 'home', '.local', 'bin');
    await mkdir(commandDir, { recursive: true });
    await writeFile(join(commandDir, 'xangi'), 'unrelated command');

    await expect(runInstaller(installer, data)).rejects.toMatchObject({ code: 1 });
    await expect(readFile(join(commandDir, 'xangi'), 'utf8')).resolves.toBe('unrelated command');
  });

  it('prints bare xangi commands when ~/.local/bin is already on PATH', async () => {
    const data = await fixture();
    const installer = await buildInstaller(data);
    const result = await runInstaller(installer, data, {}, true);

    expect(result.stdout).toContain('Verify: xangi doctor');
    expect(result.stdout).toContain('Token settings: xangi settings');
    expect(result.stdout).not.toContain('Add xangi to this shell:');
  });

  it('installs a Linux bundle into XDG paths without Git or Node', async () => {
    const data = await fixture('linux');
    const installer = await buildInstaller(data);
    await runInstaller(installer, data, {
      FIXTURE_MACHINE: 'aarch64',
      XDG_DATA_HOME: join(data.root, 'home', '.local', 'share'),
      XDG_CONFIG_HOME: join(data.root, 'home', '.config'),
      XDG_STATE_HOME: join(data.root, 'home', '.local', 'state'),
    });

    const app = join(data.root, 'home', '.local', 'share', 'xangi', 'app');
    await expect(
      readFile(join(app, 'versions', '1.2.3', 'dist', 'cli', 'xangi.js'), 'utf8')
    ).resolves.toContain('fixture');
    await expect(readFile(join(app, 'bin', 'xangi'), 'utf8')).resolves.toContain('XDG_DATA_HOME');
    await expect(
      readFile(join(data.root, 'home', '.config', 'xangi', 'release.json'), 'utf8')
    ).resolves.toContain('manifestUrl');
  });

  it('Gitやhost Nodeを使わず、配布bundleのlauncherからsetupを開始する', async () => {
    const data = await fixture();
    const installer = await buildInstaller(data);
    const nodeLog = join(data.root, 'bundled-node.log');
    await runInstaller(installer, data, {
      XANGI_INSTALL_SKIP_SETUP: '0',
      XANGI_INSTALL_SKIP_ACTIVATE: '1',
      XANGI_FIXTURE_NODE_LOG: nodeLog,
    });

    await expect(readFile(nodeLog, 'utf8')).resolves.toMatch(/dist\/cli\/xangi\.js setup/);
  });

  it('AI CLI準備待ちではinstall済みversionを保持してservice起動を保留する', async () => {
    const data = await fixture();
    const installer = await buildInstaller(data);
    const nodeLog = join(data.root, 'bundled-node.log');
    const result = await runInstaller(installer, data, {
      XANGI_INSTALL_SKIP_SETUP: '0',
      XANGI_INSTALL_SKIP_ACTIVATE: '0',
      XANGI_FIXTURE_SETUP_EXIT: '3',
      XANGI_FIXTURE_NODE_LOG: nodeLog,
    });

    const app = join(data.root, 'home', 'Library', 'Application Support', 'xangi', 'app');
    await expect(readlink(join(app, 'current'))).resolves.toBe(join(app, 'versions', '1.2.3'));
    await expect(readFile(nodeLog, 'utf8')).resolves.toMatch(/dist\/cli\/xangi\.js setup/);
    await expect(readFile(nodeLog, 'utf8')).resolves.not.toMatch(/dist\/cli\/xangi\.js install/);
    expect(result.stdout).toContain('AI setup and service activation are pending');
    expect(result.stdout).toContain('setup');
  });

  it('改ざんmanifestを展開前に拒否する', async () => {
    const data = await fixture();
    const installer = await buildInstaller(data);
    await writeFile(data.manifest, '{}');

    await expect(runInstaller(installer, data)).rejects.toMatchObject({ code: 1 });
    const installed = join(data.root, 'home', 'Library', 'Application Support', 'xangi', 'app');
    await expect(readFile(join(installed, 'current'))).rejects.toThrow();
  });

  it('改ざんbundleを展開前に拒否する', async () => {
    const data = await fixture();
    const installer = await buildInstaller(data);
    await writeFile(data.artifact, 'tampered');

    await expect(runInstaller(installer, data)).rejects.toMatchObject({ code: 1 });
    const installed = join(data.root, 'home', 'Library', 'Application Support', 'xangi', 'app');
    await expect(readFile(join(installed, 'current'))).rejects.toThrow();
  });

  it('signature不正manifestからinstallerを生成しない', async () => {
    const data = await fixture();
    const parsed = JSON.parse(await readFile(data.manifest, 'utf8'));
    parsed.version = '1.2.4';
    await writeFile(data.manifest, JSON.stringify(parsed));

    await expect(buildInstaller(data)).rejects.toThrow(/signature verification failed/);
  });

  it('service activation failure restores the previously working version', async () => {
    const data = await fixture();
    const installer = await buildInstaller(data);
    const app = join(data.root, 'home', 'Library', 'Application Support', 'xangi', 'app');
    const previous = join(app, 'versions', '1.2.2');
    await mkdir(previous, { recursive: true });
    await writeFile(join(previous, 'marker'), 'working');
    await symlink(previous, join(app, 'current'));

    await expect(
      runInstaller(installer, data, {
        XANGI_INSTALL_SKIP_ACTIVATE: '0',
        XANGI_FIXTURE_FAIL_INSTALL: '1',
      })
    ).rejects.toBeDefined();

    await expect(readlink(join(app, 'current'))).resolves.toBe(previous);
    await expect(readFile(join(app, 'current', 'marker'), 'utf8')).resolves.toBe('working');
    await expect(
      readFile(join(app, 'versions', '1.2.3', 'dist', 'cli', 'xangi.js'))
    ).rejects.toThrow();
    await expect(readlink(join(data.root, 'home', '.local', 'bin', 'xangi'))).rejects.toThrow();
  });
});
