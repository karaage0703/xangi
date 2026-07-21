import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ServiceAdapter } from './service.js';

export interface SystemdUserServiceOptions {
  unitName: string;
  unitPath: string;
  nodePath: string;
  entrypoint: string;
  configLoaderPath: string;
  configPath: string;
  stateDir: string;
  workingDirectory: string;
  path: string;
  /** Override only for tests. Runtime detection is used when omitted. */
  wsl?: boolean;
}

export interface LinuxCommandRunner {
  run(command: string, args: string[], allowFailure?: boolean): string;
  status(command: string, args: string[]): { status: number | null; output: string };
}

export interface WslDetectionInput {
  env?: NodeJS.ProcessEnv;
  procVersion?: string;
}

export function isWsl(input: WslDetectionInput = {}): boolean {
  const env = input.env ?? process.env;
  if (env.WSL_INTEROP || env.WSL_DISTRO_NAME) return true;
  let procVersion = input.procVersion;
  if (procVersion === undefined) {
    try {
      procVersion = readFileSync('/proc/version', 'utf8');
    } catch {
      procVersion = '';
    }
  }
  return /(?:microsoft|wsl)/i.test(procVersion);
}

function systemdValue(value: string): string {
  if ([...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('systemd unit values may not contain control characters');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

export function renderSystemdUserUnit(options: SystemdUserServiceOptions): string {
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(options.unitName)) {
    throw new Error(`Invalid systemd unit name: ${options.unitName}`);
  }
  const args = [
    options.nodePath,
    options.configLoaderPath,
    options.configPath,
    options.stateDir,
    options.entrypoint,
  ]
    .map(systemdValue)
    .join(' ');
  return [
    '[Unit]',
    'Description=xangi AI assistant',
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${args}`,
    `WorkingDirectory=${systemdValue(options.workingDirectory)}`,
    `Environment=${systemdValue(`PATH=${options.path}`)}`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function run(command: string, args: string[], allowFailure = false): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  if (!allowFailure && (result.status ?? 1) !== 0) {
    throw new Error(output.trim() || `${command} ${args.join(' ')} failed`);
  }
  return output.trim();
}

const defaultCommandRunner: LinuxCommandRunner = {
  run,
  status(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return {
      status: result.status,
      output: (String(result.stdout ?? '') + String(result.stderr ?? '')).trim(),
    };
  },
};

function assertLoopbackUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Only authenticated loopback setup URLs may be opened');
  }
  const entries = [...parsed.searchParams.entries()];
  const token = parsed.searchParams.get('token');
  const validPort =
    /^\d+$/.test(parsed.port) && Number(parsed.port) >= 1 && Number(parsed.port) <= 65535;
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !validPort ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/setup' ||
    parsed.hash !== '' ||
    entries.length !== 1 ||
    entries[0]?.[0] !== 'token' ||
    token === null ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    url !== `http://127.0.0.1:${parsed.port}/setup?token=${token}`
  ) {
    throw new Error('Only authenticated loopback setup URLs may be opened');
  }
}

export function openLinuxBrowser(
  url: string,
  commands: LinuxCommandRunner = defaultCommandRunner,
  runningInWsl = isWsl()
): void {
  assertLoopbackUrl(url);
  if (!runningInWsl) {
    commands.run('xdg-open', [url]);
    return;
  }
  if (commands.status('wslview', ['--version']).status === 0) {
    commands.run('wslview', [url]);
    return;
  }
  commands.run('cmd.exe', ['/c', 'start', '', url]);
}

export function createLinuxServiceAdapter(
  options: SystemdUserServiceOptions,
  commands: LinuxCommandRunner = defaultCommandRunner
): ServiceAdapter {
  const runningInWsl = options.wsl ?? isWsl();
  return {
    async install(): Promise<void> {
      const availability = commands.status('systemctl', ['--user', 'show-environment']);
      if (availability.status !== 0) {
        const context = runningInWsl
          ? 'Enable systemd in /etc/wsl.conf, restart WSL, then retry'
          : 'A working systemd user session is required';
        throw new Error(`systemd user service is unavailable. ${context}`);
      }
      mkdirSync(dirname(options.unitPath), { recursive: true });
      const temporary = `${options.unitPath}.tmp-${process.pid}`;
      writeFileSync(temporary, renderSystemdUserUnit(options), { mode: 0o644 });
      chmodSync(temporary, 0o644);
      renameSync(temporary, options.unitPath);
      commands.run('systemctl', ['--user', 'daemon-reload']);
      commands.run('systemctl', ['--user', 'start', options.unitName]);
    },
    async start(): Promise<void> {
      commands.run('systemctl', ['--user', 'start', options.unitName]);
    },
    async stop(): Promise<void> {
      commands.run('systemctl', ['--user', 'stop', options.unitName]);
    },
    async autostart(enabled: boolean): Promise<void> {
      commands.run('systemctl', ['--user', enabled ? 'enable' : 'disable', options.unitName]);
    },
    async uninstall(): Promise<void> {
      commands.run('systemctl', ['--user', 'disable', '--now', options.unitName], true);
      rmSync(options.unitPath, { force: true });
      commands.run('systemctl', ['--user', 'daemon-reload'], true);
    },
    async restart(): Promise<void> {
      commands.run('systemctl', ['--user', 'restart', options.unitName]);
    },
    async status() {
      const result = commands.status('systemctl', ['--user', 'is-active', options.unitName]);
      return {
        running: result.status === 0 && result.output.trim() === 'active',
        detail: result.output,
      };
    },
    async openBrowser(url: string): Promise<void> {
      openLinuxBrowser(url, commands, runningInWsl);
    },
  };
}
