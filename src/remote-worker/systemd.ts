import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { cliInvocation, prepareWorkerConfig, workerInstallLayout } from './install.js';

const service = 'xangi-worker.service';

export function workerUnitPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'systemd',
    'user',
    service
  );
}

function systemctl(args: string[]): string {
  const result = spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `systemctl --user ${args[0]} failed: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim()}. ` +
        'Linux/WSL2 requires a running systemd user manager. See docs/remote-workers.md.'
    );
  }
  return result.stdout.trim();
}

function quoteArgument(value: string): string {
  if (
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('service paths cannot contain control characters');
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', () => '$$')}"`;
}

export function renderWorkerUnit(command: string, args: string[], configPath: string): string {
  return [
    '[Unit]',
    'Description=xangi remote worker',
    '',
    '[Service]',
    'Type=exec',
    `ExecStart=${[command, ...args, 'worker', 'run', '--config', configPath].map(quoteArgument).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=5',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function currentUnit(): string {
  const invocation = cliInvocation();
  return renderWorkerUnit(invocation.command, invocation.args, workerInstallLayout().configPath);
}

function writeUnit(unit: string): void {
  const path = workerUnitPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, unit, { mode: 0o644 });
  systemctl(['daemon-reload']);
}

export async function installLinuxWorker(pairUri: string, workspaceRoot: string): Promise<string> {
  // Check prerequisites before consuming the single-use pairing or changing credentials.
  systemctl(['show-environment']);
  if (existsSync(workerInstallLayout().configPath)) {
    throw new Error('worker is already installed; use xangi worker restart or uninstall first');
  }
  const unit = currentUnit();
  const workerId = await prepareWorkerConfig(pairUri, workspaceRoot);
  writeUnit(unit);
  systemctl(['enable', '--now', service]);
  return `Remote worker installed: ${workerId}. Check xangi worker status and Gateway connectivity.`;
}

export function manageLinuxWorker(
  action: 'start' | 'stop' | 'restart' | 'status' | 'uninstall'
): string {
  systemctl(['show-environment']);
  const layout = workerInstallLayout();
  if (action === 'status') {
    const output = systemctl([
      'show',
      service,
      '--property=LoadState,ActiveState,SubState,MainPID',
    ]);
    const state = Object.fromEntries(output.split('\n').map((line) => line.split('=')));
    if (state.LoadState === 'not-found') return 'Remote worker is not installed';
    if (
      state.ActiveState === 'active' &&
      state.SubState === 'running' &&
      Number(state.MainPID) > 0
    ) {
      return `Remote worker is running (PID ${state.MainPID}, ${layout.configPath})`;
    }
    return `Remote worker is not running (${state.ActiveState}/${state.SubState}). See journalctl --user -u ${service}`;
  }
  if (action === 'uninstall') {
    if (existsSync(workerUnitPath())) systemctl(['disable', '--now', service]);
    rmSync(workerUnitPath(), { force: true });
    systemctl(['daemon-reload']);
    // Remove only worker-owned files, preserving unrelated files in an overridden directory.
    rmSync(layout.configPath, { force: true });
    rmSync(layout.tokenPath, { force: true });
    return 'Remote worker uninstalled';
  }
  if (!existsSync(layout.configPath)) throw new Error('worker is not installed');
  if (action === 'restart' || action === 'start') writeUnit(currentUnit());
  systemctl([action, service]);
  return `Remote worker ${action === 'stop' ? 'stopped' : action === 'restart' ? 'restarted' : 'started'}`;
}
