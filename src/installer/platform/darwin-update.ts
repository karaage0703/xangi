import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UpdateSchedulerAdapter, UpdateSchedulerStatus } from './update-scheduler.js';
import {
  defaultCommandRunner as defaultCommands,
  launchctlDomain,
  validatedInterval,
  writeAtomic,
  xml,
  type CommandRunner,
} from './common.js';

export interface DarwinUpdateSchedulerOptions {
  label: string;
  plistPath: string;
  launcherPath: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  intervalSeconds?: number;
}

export type DarwinUpdateCommandRunner = CommandRunner;

export function renderUpdateLaunchAgentPlist(options: DarwinUpdateSchedulerOptions): string {
  const interval = validatedInterval(options.intervalSeconds);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(options.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(options.launcherPath)}</string>`,
    '    <string>update</string>',
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(options.workingDirectory)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>StartInterval</key>',
    `  <integer>${interval}</integer>`,
    '  <key>StandardOutPath</key>',
    `  <string>${xml(options.stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(options.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function createDarwinUpdateScheduler(
  options: DarwinUpdateSchedulerOptions,
  commands: DarwinUpdateCommandRunner = defaultCommands
): UpdateSchedulerAdapter {
  const domain = launchctlDomain();
  return {
    async install(): Promise<void> {
      mkdirSync(dirname(options.plistPath), { recursive: true });
      mkdirSync(dirname(options.stdoutPath), { recursive: true });
      mkdirSync(dirname(options.stderrPath), { recursive: true });
      try {
        writeAtomic(options.plistPath, renderUpdateLaunchAgentPlist(options));
        commands.run('launchctl', ['bootout', domain, options.plistPath], true);
        commands.run('launchctl', ['bootstrap', domain, options.plistPath]);
      } catch (error) {
        commands.run('launchctl', ['bootout', domain, options.plistPath], true);
        rmSync(options.plistPath, { force: true });
        throw error;
      }
    },
    async uninstall(): Promise<void> {
      commands.run('launchctl', ['bootout', domain, options.plistPath], true);
      rmSync(options.plistPath, { force: true });
    },
    async status(): Promise<UpdateSchedulerStatus> {
      const result = commands.status('launchctl', ['print', `${domain}/${options.label}`]);
      return { installed: result.status === 0, detail: result.output };
    },
  };
}
