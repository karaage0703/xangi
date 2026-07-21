import { createHash } from 'node:crypto';
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

async function createFixture(): Promise<{ project: string; output: string; nodeBinary: string }> {
  const root = await mkdtemp(join(tmpdir(), 'xangi-package-'));
  roots.push(root);
  const project = join(root, 'project');
  const output = join(root, 'output');
  const nodeBinary = join(root, 'node-fixture');

  await mkdir(join(project, 'dist'), { recursive: true });
  await mkdir(join(project, 'src'), { recursive: true });
  await mkdir(join(project, 'docs', 'en'), { recursive: true });
  await mkdir(join(project, 'web'), { recursive: true });
  await mkdir(join(project, 'web', 'node_modules'), { recursive: true });
  await mkdir(join(project, 'node_modules', 'prod-pkg'), { recursive: true });
  await mkdir(join(project, 'node_modules', 'prod-pkg', 'node_modules', 'transitive-prod'), {
    recursive: true,
  });
  await mkdir(join(project, 'node_modules', 'prod-pkg', 'node_modules', 'transitive-dev'), {
    recursive: true,
  });
  await mkdir(join(project, 'node_modules', 'prod-pkg', 'node_modules', 'ghost-package'), {
    recursive: true,
  });
  await mkdir(join(project, 'node_modules', 'dev-pkg'), { recursive: true });
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(join(project, 'logs'), { recursive: true });
  await mkdir(join(project, 'memory'), { recursive: true });

  await writeFile(join(project, 'dist', 'index.js'), 'console.log("xangi")\n');
  await writeFile(join(project, 'dist', '.env'), 'TOKEN=do-not-package\n');
  await writeFile(join(project, 'dist', 'server.pem'), 'private material\n');
  await writeFile(
    join(project, 'src', 'approval-patterns.json'),
    JSON.stringify([{ command: 'rm ', description: 'delete', category: 'filesystem' }])
  );
  await writeFile(join(project, 'README.md'), '# xangi\n');
  await writeFile(join(project, 'README.en.md'), '# xangi\n');
  await writeFile(join(project, 'docs', 'usage.md'), '# 使い方\n');
  await writeFile(join(project, 'docs', 'discord-setup.md'), '# Discord\n');
  await writeFile(join(project, 'docs', 'en', 'usage.md'), '# Usage\n');
  await writeFile(join(project, 'web', 'index.html'), '<main>Web Chat</main>\n');
  await writeFile(join(project, 'web', 'monitor.html'), '<main>Monitor</main>\n');
  await writeFile(join(project, 'web', 'inter-chat.html'), '<main>Inter Chat</main>\n');
  await writeFile(join(project, 'web', '.env'), 'WEB_SECRET=no\n');
  await writeFile(join(project, 'web', 'node_modules', 'ignored.js'), 'not shipped\n');
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'xangi-fixture',
      version: '0.0.0',
      dependencies: { 'prod-pkg': '1.0.0' },
      devDependencies: { 'dev-pkg': '1.0.0' },
    })
  );
  await writeFile(
    join(project, 'package-lock.json'),
    JSON.stringify({
      name: 'xangi-fixture',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { 'prod-pkg': '1.0.0' }, devDependencies: { 'dev-pkg': '1.0.0' } },
        'node_modules/prod-pkg': { version: '1.0.0' },
        'node_modules/prod-pkg/node_modules/transitive-prod': { version: '1.0.0' },
        'node_modules/prod-pkg/node_modules/transitive-dev': { version: '1.0.0', dev: true },
        'node_modules/dev-pkg': { version: '1.0.0', dev: true },
      },
    })
  );
  await writeFile(join(project, 'node_modules', 'prod-pkg', 'index.js'), 'prod\n');
  await writeFile(
    join(project, 'node_modules', 'prod-pkg', 'node_modules', 'transitive-prod', 'index.js'),
    'transitive prod\n'
  );
  await writeFile(
    join(project, 'node_modules', 'prod-pkg', 'node_modules', 'transitive-dev', 'index.js'),
    'transitive dev\n'
  );
  await writeFile(
    join(project, 'node_modules', 'prod-pkg', 'node_modules', 'ghost-package', 'index.js'),
    'extraneous\n'
  );
  await writeFile(join(project, 'node_modules', 'prod-pkg', '.env'), 'SECRET=no\n');
  await writeFile(join(project, 'node_modules', 'dev-pkg', 'index.js'), 'dev\n');
  await writeFile(join(project, '.env'), 'ROOT_SECRET=no\n');
  await writeFile(join(project, '.git', 'config'), 'private remote\n');
  await writeFile(join(project, 'logs', 'xangi.log'), 'private logs\n');
  await writeFile(join(project, 'memory', 'today.md'), 'private memory\n');
  await writeFile(
    nodeBinary,
    `#!/bin/sh
if [ "\${1:-}" = -p ] && [ "\${2:-}" = process.platform ]; then echo darwin; exit 0; fi
if [ "\${1:-}" = -p ] && [ "\${2:-}" = process.arch ]; then echo arm64; exit 0; fi
echo fixture-node
`
  );
  await chmod(nodeBinary, 0o755);
  return { project, output, nodeBinary };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

describe('packaging/build-bundle.sh', () => {
  it.each(['01.2.3', '1.2.3-01'])('manifestと同じstrict SemVerで%sを拒否する', async (version) => {
    const { project, output, nodeBinary } = await createFixture();
    await expect(
      exec('bash', [
        'packaging/build-bundle.sh',
        '--project-root',
        project,
        '--output-dir',
        output,
        '--version',
        version,
        '--platform',
        'darwin',
        '--arch',
        'arm64',
        '--node-binary',
        nodeBinary,
      ])
    ).rejects.toMatchObject({ code: 2 });
  });

  it('allowlistだけをversioned bundleへ入れproduction依存とNode runtimeを同梱する', async () => {
    const { project, output, nodeBinary } = await createFixture();
    await exec('bash', [
      'packaging/build-bundle.sh',
      '--project-root',
      project,
      '--output-dir',
      output,
      '--version',
      '1.2.3',
      '--platform',
      'darwin',
      '--arch',
      'arm64',
      '--node-binary',
      nodeBinary,
    ]);

    const archive = join(output, 'xangi-1.2.3-darwin-arm64.tar.gz');
    const { stdout } = await exec('tar', ['-tzf', archive]);
    const entries = stdout.trim().split('\n');
    const root = 'xangi-1.2.3-darwin-arm64';

    expect(entries).toContain(`${root}/dist/index.js`);
    expect(entries).toContain(`${root}/dist/approval-patterns.json`);
    expect(entries).toContain(`${root}/web/index.html`);
    expect(entries).toContain(`${root}/web/monitor.html`);
    expect(entries).toContain(`${root}/web/inter-chat.html`);
    expect(entries.some((entry) => entry.startsWith(`${root}/web/node_modules/`))).toBe(false);
    expect(entries).not.toContain(`${root}/web/.env`);
    expect(entries).toContain(`${root}/README.md`);
    expect(entries).toContain(`${root}/README.en.md`);
    expect(entries).toContain(`${root}/docs/usage.md`);
    expect(entries).toContain(`${root}/docs/discord-setup.md`);
    expect(entries).toContain(`${root}/docs/en/usage.md`);
    expect(entries).toContain(`${root}/package.json`);
    expect(entries).toContain(`${root}/package-lock.json`);
    expect(entries).toContain(`${root}/node_modules/prod-pkg/index.js`);
    expect(entries).toContain(
      `${root}/node_modules/prod-pkg/node_modules/transitive-prod/index.js`
    );
    expect(entries).toContain(`${root}/runtime/bin/node`);
    expect(entries.some((entry) => entry.includes('dev-pkg'))).toBe(false);
    expect(entries.some((entry) => entry.includes('transitive-dev'))).toBe(false);
    expect(entries.some((entry) => entry.includes('ghost-package'))).toBe(false);
    expect(
      entries.some((entry) => /(?:^|\/)(?:\.env(?:\.|$)|\.git|logs|memory)(?:\/|$)/.test(entry))
    ).toBe(false);
    expect(entries.some((entry) => /(?:\.pem|\.key|credentials\.json)$/.test(entry))).toBe(false);

    const unpacked = join(output, 'unpacked');
    await mkdir(unpacked);
    await exec('tar', ['-xzf', archive, '-C', unpacked]);
    await expect(
      readFile(join(unpacked, root, 'runtime', 'bin', 'node'), 'utf8')
    ).resolves.toContain('fixture-node');
  });

  it('release targetと一致しないNode runtimeを拒否する', async () => {
    const { project, output, nodeBinary } = await createFixture();
    await expect(
      exec('bash', [
        'packaging/build-bundle.sh',
        '--project-root',
        project,
        '--output-dir',
        output,
        '--version',
        '1.2.3',
        '--platform',
        'linux',
        '--arch',
        'x64',
        '--node-binary',
        nodeBinary,
      ])
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/does not match/) });
  });

  it('引数と環境変数のbuildが同一byte列になりforbidden入力の変更に影響されない', async () => {
    const { project, output, nodeBinary } = await createFixture();
    const args = [
      'packaging/build-bundle.sh',
      '--project-root',
      project,
      '--output-dir',
      output,
      '--version',
      '1.2.3',
      '--platform',
      'darwin',
      '--arch',
      'arm64',
      '--node-binary',
      nodeBinary,
    ];
    await exec('bash', args);
    const first = join(output, 'xangi-1.2.3-darwin-arm64.tar.gz');
    const firstHash = await sha256(first);

    await writeFile(join(project, 'logs', 'xangi.log'), `changed-${Date.now()}\n`);
    const second = join(output, 'from-env.tar.gz');
    await exec('bash', ['packaging/build-bundle.sh'], {
      env: {
        ...process.env,
        XANGI_BUNDLE_PROJECT_ROOT: project,
        XANGI_BUNDLE_OUTPUT: second,
        XANGI_BUNDLE_VERSION: '1.2.3',
        XANGI_BUNDLE_PLATFORM: 'darwin',
        XANGI_BUNDLE_ARCH: 'arm64',
        XANGI_BUNDLE_NODE_BINARY: nodeBinary,
      },
    });

    expect(await sha256(second)).toBe(firstHash);
  });
});
