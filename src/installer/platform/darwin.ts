import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ServiceAdapter, ServiceStatus } from './service.js';

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

export interface DarwinCommandRunner {
  run(command: string, args: string[], allowFailure?: boolean): string;
  status(command: string, args: string[]): { status: number | null; output: string };
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

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

function launchctlDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('LaunchAgent requires a numeric user id');
  }
  return 'gui/' + uid;
}

function run(command: string, args: string[], allowFailure = false): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  if (!allowFailure && (result.status ?? 1) !== 0) {
    throw new Error(output.trim() || command + ' ' + args.join(' ') + ' failed');
  }
  return output.trim();
}

const defaultCommandRunner: DarwinCommandRunner = {
  run,
  status(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return {
      status: result.status,
      output: (String(result.stdout ?? '') + String(result.stderr ?? '')).trim(),
    };
  },
};

export function createDarwinServiceAdapter(
  options: DarwinServiceOptions,
  commands: DarwinCommandRunner = defaultCommandRunner
): ServiceAdapter {
  const domain = launchctlDomain();
  const writePlist = (path: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = path + '.tmp-' + process.pid;
    writeFileSync(temporary, renderLaunchAgentPlist(options), { mode: 0o644 });
    chmodSync(temporary, 0o644);
    renameSync(temporary, path);
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
