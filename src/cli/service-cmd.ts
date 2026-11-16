import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { arch, homedir, platform } from 'os';
import { resolveAppLayout } from '../installer/layout.js';
import type { ServiceAdapter } from '../installer/platform/service.js';
import { SETUP_CONFIG_PATH_ENV, SETUP_STATE_DIR_ENV } from '../installer/runtime-config.js';
import { parseSetupConfig } from '../setup/schema.js';
import { resolveManagedLifecycle } from './update-cmd.js';
import { assertRuntimeStateCanStart } from '../runtime-state-validation.js';
import { readEnvFile } from '../env-file.js';

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
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// Only host facilities cross a checkout boundary. Runtime settings (including
// future settings and credentials) must come from the target checkout's .env.
const HOST_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PM2_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];

export function checkoutHostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    HOST_ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [
      key,
      process.env[key],
    ])
  );
}

function resolveProcessName(flags: Record<string, string | boolean>): string {
  const dir = projectDir(flags);
  const env = readEnvFile(join(dir, '.env'));
  return (
    stringFlag(flags, 'name') ||
    env.XANGI_PROCESS_NAME ||
    env.XANGI_INSTANCE_ID ||
    basename(resolve(dir))
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

export function checkoutRuntimeEnv(flags: Record<string, string | boolean>): NodeJS.ProcessEnv {
  const dir = projectDir(flags);
  const targetEnv = readEnvFile(join(dir, '.env'));
  const configChoice = targetEnv[SETUP_CONFIG_PATH_ENV];
  const stateChoice = targetEnv[SETUP_STATE_DIR_ENV];
  const localEnv: NodeJS.ProcessEnv = {
    ...checkoutHostEnv(),
    ...targetEnv,
    XANGI_PROCESS_NAME: resolveProcessName(flags),
    XANGI_INSTALLATION_KIND: 'checkout',
    XANGI_ENV_PATH: '',
    [SETUP_CONFIG_PATH_ENV]: '',
    [SETUP_STATE_DIR_ENV]: '',
  };
  if (configChoice !== undefined || stateChoice !== undefined) {
    // The target checkout owns this pair, including an explicit empty opt-out.
    // Do not combine one target value with a setup inherited from another bot.
    localEnv[SETUP_CONFIG_PATH_ENV] = configChoice ?? '';
    localEnv[SETUP_STATE_DIR_ENV] = stateChoice ?? '';
    if (Boolean(configChoice) !== Boolean(stateChoice)) {
      throw new Error(
        'XANGI_SETUP_CONFIG_PATH and XANGI_SETUP_STATE_DIR must be provided together'
      );
    }
    return localEnv;
  }
  const currentPlatform = platform();
  if (currentPlatform !== 'darwin' && currentPlatform !== 'linux') return localEnv;
  const layout = resolveAppLayout({
    platform: currentPlatform,
    arch: arch(),
    homeDir: homedir(),
    xdgDataHome: process.env.XDG_DATA_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgStateHome: process.env.XDG_STATE_HOME,
  });
  if (!existsSync(layout.configFile)) return localEnv;
  const isCheckout = existsSync(join(dir, '.git'));
  const explicitStateDir = targetEnv.DATA_DIR;
  const setup = parseSetupConfig(JSON.parse(readFileSync(layout.configFile, 'utf8')) as unknown);
  const ownWorkspace = targetEnv.WORKSPACE_PATH;
  if (isCheckout && ownWorkspace && resolve(dir, ownWorkspace) !== resolve(setup.workspacePath)) {
    // A shared setup for a different workspace must never select this bot's runtime.
    return localEnv;
  }
  const stateDir =
    explicitStateDir || (isCheckout ? join(setup.workspacePath, '.xangi') : layout.stateDir);
  const env: NodeJS.ProcessEnv = {
    ...localEnv,
    [SETUP_CONFIG_PATH_ENV]: layout.configFile,
    [SETUP_STATE_DIR_ENV]: stateDir,
  };
  return env;
}

function validateBeforeRestart(flags: Record<string, string | boolean>, managed = false): void {
  // Managed service configuration belongs to its current installation; checkout
  // validation must see exactly the environment that will be sent to PM2.
  const env = managed ? process.env : checkoutRuntimeEnv(flags);
  assertRuntimeStateCanStart({ env, cwd: projectDir(flags) });
}

function ensurePm2(): void {
  const proc = spawnSync('pm2', ['--version'], { encoding: 'utf8', env: checkoutHostEnv() });
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
    (stringFlag(flags, 'dir')
      ? 'checkout'
      : process.env.XANGI_INSTALLATION_KIND === 'managed'
        ? 'managed'
        : 'checkout');
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
      validateBeforeRestart(flags, true);
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
      validateBeforeRestart(flags);
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
