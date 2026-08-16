import { chmod, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  linkExtension,
  listExtensions,
  listExtensionAgentBackends,
  parseExtensionManifest,
  resolveCapabilityBaseUrl,
  runExtensionAction,
  stopManagedExtensions,
  unlinkExtension,
} from '../src/extensions.js';

const previousConfig = process.env.XANGI_EXTENSIONS_FILE;

afterEach(async () => {
  await stopManagedExtensions();
  if (previousConfig === undefined) delete process.env.XANGI_EXTENSIONS_FILE;
  else process.env.XANGI_EXTENSIONS_FILE = previousConfig;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xangi-extension-'));
  const configPath = join(root, 'config', 'extensions.json');
  const executable = join(root, 'extension-cli');
  const manifestPath = join(root, 'xangi-extension.json');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import http from 'node:http';
const action = process.argv[2];
if (action === 'update') {
  console.log(JSON.stringify({ schemaVersion: 2, id: 'example-search', unsupported: true }));
  process.exit(0);
}
const workspace = process.argv[process.argv.indexOf('--workspace') + 1];
const token = process.env.XANGI_EXTENSION_AUTH_TOKEN;
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== \`Bearer \${token}\`) {
    response.writeHead(401).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ service: 'example-search' }));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ schemaVersion: 2, event: 'ready', id: 'example-search', baseUrl: \`http://127.0.0.1:\${address.port}\`, workspace }));
});
process.stdin.resume();
process.stdin.on('end', () => server.close());
`
  );
  await chmod(executable, 0o755);
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      id: 'example-search',
      displayName: 'Example Search',
      version: '0.1.0',
      entrypoint: 'extension-cli',
      runtime: { kind: 'managed-http' },
      capabilities: [
        {
          id: 'workspace.search',
          protocol: 'http',
          healthPath: '/health',
        },
      ],
    })
  );
  return { root, configPath, manifestPath };
}

describe('extensions', () => {
  it('rejects unsafe entrypoints', () => {
    expect(() =>
      parseExtensionManifest({
        schemaVersion: 2,
        id: 'unsafe',
        displayName: 'Unsafe',
        version: '1.0.0',
        entrypoint: '../escape',
        runtime: { kind: 'managed-http' },
        capabilities: [],
      })
    ).toThrow(/invalid/);
  });

  it('accepts a repository-local setup document and rejects traversal', () => {
    expect(
      parseExtensionManifest({
        schemaVersion: 2,
        id: 'safe',
        displayName: 'Safe',
        version: '1.0.0',
        entrypoint: 'extension-cli',
        runtime: { kind: 'managed-http' },
        setup: { instructions: 'docs/setup.md' },
        capabilities: [],
      }).setup
    ).toEqual({ instructions: 'docs/setup.md' });
    expect(() =>
      parseExtensionManifest({
        schemaVersion: 2,
        id: 'unsafe',
        displayName: 'Unsafe',
        version: '1.0.0',
        entrypoint: 'extension-cli',
        runtime: { kind: 'managed-http' },
        setup: { instructions: '../setup.md' },
        capabilities: [],
      })
    ).toThrow(/setup instructions/);
  });

  it('accepts a bounded shell-free update preparation and rejects traversal', () => {
    const manifest = {
      schemaVersion: 2,
      id: 'updatable',
      displayName: 'Updatable',
      version: '1.0.0',
      entrypoint: 'extension-cli',
      runtime: { kind: 'managed-http' },
      capabilities: [],
    };
    expect(
      parseExtensionManifest({
        ...manifest,
        update: { prepare: { command: 'uv', args: ['sync', '--frozen'] } },
      }).update
    ).toEqual({ prepare: { command: 'uv', args: ['sync', '--frozen'] } });
    expect(() =>
      parseExtensionManifest({
        ...manifest,
        update: { prepare: { command: '../prepare', args: [] } },
      })
    ).toThrow(/update preparation/);
    expect(() =>
      parseExtensionManifest({
        ...manifest,
        update: { prepare: { command: 'uv sync', args: [] } },
      })
    ).toThrow(/update preparation/);
    expect(() =>
      parseExtensionManifest({
        ...manifest,
        update: { prepare: { command: 'uv', args: Array.from({ length: 33 }, () => 'arg') } },
      })
    ).toThrow(/update preparation/);
  });

  it('accepts bounded catalog metadata and rejects invalid permissions', () => {
    expect(
      parseExtensionManifest({
        schemaVersion: 2,
        id: 'metadata',
        displayName: 'Metadata',
        description: 'An external service.',
        permissions: ['Read selected files'],
        version: '1.0.0',
        entrypoint: 'extension-cli',
        runtime: { kind: 'managed-http' },
        capabilities: [],
      })
    ).toMatchObject({
      description: 'An external service.',
      permissions: ['Read selected files'],
    });
    expect(() =>
      parseExtensionManifest({
        schemaVersion: 2,
        id: 'metadata',
        displayName: 'Metadata',
        permissions: [''],
        version: '1.0.0',
        entrypoint: 'extension-cli',
        runtime: { kind: 'managed-http' },
        capabilities: [],
      })
    ).toThrow(/permissions/);
  });

  it('accepts a UI bound to a declared capability and rejects unknown capabilities', () => {
    const manifest = {
      schemaVersion: 2,
      id: 'search-ui',
      displayName: 'Search UI',
      version: '1.0.0',
      entrypoint: 'extension-cli',
      runtime: { kind: 'managed-http' },
      capabilities: [
        {
          id: 'workspace.search',
          protocol: 'http',
          healthPath: '/health',
        },
      ],
    };
    expect(
      parseExtensionManifest({
        ...manifest,
        ui: { capability: 'workspace.search', path: '/ui' },
      }).ui
    ).toEqual({ capability: 'workspace.search', path: '/ui' });
    expect(() =>
      parseExtensionManifest({
        ...manifest,
        ui: { capability: 'unknown', path: '/ui' },
      })
    ).toThrow(/UI declaration/);
  });

  it('accepts an agent backend bound to a declared capability', () => {
    const manifest = parseExtensionManifest({
      schemaVersion: 2,
      id: 'agent-extension',
      displayName: 'Agent extension',
      version: '1.0.0',
      entrypoint: 'extension-cli',
      runtime: { kind: 'managed-http' },
      capabilities: [
        {
          id: 'agent.run',
          protocol: 'http',
          healthPath: '/health',
        },
      ],
      agentBackend: {
        id: 'example-agent',
        displayName: 'Example agent',
        capability: 'agent.run',
        path: '/agent',
      },
    });
    expect(manifest.agentBackend).toEqual({
      id: 'example-agent',
      displayName: 'Example agent',
      capability: 'agent.run',
      path: '/agent',
    });
  });

  it('links, starts, resolves a runtime capability, and unlinks', async () => {
    const { root, configPath, manifestPath } = await fixture();
    process.env.XANGI_EXTENSIONS_FILE = configPath;
    const linked = await linkExtension(manifestPath, { configPath });
    expect((await listExtensions(configPath))[0]).toEqual(linked);
    expect(listExtensionAgentBackends()).toEqual([]);
    expect(resolveCapabilityBaseUrl('workspace.search')).toBeUndefined();
    await expect(runExtensionAction(linked, 'start', { workspace: root })).resolves.toMatchObject({
      ok: true,
      running: true,
      healthy: true,
    });
    expect(resolveCapabilityBaseUrl('workspace.search')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(runExtensionAction(linked, 'doctor')).resolves.toMatchObject({ ok: true });
    await expect(runExtensionAction(linked, 'stop')).resolves.toMatchObject({ running: false });
    expect((await readFile(configPath, 'utf8')).endsWith('\n')).toBe(true);
    expect(await unlinkExtension(linked.id, configPath)).toBe(true);
  });

  it('isolates ports and workspaces across two parent runtime processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-extension-isolation-'));
    const executable = join(root, 'extension-cli');
    const manifestPath = join(root, 'xangi-extension.json');
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
const workspace = process.argv[process.argv.indexOf('--workspace') + 1];
const token = process.env.XANGI_EXTENSION_AUTH_TOKEN;
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== \`Bearer \${token}\`) {
    response.writeHead(401).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ workspace, marker: readFileSync(join(workspace, 'marker.txt'), 'utf8') }));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ schemaVersion: 2, event: 'ready', id: 'isolated-search', baseUrl: \`http://127.0.0.1:\${address.port}\`, workspace }));
});
process.stdin.resume();
process.stdin.on('end', () => server.close());
`
    );
    await chmod(executable, 0o755);
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        id: 'isolated-search',
        displayName: 'Isolated Search',
        version: '1.0.0',
        entrypoint: 'extension-cli',
        runtime: { kind: 'managed-http' },
        capabilities: [{ id: 'workspace.search', protocol: 'http', healthPath: '/health' }],
      })
    );

    const startHost = async (name: string) => {
      const workspace = join(root, name);
      const configPath = join(root, `${name}.json`);
      await (await import('node:fs/promises')).mkdir(workspace);
      await writeFile(join(workspace, 'marker.txt'), name);
      await writeFile(
        configPath,
        JSON.stringify({
          schemaVersion: 1,
          extensions: [{ id: 'isolated-search', manifestPath, enabled: true, autostart: true }],
        }),
        { mode: 0o600 }
      );
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/helpers/managed-extension-host.ts', configPath, workspace],
        { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] }
      );
      child.stdout.setEncoding('utf8');
      const ready = await new Promise<{
        childBaseUrl: string;
        gatewayBaseUrl: string;
      }>((resolvePromise, reject) => {
        let output = '';
        child.stdout.on('data', (chunk: string) => {
          output += chunk;
          for (const line of output.split('\n')) {
            if (!line.startsWith('{')) continue;
            resolvePromise(JSON.parse(line) as { childBaseUrl: string; gatewayBaseUrl: string });
            return;
          }
        });
        child.once('error', reject);
        child.once('close', (code) => reject(new Error(`host exited before readiness: ${code}`)));
      });
      return { child, ready };
    };

    const [one, two] = await Promise.all([startHost('workspace-one'), startHost('workspace-two')]);
    try {
      expect(one.ready.childBaseUrl).not.toBe(two.ready.childBaseUrl);
      expect(one.ready.gatewayBaseUrl).not.toBe(two.ready.gatewayBaseUrl);
      await expect(
        fetch(`${one.ready.gatewayBaseUrl}/search`).then((r) => r.json())
      ).resolves.toEqual(expect.objectContaining({ marker: 'workspace-one' }));
      await expect(
        fetch(`${two.ready.gatewayBaseUrl}/search`).then((r) => r.json())
      ).resolves.toEqual(expect.objectContaining({ marker: 'workspace-two' }));
    } finally {
      one.child.stdin.end();
      two.child.stdin.end();
      await Promise.all([
        new Promise((resolvePromise) => one.child.once('close', resolvePromise)),
        new Promise((resolvePromise) => two.child.once('close', resolvePromise)),
      ]);
    }
  });
});
