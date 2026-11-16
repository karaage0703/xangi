import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { resolveManagedLifecycle } from './update-cmd.js';
import { checkoutRuntimeEnv, serviceCmd } from './service-cmd.js';
import {
  cliInvocation,
  restartMacWorkerNow,
  workerInstallLayout,
  workerProcessIsRunning,
} from '../remote-worker/install.js';
import { manageLinuxWorker, workerUnitPath } from '../remote-worker/systemd.js';
import type { ServiceAdapter } from '../installer/platform/service.js';

export const RESTART_HELP = `Usage: xangi restart [--wait]
       xangi restart status <job-id> [--managed] [--wait]

Restart the running local app and installed worker, preserving stopped components.
Managed installs use app/current; checkouts control only their own PM2 app.
Uses launchd, systemd, or a separate PM2 helper for Linux PM2-only checkouts.
Stopped/missing targets need no supervisor job. No implicit supervisor fallback.
Acceptance is not completion: use the printed status command (exit 0 complete, 1 failed, 2 pending).
--wait: external terminal only; wait up to 5 minutes for completion and its exit code.
App/worker child callers must use the default receipt; they can be stopped by restart.
Worker/Gateway connection status remains a separate check.
Existing xangi service restart and xangi worker restart remain available.`;

export interface RestartPlan {
  kind: 'managed' | 'checkout';
  root: string;
  service: boolean;
  worker: boolean;
}

function command(
  name: string,
  args: string[],
  env = process.env
): { status: number; output: string } {
  const result = spawnSync(name, args, { encoding: 'utf8', env, timeout: 30_000 });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

export async function planRestart(service?: ServiceAdapter): Promise<RestartPlan> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const kind = process.env.XANGI_INSTALLATION_KIND === 'managed' ? 'managed' : 'checkout';
  let running: boolean;
  if (kind === 'managed') {
    running = (await (service ?? (await resolveManagedLifecycle()).service).status()).running;
  } else {
    running = checkoutAppRunning(root);
  }
  const layout = workerInstallLayout();
  let worker = false;
  if (existsSync(layout.configPath)) {
    if (platform() === 'darwin' && existsSync(layout.plistPath)) {
      const result = command('launchctl', ['print', `gui/${process.getuid?.()}/${layout.label}`]);
      worker = result.status === 0 && workerProcessIsRunning(result.output);
    } else if (platform() === 'linux' && existsSync(workerUnitPath())) {
      const result = command('systemctl', [
        '--user',
        'show',
        'xangi-worker.service',
        '--property=LoadState,ActiveState,SubState,MainPID',
      ]);
      if (result.status !== 0) throw new Error(result.output || 'Cannot inspect local worker');
      worker =
        /^ActiveState=active$/m.test(result.output) &&
        /^SubState=running$/m.test(result.output) &&
        /^MainPID=[1-9]\d*$/m.test(result.output);
    }
  }
  return { kind, root, service: running, worker };
}

function checkoutAppRunning(root: string): boolean {
  const env = checkoutRuntimeEnv({ dir: root });
  let result: { status: number; output: string };
  try {
    result = command('pm2', ['jlist'], env);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    result = { status: 0, output: '[]' };
  }
  if (result.status !== 0) throw new Error(result.output || 'Cannot inspect local PM2 apps');
  const apps = JSON.parse(result.output) as {
    name: string;
    pm2_env?: { status?: string; pm_cwd?: string };
  }[];
  const app = apps.find((item) => item.name === env.XANGI_PROCESS_NAME);
  if (app && (!app.pm2_env?.pm_cwd || resolve(app.pm2_env.pm_cwd) !== root)) {
    throw new Error(
      `PM2 app ${app.name} belongs to another checkout: ${app.pm2_env?.pm_cwd ?? '(unknown cwd)'}`
    );
  }
  return app?.pm2_env?.status === 'online';
}

export interface RestartActions {
  worker(): Promise<string>;
  service(): Promise<string>;
}

/** Restart running local components in a stable order. */
export async function restartComponents(
  plan: RestartPlan,
  actions: RestartActions
): Promise<string> {
  const lines: string[] = [];
  // The supervisor must outlive both targets. Worker failures prevent the app restart.
  lines.push(
    plan.worker ? await actions.worker() : 'Skipped worker (not installed or not running)'
  );
  lines.push(plan.service ? await actions.service() : 'Skipped app (not installed or not running)');
  return lines.join('\n');
}

export function currentManagedInvocation(current: string): { command: string; args: string[] } {
  return {
    command: join(current, 'runtime', 'bin', 'node'),
    args: [join(current, 'dist', 'cli', 'xangi-main.js')],
  };
}

export async function restartLocal(plan: RestartPlan): Promise<string> {
  const current =
    plan.kind === 'managed' ? (await resolveManagedLifecycle()).layout.currentLink : undefined;
  const invocation = current ? currentManagedInvocation(current) : cliInvocation(false);
  return restartComponents(plan, {
    async worker() {
      const message =
        platform() === 'darwin'
          ? restartMacWorkerNow(invocation)
          : manageLinuxWorker('restart', invocation);
      await waitForWorker();
      return `${message}; worker process running; Gateway reconnection not verified`;
    },
    async service() {
      if (!current) {
        await serviceCmd('restart', { dir: plan.root });
      } else {
        // Run state validation and service control with the newly selected release.
        const result = command(invocation.command, [...invocation.args, 'service', 'restart'], {
          ...process.env,
          XANGI_INSTALLATION_KIND: 'managed',
        });
        if (result.status !== 0) throw new Error(result.output || 'App restart failed');
      }
      const service = current ? (await resolveManagedLifecycle()).service : undefined;
      const deadline = Date.now() + 15_000;
      while (!(service ? (await service.status()).running : checkoutAppRunning(plan.root))) {
        if (Date.now() >= deadline)
          throw new Error('App process did not reach running state within 15s');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return 'App process running (application health is separate)';
    },
  });
}

async function waitForWorker(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (true) {
    const result =
      platform() === 'darwin'
        ? command('launchctl', [
            'print',
            `gui/${process.getuid?.()}/${workerInstallLayout().label}`,
          ])
        : command('systemctl', [
            '--user',
            'show',
            'xangi-worker.service',
            '--property=ActiveState,SubState,MainPID',
          ]);
    const running =
      platform() === 'darwin'
        ? workerProcessIsRunning(result.output)
        : /^ActiveState=active$/m.test(result.output) &&
          /^SubState=running$/m.test(result.output) &&
          /^MainPID=[1-9]\d*$/m.test(result.output);
    if (result.status === 0 && running) return;
    if (Date.now() >= deadline)
      throw new Error('Worker process did not reach running state within 15s; inspect worker logs');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
