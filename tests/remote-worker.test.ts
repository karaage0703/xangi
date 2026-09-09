import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteWorkerGateway } from '../src/remote-worker/gateway.js';
import {
  RemoteWorkerNode,
  executeWorkerMethod,
  type RemoteWorkerNodeConfig,
} from '../src/remote-worker/node.js';
import {
  decodePairingUri,
  cliInvocation,
  workerProcessIsRunning,
  manageMacWorker,
  installMacWorker,
  renderWorkerLaunchAgent,
  workerInstallLayout,
} from '../src/remote-worker/install.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function tempConfig(): { config: RemoteWorkerNodeConfig; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xangi-remote-worker-')));
  const tokenFile = join(root, 'token');
  writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    config: {
      gatewayUrl: 'ws://127.0.0.1:1/api/remote-workers/connect',
      workerId: 'test-worker',
      tokenFile,
      workspaceRoots: [root],
      allowedCommands: [process.execPath],
    },
  };
}

describe('remote worker node safety', () => {
  it('runs an argv command without a shell inside an allowed workspace', async () => {
    const { config, root } = tempConfig();
    const result = (await executeWorkerMethod(
      'exec',
      { argv: [process.execPath, '-e', 'process.stdout.write("ok")'], cwd: root },
      config
    )) as { stdout: string; exitCode: number };
    expect(result).toMatchObject({ stdout: 'ok', exitCode: 0 });
  });

  it('rejects commands outside the allowlist', async () => {
    const { config, root } = tempConfig();
    await expect(
      executeWorkerMethod('exec', { argv: ['/bin/sh', '-c', 'echo unsafe'], cwd: root }, config)
    ).rejects.toThrow('command is not allowlisted');
  });

  it('does not accept an absolute executable by basename', async () => {
    const { config, root } = tempConfig();
    config.allowedCommands = ['node'];
    await expect(
      executeWorkerMethod('exec', { argv: ['/tmp/node', '--version'], cwd: root }, config)
    ).rejects.toThrow('command is not allowlisted');
  });

  it('rejects a cwd outside configured workspace roots', async () => {
    const { config } = tempConfig();
    await expect(
      executeWorkerMethod('exec', { argv: [process.execPath, '--version'], cwd: '/tmp' }, config)
    ).rejects.toThrow('outside configured workspace roots');
  });
});

describe('remote worker gateway', () => {
  it('exchanges a single-use expiring pairing code and persists registration', async () => {
    const { root } = tempConfig();
    const registrations = join(root, 'workers.json');
    writeFileSync(registrations, '[]\n', { mode: 0o600 });
    const server: Server = createServer();
    const gateway = new RemoteWorkerGateway(registrations);
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => {
      gateway.close();
      server.close();
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const pairUri = gateway.createPairing(
      'paired-mac',
      `ws://127.0.0.1:${port}/api/remote-workers/connect`
    );
    const payload = decodePairingUri(pairUri);
    const first = await fetch(payload.pairUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: payload.code }),
    });
    expect(first.status).toBe(200);
    const registration = (await first.json()) as { workerId: string; token: string };
    expect(registration.workerId).toBe('paired-mac');
    expect(registration.token.length).toBeGreaterThan(30);
    const persisted = JSON.parse(readFileSync(registrations, 'utf8')) as Array<{
      id: string;
      tokenFile: string;
    }>;
    expect(persisted[0]?.id).toBe('paired-mac');
    expect(readFileSync(persisted[0]!.tokenFile, 'utf8').trim()).toBe(registration.token);
    const second = await fetch(payload.pairUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: payload.code }),
    });
    expect(second.status).toBe(401);
  });

  it('accepts an outbound node connection and returns system information', async () => {
    const { config, root } = tempConfig();
    const registrations = join(root, 'workers.json');
    writeFileSync(
      registrations,
      JSON.stringify([{ id: config.workerId, tokenFile: config.tokenFile }])
    );
    const server: Server = createServer();
    const gateway = new RemoteWorkerGateway(registrations);
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const node = new RemoteWorkerNode({
      ...config,
      gatewayUrl: `ws://127.0.0.1:${port}/api/remote-workers/connect`,
      reconnectMs: 20,
    });
    node.start();
    cleanup.push(() => {
      node.stop();
      gateway.close();
      server.close();
    });

    await expect
      .poll(() => (gateway.list() as Array<{ connected: boolean }>)[0]?.connected, {
        timeout: 2_000,
      })
      .toBe(true);
    const result = (await gateway.request('test-worker', 'system.info')) as {
      workerId: string;
      capabilities: string[];
    };
    expect(result.workerId).toBe('test-worker');
    expect(result.capabilities).toContain('exec');

    const execution = (await gateway.request('test-worker', 'exec', {
      argv: [process.execPath, '-e', 'process.stdout.write("remote-ok")'],
      cwd: root,
    })) as { stdout: string; exitCode: number };
    expect(execution).toMatchObject({ stdout: 'remote-ok', exitCode: 0 });
  });
});

describe('remote worker macOS installation', () => {
  it('launches a TypeScript entry with its loader in a fresh Node process', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-source-'));
    const entry = join(root, 'entry.ts');
    writeFileSync(entry, 'const value: string = "loader-ok"; console.log(value);');
    const previous = process.argv[1];
    process.argv[1] = entry;
    try {
      const invocation = cliInvocation();
      const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', cwd: '/' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('loader-ok');
    } finally {
      process.argv[1] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report a registered crash loop as running', () => {
    expect(
      workerProcessIsRunning('state = spawn scheduled\nlast exit code = 1\nstate = active')
    ).toBe(false);
    expect(workerProcessIsRunning('state = running\n pid = 123')).toBe(true);
    expect(workerProcessIsRunning('state = running')).toBe(false);
  });

  it('exchanges pairing and installs private config plus a launch agent', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'xangi-worker-install-')));
    const registrations = join(root, 'workers.json');
    const bin = join(root, 'bin');
    const launchctl = join(bin, 'launchctl');
    const workerHome = join(root, 'worker-home');
    const launchAgents = join(root, 'LaunchAgents');
    writeFileSync(registrations, '[]\n', { mode: 0o600 });
    await import('node:fs/promises').then(({ mkdir }) => mkdir(bin));
    writeFileSync(launchctl, '#!/bin/sh\nexit 0\n');
    chmodSync(launchctl, 0o755);
    const previous = {
      path: process.env.PATH,
      home: process.env.XANGI_WORKER_HOME,
      agents: process.env.XANGI_WORKER_LAUNCH_AGENTS_DIR,
      cli: process.env.XANGI_WORKER_CLI,
      allow: process.env.XANGI_WORKER_ALLOW_NON_DARWIN,
    };
    process.env.PATH = `${bin}:${previous.path || ''}`;
    process.env.XANGI_WORKER_HOME = workerHome;
    process.env.XANGI_WORKER_LAUNCH_AGENTS_DIR = launchAgents;
    process.env.XANGI_WORKER_CLI = '/bin/true';
    process.env.XANGI_WORKER_ALLOW_NON_DARWIN = 'true';
    const server: Server = createServer();
    const gateway = new RemoteWorkerGateway(registrations);
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const pairUri = gateway.createPairing(
      'installed-mac',
      `ws://127.0.0.1:${port}/api/remote-workers/connect`
    );
    cleanup.push(() => {
      gateway.close();
      server.close();
      rmSync(root, { recursive: true, force: true });
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('PATH', previous.path);
      restore('XANGI_WORKER_HOME', previous.home);
      restore('XANGI_WORKER_LAUNCH_AGENTS_DIR', previous.agents);
      restore('XANGI_WORKER_CLI', previous.cli);
      restore('XANGI_WORKER_ALLOW_NON_DARWIN', previous.allow);
    });

    await expect(installMacWorker(pairUri, root)).resolves.toContain('installed-mac');
    const layout = workerInstallLayout();
    expect(statSync(layout.configPath).mode & 0o777).toBe(0o600);
    expect(statSync(layout.tokenPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(layout.configPath, 'utf8')).toContain('installed-mac');
    expect(readFileSync(layout.plistPath, 'utf8')).toContain('<string>/bin/true</string>');
    const tokenBefore = readFileSync(layout.tokenPath, 'utf8');
    const configBefore = readFileSync(layout.configPath, 'utf8');
    writeFileSync(layout.plistPath, 'obsolete launch command');
    expect(manageMacWorker('restart')).toContain('restarted');
    expect(readFileSync(layout.plistPath, 'utf8')).toContain('<string>/bin/true</string>');
    expect(readFileSync(layout.tokenPath, 'utf8')).toBe(tokenBefore);
    expect(readFileSync(layout.configPath, 'utf8')).toBe(configBefore);
  });

  it('renders a launch agent that only starts worker mode', () => {
    const layout = workerInstallLayout('/Users/Test User');
    const plist = renderWorkerLaunchAgent(layout, '/Users/Test User/.local/bin/xangi');
    expect(plist).toContain('<string>dev.xangi.worker</string>');
    expect(plist).toContain('<string>worker</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('<string>--config</string>');
    expect(plist).toContain('/Users/Test User/.config/xangi/worker/worker.json');
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  it('rejects expired pairing values before contacting a gateway', () => {
    const value = Buffer.from(
      JSON.stringify({
        version: 1,
        pairUrl: 'https://example.test/api/remote-workers/pair',
        code: 'expired',
        workerId: 'mac',
        expiresAt: Date.now() - 1,
      })
    ).toString('base64url');
    expect(() => decodePairingUri(`xangi-pair://${value}`)).toThrow('expired');
  });

  it('rejects plaintext pairing over a public address', () => {
    const value = Buffer.from(
      JSON.stringify({
        version: 1,
        pairUrl: 'http://203.0.113.5/api/remote-workers/pair',
        code: 'public-http',
        workerId: 'mac',
        expiresAt: Date.now() + 60_000,
      })
    ).toString('base64url');
    expect(() => decodePairingUri(`xangi-pair://${value}`)).toThrow('plaintext pairing');
  });
});
