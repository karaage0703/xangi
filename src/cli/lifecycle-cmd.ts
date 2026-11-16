import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { cliInvocation } from '../remote-worker/install.js';
import { checkoutHostEnv } from './service-cmd.js';
import { planRestart, restartLocal } from './restart-cmd.js';
import { resolveManagedLifecycle, type InstallerFlags } from './update-cmd.js';

interface LifecycleRequest {
  operation: 'restart';
  env: NodeJS.ProcessEnv;
  requesterPid: number;
  wait?: boolean;
  supervisor?: 'launchd' | 'systemd' | 'pm2';
  label: string;
  resultPath: string;
  logPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeResult(
  request: LifecycleRequest,
  state: string,
  detail: string,
  exitCode?: number
): void {
  const temporary = request.resultPath + '.tmp';
  writeFileSync(
    temporary,
    `${JSON.stringify({ operation: request.operation, state, detail, exitCode, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  renameSync(temporary, request.resultPath);
  appendFileSync(request.logPath, `${new Date().toISOString()} ${state}: ${detail}\n`, {
    mode: 0o600,
  });
}

export function lifecycleSubmission(
  host: string,
  label: string,
  logPath: string,
  command: string,
  args: string[],
  supervisor?: 'launchd' | 'systemd' | 'pm2'
): { command: string; args: string[] } {
  if (host === 'darwin')
    return {
      command: 'launchctl',
      args: ['submit', '-l', label, '-o', logPath, '-e', logPath, '--', command, ...args],
    };
  if (host === 'linux' && supervisor === 'pm2')
    return {
      command: 'pm2',
      args: [
        'start',
        command,
        '--interpreter',
        'none',
        '--name',
        label,
        '--no-autorestart',
        '--force',
        '--output',
        logPath,
        '--error',
        logPath,
        '--merge-logs',
        '--',
        ...args,
      ],
    };
  if (host === 'linux')
    return {
      command: 'systemd-run',
      args: [
        '--user',
        `--unit=${label}`,
        '--collect',
        '--property=Type=exec',
        `--property=StandardOutput=append:${logPath}`,
        `--property=StandardError=append:${logPath}`,
        '--',
        command,
        ...args,
      ],
    };
  throw new Error(`xangi restart requires macOS launchd or Linux/WSL2 systemd (detected ${host})`);
}

/** Submit to the selected supervisor; waiting never owns the helper lifetime. */
export async function queueLifecycle(operation: 'restart', flags: InstallerFlags): Promise<string> {
  const wait = flags.wait === true;
  if (flags.wait !== undefined && !wait) throw new Error('--wait takes no value');
  flags = { ...flags };
  delete flags.wait;
  if (operation !== 'restart' || Object.keys(flags).length)
    throw new Error('Usage: xangi restart [--wait]');
  const { layout } = await resolveManagedLifecycle();
  const env = checkoutHostEnv();
  for (const key of [
    'XANGI_INSTALLATION_KIND',
    'XANGI_WORKER_HOME',
    'XANGI_WORKER_LAUNCH_AGENTS_DIR',
    'XANGI_RELEASE_MANIFEST_URL',
    'XANGI_RELEASE_PUBLIC_KEY_PATH',
    'WEB_CHAT_PORT',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Inspect checkout targets before choosing their existing supervisor. Never probe
  // systemd merely to hand off a PM2-only installation, and never silently retry.
  const plan = await planRestart();
  if (!plan.service && !plan.worker)
    return 'Restart completed: skipped app and worker (not installed or not running). No supervisor job needed.';
  const supervisor =
    platform() === 'darwin'
      ? 'launchd'
      : plan.kind === 'checkout' && !plan.worker
        ? 'pm2'
        : 'systemd';
  const reason =
    supervisor === 'pm2'
      ? 'checkout has only a running PM2 app'
      : supervisor === 'systemd'
        ? 'managed operation or running systemd worker'
        : 'macOS lifecycle';
  const root =
    env.XANGI_INSTALLATION_KIND === 'managed'
      ? layout.stateDir
      : join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), '.xangi');
  const dir = join(root, 'lifecycle', randomUUID());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const requestPath = join(dir, 'request.json');
  const request: LifecycleRequest = {
    operation,
    env,
    requesterPid: process.pid,
    wait,
    supervisor,
    label: `dev.xangi.lifecycle.${randomUUID()}`,
    resultPath: join(dir, 'result.json'),
    logPath: join(dir, 'output.log'),
  };
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  writeFileSync(request.logPath, '', { mode: 0o600 });
  writeResult(request, 'accepted', `Awaiting independent ${supervisor} job (${reason})`);
  const invocation = cliInvocation(false);
  const submission = lifecycleSubmission(
    platform(),
    request.label,
    request.logPath,
    invocation.command,
    [...invocation.args, 'lifecycle-run', '--request', requestPath],
    supervisor
  );
  const result = spawnSync(submission.command, submission.args, {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message || result.stderr || result.stdout || 'OS job submission failed';
    writeResult(request, 'failed', detail, 1);
    throw new Error(
      `Supervisor: ${supervisor} (${reason})\n${detail.trim()}\nResult: ${request.resultPath}`
    );
  }
  const id = dir.slice(dir.lastIndexOf('/') + 1);
  const status = `xangi restart status ${id}${env.XANGI_INSTALLATION_KIND === 'managed' ? ' --managed' : ''}`;
  const receipt = `Restart accepted (not completed).\nSupervisor: ${supervisor} (${reason})\nStatus (same installation/checkout): ${status}\nResult: ${request.resultPath}\nLog: ${request.logPath}\nCheck worker status and Gateway reconnection separately.`;
  if (!wait) return receipt;
  console.log(receipt);
  return lifecycleStatus(id, { managed: env.XANGI_INSTALLATION_KIND === 'managed', wait: true });
}

export interface LifecycleDependencies {
  plan?: typeof planRestart;
  restart?: typeof restartLocal;
}

export async function runLifecycle(
  requestPath: string,
  dependencies: LifecycleDependencies = {}
): Promise<string> {
  const request = JSON.parse(readFileSync(requestPath, 'utf8')) as LifecycleRequest;
  // Reconstruct host/target selection rather than the caller's bot runtime.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, request.env);
  writeResult(request, 'running', 'Independent lifecycle job started');
  let exitCode = 0;
  let unlock: (() => Promise<void>) | undefined;
  try {
    if (request.operation !== 'restart')
      throw new Error('Unsupported lifecycle operation; run xangi update directly.');
    // Serialize restart jobs for this installation.
    unlock = await lockfile.lock(dirname(dirname(request.resultPath)), {
      stale: 60_000,
      update: 10_000,
      retries: 0,
    });
    // Give the invoking CLI time to return its receipt before touching its parent.
    const deadline = Date.now() + 5_000;
    while (!request.wait && Date.now() < deadline) {
      try {
        process.kill(request.requesterPid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const plan = await (dependencies.plan ?? planRestart)();
    if (request.supervisor === 'pm2' && plan.worker)
      throw new Error(
        'Worker became active after PM2-only submission; retry to select systemd explicitly'
      );
    const detail = await (dependencies.restart ?? restartLocal)(plan);
    if (unlock) {
      const release = unlock;
      unlock = undefined;
      await release();
    }
    writeResult(request, 'completed', `${detail}\nGateway reconnection not verified`, 0);
    return detail;
  } catch (error) {
    exitCode = 1;
    writeResult(request, 'failed', errorMessage(error), 1);
    throw error;
  } finally {
    if (unlock) await unlock();
    process.exitCode = exitCode;
    if (request.supervisor === 'pm2') {
      // Result/log and lease release precede self-removal, which can terminate us.
      const cleanup = spawnSync('pm2', ['delete', request.label], {
        encoding: 'utf8',
        env: checkoutHostEnv(),
        timeout: 10_000,
      });
      if (cleanup.error || cleanup.status !== 0)
        appendFileSync(
          request.logPath,
          `PM2 helper cleanup failed (${request.label}): ${cleanup.error?.message || cleanup.stderr || cleanup.stdout}\n`
        );
    } else if (platform() === 'darwin') {
      // The receipt is durable before removing this one-shot launchd job.
      spawnSync('launchctl', ['remove', request.label], { encoding: 'utf8', timeout: 10_000 });
    }
  }
}

/** Read-only status; pending/timeout is exit 2, never a completed operation. */
export async function lifecycleStatus(id: string, flags: InstallerFlags = {}): Promise<string> {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) ||
    Object.keys(flags).some((key) => !['managed', 'wait'].includes(key)) ||
    Object.values(flags).some((value) => typeof value !== 'boolean')
  )
    throw new Error('Usage: xangi restart status <job-id> [--managed] [--wait]');
  const managed = flags.managed || process.env.XANGI_INSTALLATION_KIND === 'managed';
  const root = managed
    ? (await resolveManagedLifecycle()).layout.stateDir
    : join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), '.xangi');
  const resultPath = join(root, 'lifecycle', id, 'result.json');
  const deadline = Date.now() + 300_000;
  while (true) {
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      operation: string;
      state: string;
      detail: string;
      exitCode?: number;
    };
    const final = result.state === 'completed' || result.state === 'failed';
    if (final || !flags.wait || Date.now() >= deadline) {
      process.exitCode = final ? (result.state === 'completed' ? 0 : 1) : 2;
      return (
        `${result.operation}: ${result.state}\n${result.detail}\nLog: ${join(root, 'lifecycle', id, 'output.log')}` +
        (!final && flags.wait
          ? '\nWait timed out after 5 minutes; helper was not cancelled. Recheck status.'
          : '')
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
