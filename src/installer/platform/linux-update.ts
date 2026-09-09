import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UpdateSchedulerAdapter, UpdateSchedulerStatus } from './update-scheduler.js';
import { systemdPathValue } from './linux.js';
import {
  defaultCommandRunner as defaultCommands,
  systemdValue,
  validatedInterval,
  writeAtomic,
  type CommandRunner,
} from './common.js';

export interface SystemdUpdateSchedulerOptions {
  serviceName: string;
  servicePath: string;
  timerName: string;
  timerPath: string;
  launcherPath: string;
  workingDirectory: string;
  intervalSeconds?: number;
}

export type LinuxUpdateCommandRunner = CommandRunner;

function unitName(value: string, suffix: 'service' | 'timer'): string {
  if (!new RegExp(`^[A-Za-z0-9_.@-]+\\.${suffix}$`).test(value)) {
    throw new Error(`Invalid systemd ${suffix} name: ${value}`);
  }
  return value;
}

export function renderSystemdUpdateService(options: SystemdUpdateSchedulerOptions): string {
  unitName(options.serviceName, 'service');
  return [
    '[Unit]',
    'Description=Update xangi from its signed release channel',
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${systemdValue(options.launcherPath)} update`,
    `WorkingDirectory=${systemdPathValue(options.workingDirectory)}`,
    '',
  ].join('\n');
}

export function renderSystemdUpdateTimer(options: SystemdUpdateSchedulerOptions): string {
  const serviceName = unitName(options.serviceName, 'service');
  unitName(options.timerName, 'timer');
  const interval = validatedInterval(options.intervalSeconds);
  return [
    '[Unit]',
    'Description=Periodically check for signed xangi updates',
    '',
    '[Timer]',
    'OnBootSec=5m',
    `OnUnitActiveSec=${interval}s`,
    'Persistent=true',
    `Unit=${serviceName}`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

export function createLinuxUpdateScheduler(
  options: SystemdUpdateSchedulerOptions,
  commands: LinuxUpdateCommandRunner = defaultCommands
): UpdateSchedulerAdapter {
  return {
    async install(): Promise<void> {
      const availability = commands.status('systemctl', ['--user', 'show-environment']);
      if (availability.status !== 0) {
        throw new Error('systemd user timer is unavailable');
      }
      mkdirSync(dirname(options.servicePath), { recursive: true });
      mkdirSync(dirname(options.timerPath), { recursive: true });
      try {
        writeAtomic(options.servicePath, renderSystemdUpdateService(options));
        writeAtomic(options.timerPath, renderSystemdUpdateTimer(options));
        commands.run('systemctl', ['--user', 'daemon-reload']);
        commands.run('systemctl', ['--user', 'enable', '--now', options.timerName]);
      } catch (error) {
        commands.run('systemctl', ['--user', 'disable', '--now', options.timerName], true);
        rmSync(options.servicePath, { force: true });
        rmSync(options.timerPath, { force: true });
        commands.run('systemctl', ['--user', 'daemon-reload'], true);
        throw error;
      }
    },
    async uninstall(): Promise<void> {
      commands.run('systemctl', ['--user', 'disable', '--now', options.timerName], true);
      rmSync(options.servicePath, { force: true });
      rmSync(options.timerPath, { force: true });
      commands.run('systemctl', ['--user', 'daemon-reload'], true);
    },
    async status(): Promise<UpdateSchedulerStatus> {
      const enabled = commands.status('systemctl', ['--user', 'is-enabled', options.timerName]);
      const active = commands.status('systemctl', ['--user', 'is-active', options.timerName]);
      return {
        installed:
          enabled.status === 0 &&
          enabled.output.trim() === 'enabled' &&
          active.status === 0 &&
          active.output.trim() === 'active',
        detail: `${enabled.output}; ${active.output}`,
      };
    },
  };
}
