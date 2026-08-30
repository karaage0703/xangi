import { chmod, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultExtensionsFile,
  linkExtension,
  listExtensions,
  listExtensionAgentBackends,
  managedExtensionHostContext,
  migrateLegacyExtensionStore,
  parseExtensionManifest,
  resolveCapabilityBaseUrl,
  runExtensionAction,
  startAutostartExtensions,
  stopManagedExtensions,
  unlinkExtension,
} from '../src/extensions.js';
import { _resetEventsConfigForTest } from '../src/events-emitter.js';

const previousConfig = process.env.XANGI_EXTENSIONS_FILE;
const previousDataDir = process.env.DATA_DIR;
const previousWorkspace = process.env.WORKSPACE_PATH;
const previousWebEnabled = process.env.WEB_CHAT_ENABLED;
const previousWebHost = process.env.WEB_CHAT_HOST;
const previousWebPort = process.env.WEB_CHAT_PORT;
const previousEventsEnabled = process.env.XANGI_EVENTS_ENABLED;
const previousInstanceId = process.env.XANGI_INSTANCE_ID;

afterEach(async () => {
  await stopManagedExtensions();
  vi.restoreAllMocks();
  if (previousConfig === undefined) delete process.env.XANGI_EXTENSIONS_FILE;
  else process.env.XANGI_EXTENSIONS_FILE = previousConfig;
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousWorkspace === undefined) delete process.env.WORKSPACE_PATH;
  else process.env.WORKSPACE_PATH = previousWorkspace;
  for (const [key, value] of [
    ['WEB_CHAT_ENABLED', previousWebEnabled],
    ['WEB_CHAT_HOST', previousWebHost],
    ['WEB_CHAT_PORT', previousWebPort],
    ['XANGI_EVENTS_ENABLED', previousEventsEnabled],
    ['XANGI_INSTANCE_ID', previousInstanceId],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetEventsConfigForTest();
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

async function lifecycleFixture(
  initialHealth: 'timeout' | 'non-2xx' | 'not-ready' | 'id-mismatch' | 'exit-after-ready'
) {
  const root = await mkdtemp(join(tmpdir(), 'xangi-extension-lifecycle-'));
  const configPath = join(root, 'config', 'extensions.json');
  const executable = join(root, 'extension-cli');
  const manifestPath = join(root, 'xangi-extension.json');
  const readyMarker = join(root, 'ready');
  const pidPath = join(root, 'pid');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
const workspace = process.argv[process.argv.indexOf('--workspace') + 1];
const token = process.env.XANGI_EXTENSION_AUTH_TOKEN;
const initialHealth = ${JSON.stringify(initialHealth)};
const readyMarker = ${JSON.stringify(readyMarker)};
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
let healthRequests = 0;
const send = (response, status, payload) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
};
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== \`Bearer \${token}\`) {
    response.writeHead(401).end();
    return;
  }
  healthRequests += 1;
  if (initialHealth === 'timeout' && healthRequests === 1) {
    setTimeout(() => send(response, 200, { ready: true }), 2200);
    return;
  }
  if (initialHealth === 'non-2xx' && healthRequests === 1) {
    send(response, 503, { ready: false, detail: 'warming' });
    return;
  }
  if (initialHealth === 'not-ready' && !existsSync(readyMarker)) {
    send(response, 200, { ready: false, detail: 'warming' });
    return;
  }
  send(response, 200, { ready: true });
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ schemaVersion: 2, event: 'ready', id: initialHealth === 'id-mismatch' ? 'wrong-id' : 'lifecycle-test', baseUrl: \`http://127.0.0.1:\${address.port}\`, workspace }));
  if (initialHealth === 'exit-after-ready') server.close(() => process.exit(1));
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
      id: 'lifecycle-test',
      displayName: 'Lifecycle Test',
      version: '0.1.0',
      entrypoint: 'extension-cli',
      runtime: { kind: 'managed-http' },
      capabilities: [{ id: 'workspace.search', protocol: 'http', healthPath: '/health' }],
    })
  );
  process.env.XANGI_EXTENSIONS_FILE = configPath;
  const linked = await linkExtension(manifestPath, { configPath });
  return { root, linked, readyMarker, pidPath };
}

describe('extensions', () => {
  it('provides managed children with explicit parent host context', () => {
    process.env.WEB_CHAT_ENABLED = 'true';
    process.env.WEB_CHAT_HOST = '0.0.0.0';
    process.env.WEB_CHAT_PORT = '19991';
    process.env.XANGI_EVENTS_ENABLED = 'true';
    process.env.XANGI_INSTANCE_ID = 'xangi-test';
    _resetEventsConfigForTest();

    expect(managedExtensionHostContext()).toEqual({
      XANGI_EXTENSION_HOST_URL: 'http://127.0.0.1:19991',
      XANGI_EXTENSION_EVENTS_URL: 'http://127.0.0.1:19991/api/events/stream',
      XANGI_EXTENSION_INSTANCE_ID: 'xangi-test',
    });
  });

  it('uses the same strict port and quoted host resolution as the web server', () => {
    process.env.WEB_CHAT_ENABLED = 'true';
    process.env.WEB_CHAT_HOST = "'::1'";
    process.env.WEB_CHAT_PORT = '19991abc';
    process.env.XANGI_EVENTS_ENABLED = 'true';
    process.env.XANGI_INSTANCE_ID = 'xangi-test';
    _resetEventsConfigForTest();

    expect(managedExtensionHostContext()).toEqual({
      XANGI_EXTENSION_HOST_URL: 'http://[::1]:18888',
      XANGI_EXTENSION_EVENTS_URL: 'http://[::1]:18888/api/events/stream',
      XANGI_EXTENSION_INSTANCE_ID: 'xangi-test',
    });
  });

  it('omits unavailable parent HTTP endpoints while retaining the instance identity', () => {
    process.env.WEB_CHAT_ENABLED = 'false';
    process.env.XANGI_INSTANCE_ID = 'xangi-headless';
    _resetEventsConfigForTest();

    expect(managedExtensionHostContext()).toEqual({
      XANGI_EXTENSION_INSTANCE_ID: 'xangi-headless',
    });
  });

  it('isolates the default registry by DATA_DIR under the same OS user', async () => {
    const { root, manifestPath } = await fixture();
    delete process.env.XANGI_EXTENSIONS_FILE;
    delete process.env.WORKSPACE_PATH;
    const instanceA = join(root, 'instance-a');
    const instanceB = join(root, 'instance-b');

    process.env.DATA_DIR = instanceA;
    expect(defaultExtensionsFile()).toBe(join(instanceA, 'extensions.json'));
    await linkExtension(manifestPath);

    process.env.DATA_DIR = instanceB;
    expect(defaultExtensionsFile()).toBe(join(instanceB, 'extensions.json'));
    expect(await listExtensions()).toEqual([]);

    process.env.DATA_DIR = instanceA;
    expect(await listExtensions()).toHaveLength(1);
  });

  it('migrates only legacy entries owned by the current DATA_DIR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-extension-migration-'));
    const dataDir = join(root, 'instance');
    const ownedManifest = join(
      dataDir,
      'extensions',
      'sources',
      'owner--repo',
      'xangi-extension.json'
    );
    const foreignManifest = join(
      root,
      'other-instance',
      'extensions',
      'sources',
      'owner--repo',
      'xangi-extension.json'
    );
    const legacyPath = join(root, 'config', 'xangi', 'extensions.json');
    await (
      await import('node:fs/promises')
    ).mkdir(join(root, 'config', 'xangi'), {
      recursive: true,
    });
    await writeFile(
      legacyPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          extensions: [
            { id: 'owned', manifestPath: ownedManifest, enabled: true, autostart: true },
            { id: 'foreign', manifestPath: foreignManifest, enabled: true, autostart: true },
          ],
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    delete process.env.XANGI_EXTENSIONS_FILE;
    delete process.env.WORKSPACE_PATH;
    process.env.DATA_DIR = dataDir;

    await expect(migrateLegacyExtensionStore({ legacyPath })).resolves.toBe(1);
    await expect(listExtensions()).resolves.toEqual([
      { id: 'owned', manifestPath: ownedManifest, enabled: true, autostart: true },
    ]);
    await expect(migrateLegacyExtensionStore({ legacyPath })).resolves.toBe(0);
  });

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
      ready: true,
    });
    expect(resolveCapabilityBaseUrl('workspace.search')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(runExtensionAction(linked, 'doctor')).resolves.toMatchObject({ ok: true });
    await expect(runExtensionAction(linked, 'stop')).resolves.toMatchObject({ running: false });
    expect((await readFile(configPath, 'utf8')).endsWith('\n')).toBe(true);
    expect(await unlinkExtension(linked.id, configPath)).toBe(true);
  });

  it('keeps a child registered when the initial health probe exceeds two seconds', async () => {
    const { root, linked } = await lifecycleFixture('timeout');
    await expect(runExtensionAction(linked, 'start', { workspace: root })).resolves.toMatchObject({
      ok: false,
      running: true,
      healthy: false,
      ready: false,
      changed: true,
    });
    expect(resolveCapabilityBaseUrl('workspace.search')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(runExtensionAction(linked, 'status')).resolves.toMatchObject({
      running: true,
      healthy: true,
      ready: true,
    });
  });

  it('keeps a child registered after an initial non-2xx health response', async () => {
    const { root, linked } = await lifecycleFixture('non-2xx');
    await expect(runExtensionAction(linked, 'start', { workspace: root })).resolves.toMatchObject({
      running: true,
      healthy: false,
      ready: false,
    });
    await expect(runExtensionAction(linked, 'status')).resolves.toMatchObject({
      running: true,
      healthy: true,
      ready: true,
    });
  });

  it('reports explicit readiness separately and observes recovery without a restart', async () => {
    const { root, linked, readyMarker } = await lifecycleFixture('not-ready');
    await expect(runExtensionAction(linked, 'start', { workspace: root })).resolves.toMatchObject({
      ok: true,
      running: true,
      healthy: true,
      ready: false,
      detail: 'warming',
    });
    await expect(runExtensionAction(linked, 'doctor', { workspace: root })).resolves.toMatchObject({
      ok: false,
      running: true,
      healthy: true,
      ready: false,
    });

    await writeFile(readyMarker, 'ready');

    await expect(runExtensionAction(linked, 'doctor', { workspace: root })).resolves.toMatchObject({
      ok: true,
      running: true,
      healthy: true,
      ready: true,
    });
  });

  it('logs an autostarted warming process separately from a ready extension', async () => {
    const { root } = await lifecycleFixture('not-ready');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await startAutostartExtensions({ workspace: root });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('lifecycle-test started but is not ready: warming')
    );
  });

  it('fully tears down a child that fails readiness identity validation', async () => {
    const { root, linked, pidPath } = await lifecycleFixture('id-mismatch');

    await expect(runExtensionAction(linked, 'start', { workspace: root })).rejects.toThrow(
      'readiness id mismatch'
    );

    const pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(resolveCapabilityBaseUrl('workspace.search')).toBeUndefined();
  });

  it('rejects a child that exits immediately after a valid readiness message', async () => {
    const { root, linked, pidPath } = await lifecycleFixture('exit-after-ready');

    await expect(runExtensionAction(linked, 'start', { workspace: root })).rejects.toThrow(
      'lifecycle-test exited during startup'
    );

    const pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(resolveCapabilityBaseUrl('workspace.search')).toBeUndefined();
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
