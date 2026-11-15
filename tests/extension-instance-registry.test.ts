import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { startToolServer, stopToolServer } from '../src/tool-server.js';
import { stopManagedExtensions } from '../src/extensions.js';
import { executeExtensionRegistryCommand } from '../src/extension-registry-command.js';

const checkout = dirname(dirname(fileURLToPath(import.meta.url)));

describe('instance-owned extension registry across agent workspaces', () => {
  const originalEnv = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'xangi-instance-registry-'));
  const hostWorkspace = join(root, 'host-workspace');
  const hostRegistry = join(root, 'host-data', 'extensions.json');
  const agentA = join(root, 'agent-a');
  const agentB = join(root, 'agent-b');
  const manifestPath = join(agentA, 'xangi-extension.json');
  let serverUrl: string;

  beforeAll(async () => {
    for (const dir of [hostWorkspace, agentA, agentB]) mkdirSync(dir, { recursive: true });
    const executable = join(agentA, 'serve.mjs');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
import http from 'node:http';
const workspace = process.argv[process.argv.indexOf('--workspace') + 1];
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + process.env.XANGI_EXTENSION_AUTH_TOKEN) {
    res.writeHead(401).end(); return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, workspace }));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({
  schemaVersion: 2, event: 'ready', id: 'registry-demo', workspace,
  baseUrl: 'http://127.0.0.1:' + server.address().port
})));
process.stdin.resume();
process.stdin.on('end', () => server.close());
`
    );
    chmodSync(executable, 0o755);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        id: 'registry-demo',
        displayName: 'Registry Demo',
        version: '1.0.0',
        entrypoint: 'serve.mjs',
        runtime: { kind: 'managed-http' },
        capabilities: [{ id: 'demo.read', protocol: 'http', healthPath: '/health' }],
      })
    );
    process.env.XANGI_EXTENSIONS_FILE = hostRegistry;
    process.env.DATA_DIR = join(root, 'host-data');
    process.env.WORKSPACE_PATH = hostWorkspace;
    delete process.env.XANGI_TOOL_SERVER;
    startToolServer({ config: { agent: { config: { workdir: hostWorkspace } } } as Config });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        if (process.env.XANGI_TOOL_SERVER) {
          serverUrl = process.env.XANGI_TOOL_SERVER;
          resolve();
        } else if (Date.now() >= deadline) reject(new Error('test tool server did not start'));
        else setTimeout(check, 10);
      };
      check();
    });
  });

  afterAll(async () => {
    await stopManagedExtensions();
    stopToolServer();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    rmSync(root, { recursive: true, force: true });
  });

  function cli(workspace: string, args: string[], toolServer = serverUrl) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            join(checkout, 'src/cli/xangi-main.ts'),
            ...args,
          ],
          {
            cwd: workspace,
            env: {
              ...process.env,
              XANGI_SKIP_ENV_FILE: 'true',
              XANGI_TOOL_SERVER: toolServer,
              WORKSPACE_PATH: workspace,
              DATA_DIR: join(workspace, '.xangi'),
              XANGI_EXTENSIONS_FILE: join(workspace, '.xangi', 'extensions.json'),
            },
          }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      }
    );
  }

  it('links from A, lists/starts/calls from B and unlinks from A using only the host registry', async () => {
    const linked = await cli(agentA, [
      'extension',
      'link',
      './xangi-extension.json',
      '--autostart',
      'false',
    ]);
    expect(linked, linked.stderr).toMatchObject({
      code: 0,
      stdout: 'Linked registry-demo (manual start)\n',
    });
    const listed = await cli(agentB, ['extension', 'list']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(`registry-demo\tenabled\tmanual\t${manifestPath}`);
    const store = JSON.parse(readFileSync(hostRegistry, 'utf8'));
    expect(store.extensions).toEqual([
      expect.objectContaining({ id: 'registry-demo', manifestPath, autostart: false }),
    ]);
    const started = await cli(agentB, ['extension', 'start', 'registry-demo']);
    expect(started.code, started.stderr).toBe(0);
    expect(JSON.parse(started.stdout.split('\t')[1])).toMatchObject({
      ok: true,
      running: true,
      workspace: hostWorkspace,
    });
    const health = await cli(agentA, [
      'tool',
      'extension_request',
      '--id',
      'registry-demo',
      '--capability',
      'demo.read',
      '--path',
      '/health',
    ]);
    expect(health.code, health.stderr).toBe(0);
    expect(JSON.parse(health.stdout)).toEqual({ ok: true, workspace: hostWorkspace });
    expect((await cli(agentB, ['extension', 'stop', 'registry-demo'])).code).toBe(0);
    expect(await cli(agentA, ['extension', 'unlink', 'registry-demo'])).toMatchObject({
      code: 0,
      stdout: 'Unlinked registry-demo\n',
    });
    expect((await cli(agentB, ['extension', 'list'])).stdout).toBe(
      `No extensions linked (${hostRegistry})\n`
    );
    for (const workspace of [agentA, agentB])
      expect(existsSync(join(workspace, '.xangi'))).toBe(false);
  }, 30000);

  it('never falls back to an agent registry when the selected host rejects a request', async () => {
    // A live HTTP endpoint with an invalid command gives a deterministic host error.
    const result = await cli(agentA, ['extension', 'link', manifestPath, '--autostart', 'invalid']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--autostart must be true or false');
    expect(existsSync(join(agentA, '.xangi'))).toBe(false);
    expect(JSON.parse(readFileSync(hostRegistry, 'utf8')).extensions).toEqual([]);
  });

  it('never reads the workspace registry when the host connection fails', async () => {
    mkdirSync(join(agentB, '.xangi'));
    const localRegistry = join(agentB, '.xangi', 'extensions.json');
    writeFileSync(localRegistry, 'invalid registry: must not be read');
    const result = await cli(agentB, ['extension', 'list'], 'http://127.0.0.1:0');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('tool-serverへ接続できません');
    expect(readFileSync(localRegistry, 'utf8')).toBe('invalid registry: must not be read');
  });

  it('preserves explicit offline setup when no tool server is selected', async () => {
    expect(await cli(agentA, ['extension', 'link', manifestPath], '')).toMatchObject({
      code: 0,
      stdout: 'Linked registry-demo (autostart)\n',
    });
    expect((await cli(agentA, ['extension', 'list'], '')).stdout).toContain(
      'registry-demo\tenabled\tautostart'
    );
    expect((await cli(agentA, ['extension', 'unlink', 'registry-demo'], '')).code).toBe(0);
    expect(JSON.parse(readFileSync(hostRegistry, 'utf8')).extensions).toEqual([]);
  });

  it.each([
    [{ action: 'unknown' }, 'requires --action'],
    [{ action: 'link', manifest: './relative.json' }, 'absolute --manifest'],
    [{ action: 'unlink' }, 'requires --id'],
  ])('rejects invalid registry requests with HTTP 400: %j', async (flags, message) => {
    const response = await fetch(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'extension_registry', flags }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(message);
  });

  it('keeps independent xangi instance registries isolated', async () => {
    const previous = process.env.XANGI_EXTENSIONS_FILE;
    try {
      process.env.XANGI_EXTENSIONS_FILE = join(root, 'other-instance', 'extensions.json');
      await executeExtensionRegistryCommand({ action: 'link', manifest: manifestPath });
      expect(await executeExtensionRegistryCommand({ action: 'list' })).toContain('registry-demo');
      process.env.XANGI_EXTENSIONS_FILE = previous;
      expect(await executeExtensionRegistryCommand({ action: 'list' })).toBe(
        `No extensions linked (${hostRegistry})`
      );
    } finally {
      process.env.XANGI_EXTENSIONS_FILE = previous;
    }
  });
});
