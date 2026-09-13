import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ServiceAdapter, ServiceStatus } from './service.js';
import {
  defaultCommandRunner,
  launchctlDomain,
  writeAtomic,
  xml,
  type CommandRunner,
} from './common.js';

export type { ServiceAdapter, ServiceStatus } from './service.js';

export interface LaunchAgentOptions {
  label: string;
  nodePath: string;
  entrypoint: string;
  configLoaderPath: string;
  configPath: string;
  stateDir: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  path: string;
}

export interface DarwinServiceOptions extends LaunchAgentOptions {
  plistPath: string;
  autostartPlistPath: string;
}

export type DarwinCommandRunner = CommandRunner;

export function renderLaunchAgentPlist(options: LaunchAgentOptions): string {
  const args = [
    options.nodePath,
    options.configLoaderPath,
    options.configPath,
    options.stateDir,
    options.entrypoint,
  ]
    .map((arg) => '      <string>' + xml(arg) + '</string>')
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + xml(options.label) + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    '  <string>' + xml(options.workingDirectory) + '</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    '    <string>' + xml(options.path) + '</string>',
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    '  <string>' + xml(options.stdoutPath) + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + xml(options.stderrPath) + '</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function createDarwinServiceAdapter(
  options: DarwinServiceOptions,
  commands: DarwinCommandRunner = defaultCommandRunner
): ServiceAdapter {
  const domain = launchctlDomain();
  const writePlist = (path: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, renderLaunchAgentPlist(options));
  };
  const activePlistPath = (): string =>
    existsSync(options.autostartPlistPath) ? options.autostartPlistPath : options.plistPath;
  return {
    async install(): Promise<void> {
      mkdirSync(dirname(options.stdoutPath), { recursive: true });
      mkdirSync(dirname(options.stderrPath), { recursive: true });
      writePlist(options.plistPath);
      if (existsSync(options.autostartPlistPath)) writePlist(options.autostartPlistPath);
      commands.run('launchctl', ['bootout', domain + '/' + options.label], true);
      commands.run('launchctl', ['bootstrap', domain, activePlistPath()]);
    },
    async start(): Promise<void> {
      const result = commands.status('launchctl', ['print', domain + '/' + options.label]);
      if (result.status !== 0) {
        commands.run('launchctl', ['bootstrap', domain, activePlistPath()]);
      }
    },
    async stop(): Promise<void> {
      const result = commands.status('launchctl', ['print', domain + '/' + options.label]);
      if (result.status === 0) {
        commands.run('launchctl', ['bootout', domain + '/' + options.label]);
      }
    },
    async autostart(enabled: boolean): Promise<void> {
      if (enabled) {
        writePlist(options.autostartPlistPath);
      } else {
        rmSync(options.autostartPlistPath, { force: true });
      }
    },
    async restart(): Promise<void> {
      commands.run('launchctl', ['kickstart', '-k', domain + '/' + options.label]);
    },
    async uninstall(): Promise<void> {
      commands.run('launchctl', ['bootout', domain + '/' + options.label], true);
      rmSync(options.plistPath, { force: true });
      rmSync(options.autostartPlistPath, { force: true });
    },
    async status(): Promise<ServiceStatus> {
      const result = commands.status('launchctl', ['print', domain + '/' + options.label]);
      return {
        running: result.status === 0,
        detail: result.output,
      };
    },
    async openBrowser(url: string): Promise<void> {
      if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(url)) {
        throw new Error('Only loopback setup URLs may be opened');
      }
      commands.run('open', [url]);
    },
  };
}
