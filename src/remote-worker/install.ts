import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

interface PairingPayload {
  version: 1;
  pairUrl: string;
  code: string;
  workerId: string;
  expiresAt: number;
}

interface PairingResponse {
  workerId: string;
  gatewayUrl: string;
  token: string;
}

export interface WorkerInstallLayout {
  root: string;
  configPath: string;
  tokenPath: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  label: string;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function isPrivatePairingEndpoint(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  const octets = host.split('.').map(Number);
  return (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    octets[0] === 100 &&
    octets[1] >= 64 &&
    octets[1] <= 127
  );
}

export function decodePairingUri(value: string): PairingPayload {
  if (!value.startsWith('xangi-pair://'))
    throw new Error('pairing value must start with xangi-pair://');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice('xangi-pair://'.length), 'base64url').toString());
  } catch {
    throw new Error('pairing value is malformed');
  }
  const payload = parsed as Partial<PairingPayload>;
  if (
    payload.version !== 1 ||
    typeof payload.pairUrl !== 'string' ||
    typeof payload.code !== 'string' ||
    typeof payload.workerId !== 'string' ||
    typeof payload.expiresAt !== 'number'
  ) {
    throw new Error('pairing value is malformed');
  }
  if (payload.expiresAt < Date.now()) throw new Error('pairing value has expired');
  const pairUrl = new URL(payload.pairUrl);
  if (!['http:', 'https:'].includes(pairUrl.protocol)) {
    throw new Error('pairing endpoint must use http:// or https://');
  }
  if (!isPrivatePairingEndpoint(pairUrl)) {
    throw new Error('plaintext pairing is limited to loopback or Tailscale addresses');
  }
  return payload as PairingPayload;
}

export function workerInstallLayout(homeDir = homedir()): WorkerInstallLayout {
  const root = process.env.XANGI_WORKER_HOME || join(homeDir, '.config', 'xangi', 'worker');
  const launchAgentsDir =
    process.env.XANGI_WORKER_LAUNCH_AGENTS_DIR || join(homeDir, 'Library', 'LaunchAgents');
  return {
    root,
    configPath: join(root, 'worker.json'),
    tokenPath: join(root, 'worker.token'),
    plistPath: join(launchAgentsDir, 'dev.xangi.worker.plist'),
    stdoutPath: join(root, 'worker.log'),
    stderrPath: join(root, 'worker-error.log'),
    label: 'dev.xangi.worker',
  };
}

export function renderWorkerLaunchAgent(
  layout: WorkerInstallLayout,
  command: string,
  commandArgs: string[] = []
): string {
  const args = [command, ...commandArgs, 'worker', 'run', '--config', layout.configPath];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(layout.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((item) => `    <string>${xml(item)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(layout.stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(layout.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function runLaunchctl(args: string[], allowFailure = false): string {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || `launchctl ${args[0]} failed`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

function launchctlDomain(): string {
  if (typeof process.getuid !== 'function') throw new Error('launchd requires a user uid');
  return `gui/${process.getuid()}`;
}

export function cliInvocation(): { command: string; args: string[] } {
  const override = process.env.XANGI_WORKER_CLI;
  if (override) return { command: resolve(override), args: [] };
  if (!process.argv[1]) throw new Error('cannot resolve the xangi CLI executable');
  const entry = resolve(process.argv[1]);
  const args = entry.endsWith('.ts')
    ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, entry]
    : [entry];
  return { command: process.execPath, args };
}

export function workerProcessIsRunning(output: string): boolean {
  return /^\s*state = running\s*$/m.test(output) && /^\s*pid = [1-9]\d*\s*$/m.test(output);
}

function defaultAllowedCommands(): string[] {
  const candidates = [
    '/usr/bin/git',
    '/usr/bin/python3',
    '/usr/bin/uname',
    '/usr/bin/node',
    '/usr/bin/npm',
    '/opt/homebrew/bin/node',
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/node',
    '/usr/local/bin/npm',
  ];
  return [...new Set([process.execPath, ...candidates.filter(existsSync)])];
}

async function exchangePairing(pairing: PairingPayload): Promise<PairingResponse> {
  const response = await fetch(pairing.pairUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairing.code }),
  });
  const body = (await response.json()) as Partial<PairingResponse> & { error?: string };
  if (!response.ok) throw new Error(body.error || `pairing failed with HTTP ${response.status}`);
  if (!body.workerId || !body.gatewayUrl || !body.token) {
    throw new Error('pairing response is incomplete');
  }
  return body as PairingResponse;
}

export async function prepareWorkerConfig(pairUri: string, workspaceRoot: string): Promise<string> {
  const root = resolve(workspaceRoot);
  if (!existsSync(root)) throw new Error(`workspace root does not exist: ${root}`);
  const pairing = decodePairingUri(pairUri);
  const registration = await exchangePairing(pairing);
  if (registration.workerId !== pairing.workerId) throw new Error('pairing worker id mismatch');
  const layout = workerInstallLayout();
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  chmodSync(layout.root, 0o700);
  writeFileSync(layout.tokenPath, `${registration.token}\n`, { mode: 0o600 });
  chmodSync(layout.tokenPath, 0o600);
  writeFileSync(
    layout.configPath,
    `${JSON.stringify(
      {
        gatewayUrl: registration.gatewayUrl,
        workerId: registration.workerId,
        tokenFile: layout.tokenPath,
        workspaceRoots: [root],
        allowedCommands: defaultAllowedCommands(),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  chmodSync(layout.configPath, 0o600);
  return registration.workerId;
}

export async function installMacWorker(pairUri: string, workspaceRoot: string): Promise<string> {
  if (platform() !== 'darwin' && process.env.XANGI_WORKER_ALLOW_NON_DARWIN !== 'true') {
    throw new Error('worker install currently supports macOS only');
  }
  const invocation = cliInvocation();
  const workerId = await prepareWorkerConfig(pairUri, workspaceRoot);
  const layout = workerInstallLayout();
  mkdirSync(dirname(layout.plistPath), { recursive: true });
  writeFileSync(
    layout.plistPath,
    renderWorkerLaunchAgent(layout, invocation.command, invocation.args),
    {
      mode: 0o644,
    }
  );
  const domain = launchctlDomain();
  runLaunchctl(['bootout', `${domain}/${layout.label}`], true);
  runLaunchctl(['bootstrap', domain, layout.plistPath]);
  return `Remote worker installed: ${workerId}`;
}

export function manageMacWorker(
  action: 'start' | 'stop' | 'restart' | 'status' | 'uninstall'
): string {
  if (platform() !== 'darwin' && process.env.XANGI_WORKER_ALLOW_NON_DARWIN !== 'true') {
    throw new Error(`worker ${action} currently supports macOS only`);
  }
  const layout = workerInstallLayout();
  const domain = launchctlDomain();
  const service = `${domain}/${layout.label}`;
  if (action === 'status') {
    const result = spawnSync('launchctl', ['print', service], { encoding: 'utf8' });
    return result.status === 0 && workerProcessIsRunning(result.stdout)
      ? `Remote worker is running (${layout.configPath})`
      : result.status === 0
        ? `Remote worker is registered but not running (see ${layout.stderrPath})`
        : 'Remote worker is stopped';
  }
  if (action === 'start') {
    runLaunchctl(['bootstrap', domain, layout.plistPath]);
    return 'Remote worker started';
  }
  if (action === 'restart') {
    const invocation = cliInvocation();
    // Refresh the launch command while preserving the existing pairing credentials.
    if (!existsSync(layout.configPath)) throw new Error('worker is not installed');
    writeFileSync(
      layout.plistPath,
      renderWorkerLaunchAgent(layout, invocation.command, invocation.args),
      {
        mode: 0o644,
      }
    );
    runLaunchctl(['bootout', service], true);
    runLaunchctl(['bootstrap', domain, layout.plistPath]);
    return 'Remote worker restarted';
  }
  runLaunchctl(['bootout', service], action === 'uninstall');
  if (action === 'stop') return 'Remote worker stopped';
  rmSync(layout.plistPath, { force: true });
  if (existsSync(layout.root)) rmSync(layout.root, { recursive: true, force: true });
  return 'Remote worker uninstalled';
}

export function readInstalledWorkerConfig(): string {
  return readFileSync(workerInstallLayout().configPath, 'utf8');
}
