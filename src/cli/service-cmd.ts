import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { arch, homedir, platform } from 'os';
import { resolveAppLayout } from '../installer/layout.js';
import type { ServiceAdapter } from '../installer/platform/service.js';
import { SETUP_CONFIG_PATH_ENV, SETUP_STATE_DIR_ENV } from '../installer/runtime-config.js';
import { parseSetupConfig } from '../setup/schema.js';
import { resolveManagedLifecycle } from './update-cmd.js';

export interface ServiceCommandDependencies {
  installationKind?: 'checkout' | 'managed';
  managedService?: ServiceAdapter;
}

const SERVICE_USAGE = [
  'Usage: xangi service <start|stop|restart|status> [--name <process-name>] [--dir <xangi-dir>]',
  '       xangi service autostart <enable|disable> [--name <process-name>] [--dir <xangi-dir>]',
  'Tip: run ./bin/xangi from the target clone, or use named symlinks such as xangi-dev / xangi-prod.',
  '--dir is an escape hatch for controlling another clone from a PATH-level xangi.',
].join('\n');

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function projectDir(flags: Record<string, string | boolean>): string {
  const dir = stringFlag(flags, 'dir');
  if (dir) {
    return dir;
  }
  if (process.env.XANGI_DIR) {
    return process.env.XANGI_DIR;
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function readDotEnvValue(dir: string, key: string): string | undefined {
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) {
    return undefined;
  }
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const envKey = line.slice(0, eqIdx).trim();
    if (envKey !== key) {
      continue;
    }
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function resolveProcessName(flags: Record<string, string | boolean>): string {
  const dir = projectDir(flags);
  return (
    stringFlag(flags, 'name') ||
    process.env.XANGI_PROCESS_NAME ||
    readDotEnvValue(dir, 'XANGI_PROCESS_NAME') ||
    process.env.XANGI_INSTANCE_ID ||
    readDotEnvValue(dir, 'XANGI_INSTANCE_ID') ||
    basename(dir)
  );
}

function runPm2(
  args: string[],
  flags: Record<string, string | boolean>
): { status: number; output: string } {
  const proc = spawnSync('pm2', args, {
    cwd: projectDir(flags),
    encoding: 'utf8',
    env: checkoutRuntimeEnv(flags),
  });
  return {
    status: proc.status ?? 1,
    output: `${proc.stdout || ''}${proc.stderr || ''}`.trim(),
  };
}

function checkoutRuntimeEnv(flags: Record<string, string | boolean>): NodeJS.ProcessEnv {
  const currentPlatform = platform();
  if (currentPlatform !== 'darwin' && currentPlatform !== 'linux') return process.env;
  const layout = resolveAppLayout({
    platform: currentPlatform,
    arch: arch(),
    homeDir: homedir(),
    xdgDataHome: process.env.XDG_DATA_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgStateHome: process.env.XDG_STATE_HOME,
  });
  if (!existsSync(layout.configFile)) return process.env;
  const dir = projectDir(flags);
  const isCheckout = existsSync(join(dir, '.git'));
  const explicitStateDir =
    readDotEnvValue(dir, 'DATA_DIR') || (isCheckout ? undefined : process.env.DATA_DIR);
  const setup = parseSetupConfig(JSON.parse(readFileSync(layout.configFile, 'utf8')) as unknown);
  const stateDir =
    explicitStateDir || (isCheckout ? join(setup.workspacePath, '.xangi') : layout.stateDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [SETUP_CONFIG_PATH_ENV]: layout.configFile,
    [SETUP_STATE_DIR_ENV]: stateDir,
  };
  const name = stringFlag(flags, 'name');
  if (name) env.XANGI_PROCESS_NAME = name;
  return env;
}

function ensurePm2(): void {
  const proc = spawnSync('pm2', ['--version'], { encoding: 'utf8' });
  if (proc.error && 'code' in proc.error && proc.error.code === 'ENOENT') {
    throw new Error('pm2 が見つかりません。PM2運用では npm install -g pm2 を先に実行してください');
  }
}

function isPm2StartupGuidance(output: string): boolean {
  return /\bsudo\s+env\b/.test(output) && /\bpm2\s+startup\b/.test(output);
}

function isPm2UnstartupGuidance(output: string): boolean {
  return /\bsudo\b/.test(output) && /\bpm2\s+unstartup\b/.test(output);
}

function replacePm2ProcessFromConfig(
  flags: Record<string, string | boolean>,
  name: string
): string {
  const pm2ConfigPath = join(projectDir(flags), 'ecosystem.config.cjs');
  if (!existsSync(pm2ConfigPath)) {
    throw new Error(`ecosystem.config.cjs が見つかりません: ${pm2ConfigPath}`);
  }
  const existing = runPm2(['describe', name], flags);
  if (existing.status === 0) {
    const removed = runPm2(['delete', name], flags);
    if (removed.status !== 0) {
      throw new Error(removed.output || `pm2 delete ${name} failed`);
    }
  }
  const result = runPm2(['start', 'ecosystem.config.cjs', '--only', name], flags);
  if (result.status !== 0) {
    throw new Error(result.output || 'pm2 start ecosystem.config.cjs failed');
  }
  return result.output;
}

export async function serviceCmd(
  action: string,
  flags: Record<string, string | boolean>,
  dependencies: ServiceCommandDependencies = {},
  subaction = ''
): Promise<string> {
  const installationKind =
    dependencies.installationKind ??
    (process.env.XANGI_INSTALLATION_KIND === 'managed' ? 'managed' : 'checkout');
  if (!action || action === 'help') {
    return SERVICE_USAGE;
  }
  if (action === 'autostart' && subaction !== 'enable' && subaction !== 'disable') {
    throw new Error('Usage: xangi service autostart <enable|disable>');
  }
  if (installationKind === 'managed') {
    const service = dependencies.managedService ?? (await resolveManagedLifecycle()).service;
    if (action === 'start') {
      await service.start();
      return 'Started xangi service';
    }
    if (action === 'stop') {
      await service.stop();
      return 'Stopped xangi service';
    }
    if (action === 'autostart') {
      const enabled = subaction === 'enable';
      await service.autostart(enabled);
      return `${enabled ? 'Enabled' : 'Disabled'} xangi service autostart`;
    }
    if (action === 'restart') {
      await service.restart();
      return 'Restarted xangi service';
    }
    if (action === 'status') {
      const status = await service.status();
      return `${status.running ? 'running' : 'stopped'}${status.detail ? `: ${status.detail}` : ''}`;
    }
    throw new Error(SERVICE_USAGE);
  }

  ensurePm2();
  const name = resolveProcessName(flags);
  let result: { status: number; output: string };

  switch (action) {
    case 'start':
      return replacePm2ProcessFromConfig(flags, name);
    case 'stop':
      result = runPm2(['stop', name], flags);
      break;
    case 'restart':
      return replacePm2ProcessFromConfig(flags, name);
    case 'status':
      result = runPm2(['describe', name], flags);
      break;
    case 'autostart': {
      const enabling = subaction === 'enable';
      const save = enabling ? runPm2(['save'], flags) : undefined;
      const startup = runPm2([enabling ? 'startup' : 'unstartup'], flags);
      const output = [
        ...(save ? ['$ pm2 save', save.output || '(no output)', ''] : []),
        `$ pm2 ${enabling ? 'startup' : 'unstartup'}`,
        startup.output || '(no output)',
        '',
        `If pm2 printed a sudo command above, run it once to ${enabling ? 'register' : 'remove'} the OS startup service.`,
      ].join('\n');
      const guidance = enabling
        ? isPm2StartupGuidance(startup.output)
        : isPm2UnstartupGuidance(startup.output);
      if ((save?.status ?? 0) !== 0 || (startup.status !== 0 && !guidance)) {
        throw new Error(output);
      }
      return output;
    }
    default:
      throw new Error(SERVICE_USAGE);
  }

  if (result.status !== 0) {
    throw new Error(result.output || `pm2 ${action} ${name} failed`);
  }
  return result.output;
}
