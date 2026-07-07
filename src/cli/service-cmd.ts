import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

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
  });
  return {
    status: proc.status ?? 1,
    output: `${proc.stdout || ''}${proc.stderr || ''}`.trim(),
  };
}

function ensurePm2(): void {
  const proc = spawnSync('pm2', ['--version'], { encoding: 'utf8' });
  if (proc.error && 'code' in proc.error && proc.error.code === 'ENOENT') {
    throw new Error('pm2 が見つかりません。PM2運用では npm install -g pm2 を先に実行してください');
  }
}

function pm2ProcessExists(name: string, flags: Record<string, string | boolean>): boolean {
  return runPm2(['describe', name], flags).status === 0;
}

function startFromPm2Config(flags: Record<string, string | boolean>): string {
  const pm2ConfigPath = join(projectDir(flags), 'ecosystem.config.cjs');
  if (!existsSync(pm2ConfigPath)) {
    throw new Error(`ecosystem.config.cjs が見つかりません: ${pm2ConfigPath}`);
  }
  const result = runPm2(['start', 'ecosystem.config.cjs'], flags);
  if (result.status !== 0) {
    throw new Error(result.output || 'pm2 start ecosystem.config.cjs failed');
  }
  return result.output;
}

export async function serviceCmd(
  action: string,
  flags: Record<string, string | boolean>
): Promise<string> {
  if (!action || action === 'help') {
    return [
      'Usage: xangi service <start|stop|restart|status> [--name <process-name>] [--dir <xangi-dir>]',
      'Tip: run ./bin/xangi from the target clone, or use named symlinks such as xangi-dev / xangi-prod.',
      '--dir is an escape hatch for controlling another clone from a PATH-level xangi.',
    ].join('\n');
  }

  ensurePm2();
  const name = resolveProcessName(flags);
  let result: { status: number; output: string };

  switch (action) {
    case 'start':
      if (pm2ProcessExists(name, flags)) {
        result = runPm2(['start', name], flags);
      } else {
        return startFromPm2Config(flags);
      }
      break;
    case 'stop':
      result = runPm2(['stop', name], flags);
      break;
    case 'restart':
      if (pm2ProcessExists(name, flags)) {
        result = runPm2(['restart', name], flags);
      } else {
        return startFromPm2Config(flags);
      }
      break;
    case 'status':
      result = runPm2(['describe', name], flags);
      break;
    default:
      throw new Error(
        [
          'Usage: xangi service <start|stop|restart|status> [--name <process-name>] [--dir <xangi-dir>]',
          'Tip: run ./bin/xangi from the target clone, or use named symlinks such as xangi-dev / xangi-prod.',
        ].join('\n')
      );
  }

  if (result.status !== 0) {
    throw new Error(result.output || `pm2 ${action} ${name} failed`);
  }
  return result.output;
}
