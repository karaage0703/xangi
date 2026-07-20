import { spawnSync } from 'node:child_process';
import { access, constants, readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { arch, homedir, platform, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppLayout } from '../installer/layout.js';
import { parseSetupConfig, type SetupConfig } from '../setup/schema.js';
import { serviceCmd } from './service-cmd.js';

export type DoctorLevel = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  name: string;
  level: DoctorLevel;
  detail: string;
}

export interface DoctorOptions {
  homeDir?: string;
  platform?: string;
  arch?: string;
  xdgDataHome?: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
  configPath?: string;
  healthUrl?: string;
  fetchImpl?: typeof fetch;
  pathEnv?: string;
  serviceCheck?: () => Promise<DoctorCheck>;
  checkoutDir?: string | false;
  runtimeInfoUrl?: string;
  tailscaleServeCheck?: (port: number) => Promise<DoctorCheck>;
}

async function checkConfig(
  configPath: string
): Promise<{ check: DoctorCheck; config?: SetupConfig }> {
  try {
    const info = await stat(configPath);
    if ((info.mode & 0o077) !== 0) {
      return {
        check: { name: 'config', level: 'error', detail: 'permissions must be 0600' },
      };
    }
    const config = parseSetupConfig(JSON.parse(await readFile(configPath, 'utf8')) as unknown);
    return {
      check: { name: 'config', level: 'ok', detail: 'present, valid, and private' },
      config,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      check: {
        name: 'config',
        level: code === 'ENOENT' ? 'warn' : 'error',
        detail: code === 'ENOENT' ? 'not configured; run xangi setup' : 'invalid or unreadable',
      },
    };
  }
}

const BACKEND_COMMAND: Record<SetupConfig['backend'], string> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  grok: 'grok',
  antigravity: 'agy',
  'local-llm': 'ollama',
};

async function checkBackend(config: SetupConfig, pathEnv: string): Promise<DoctorCheck> {
  const command = BACKEND_COMMAND[config.backend];
  for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, command), constants.X_OK);
      return { name: 'backend', level: 'ok', detail: `${command} is available` };
    } catch {
      // Try the next PATH entry.
    }
  }
  return {
    name: 'backend',
    level: 'error',
    detail: `${command} is not on PATH; install or authenticate the selected backend CLI`,
  };
}

function checkWebChatBind(config: SetupConfig): DoctorCheck {
  if (!config.webChatEnabled) {
    return { name: 'web-chat-bind', level: 'ok', detail: 'Web Chat is disabled' };
  }
  if (config.webChatAccess === 'local') {
    return { name: 'web-chat-bind', level: 'ok', detail: 'loopback only' };
  }
  if (config.webChatAccess === 'lan') {
    return {
      name: 'web-chat-bind',
      level: 'warn',
      detail: 'all interfaces; Web Chat has no application-level authentication',
    };
  }
  return {
    name: 'web-chat-bind',
    level: 'ok',
    detail: 'loopback with tailnet-only Tailscale Serve forwarding',
  };
}

async function checkTailscaleServe(port: number): Promise<DoctorCheck> {
  const result = spawnSync('tailscale', ['serve', 'status', '--json'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      name: 'tailscale-serve',
      level: 'error',
      detail: 'Tailscale Serve is unavailable; run xangi setup again or configure Serve',
    };
  }
  try {
    const status = JSON.parse(String(result.stdout ?? '{}')) as {
      TCP?: Record<string, { TCPForward?: string }>;
    };
    const target = status.TCP?.[String(port)]?.TCPForward;
    return target === `127.0.0.1:${port}`
      ? {
          name: 'tailscale-serve',
          level: 'ok',
          detail: `TCP ${port} forwards to loopback Web Chat`,
        }
      : {
          name: 'tailscale-serve',
          level: 'error',
          detail: `TCP ${port} does not forward to 127.0.0.1:${port}`,
        };
  } catch {
    return {
      name: 'tailscale-serve',
      level: 'error',
      detail: 'Tailscale Serve status is not valid JSON',
    };
  }
}

async function checkLaunchAgent(): Promise<DoctorCheck> {
  const uid = process.getuid?.() ?? userInfo().uid;
  const result = spawnSync('launchctl', ['print', `gui/${uid}/dev.xangi.app`], {
    encoding: 'utf8',
  });
  return result.status === 0
    ? { name: 'service', level: 'ok', detail: 'LaunchAgent is running' }
    : { name: 'service', level: 'warn', detail: 'LaunchAgent is not installed or not running' };
}

async function checkSystemdUser(): Promise<DoctorCheck> {
  const result = spawnSync('systemctl', ['--user', 'is-active', 'xangi.service'], {
    encoding: 'utf8',
  });
  return result.status === 0 && String(result.stdout ?? '').trim() === 'active'
    ? { name: 'service', level: 'ok', detail: 'systemd user service is running' }
    : {
        name: 'service',
        level: 'warn',
        detail: 'systemd user service is not installed, not running, or unavailable',
      };
}

async function checkHealth(url: string, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
    return response.ok
      ? { name: 'health', level: 'ok', detail: `HTTP ${response.status}` }
      : { name: 'health', level: 'error', detail: `HTTP ${response.status}` };
  } catch {
    return { name: 'health', level: 'warn', detail: 'service is not reachable' };
  }
}

async function checkRuntimeWorkspace(
  url: string,
  expectedWorkspace: string,
  fetchImpl: typeof fetch
): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      return { name: 'runtime-workspace', level: 'error', detail: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as { meta?: { workdir?: unknown } };
    if (typeof body.meta?.workdir !== 'string') {
      return {
        name: 'runtime-workspace',
        level: 'error',
        detail: 'running service did not report its workspace',
      };
    }
    const [expected, actual] = await Promise.all([
      realpath(expectedWorkspace),
      realpath(body.meta.workdir),
    ]);
    return expected === actual
      ? { name: 'runtime-workspace', level: 'ok', detail: 'matches configured workspace' }
      : {
          name: 'runtime-workspace',
          level: 'error',
          detail: 'running service uses a different workspace',
        };
  } catch {
    return {
      name: 'runtime-workspace',
      level: 'error',
      detail: 'could not verify the running service workspace',
    };
  }
}

function sourceCheckoutDir(): string | undefined {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return existsSync(join(root, '.git')) && existsSync(join(root, 'package.json'))
    ? root
    : undefined;
}

async function checkoutHealthUrl(dir: string): Promise<string> {
  let port = '18888';
  try {
    const content = await readFile(join(dir, '.env'), 'utf8');
    const match = content.match(/^WEB_CHAT_PORT\s*=\s*["']?([^\s"']+)["']?\s*$/m);
    if (match?.[1]) port = match[1];
  } catch {
    // A missing checkout .env falls back to the Web Chat default.
  }
  return `http://127.0.0.1:${port}/health`;
}

async function checkCheckoutPm2(dir: string): Promise<DoctorCheck> {
  try {
    await serviceCmd('status', { dir });
    return { name: 'service', level: 'ok', detail: 'checkout PM2 service is running' };
  } catch {
    return {
      name: 'service',
      level: 'warn',
      detail: 'checkout PM2 service is not installed or not running',
    };
  }
}

export async function collectDoctorChecks(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const currentPlatform = options.platform ?? platform();
  const currentArch = options.arch ?? arch();
  const homeDir = options.homeDir ?? homedir();
  const checks: DoctorCheck[] = [];

  if (currentPlatform !== 'darwin' && currentPlatform !== 'linux') {
    checks.push({
      name: 'platform',
      level: 'error',
      detail: `${currentPlatform}/${currentArch} is not supported by this preview`,
    });
    return checks;
  }

  const layout = resolveAppLayout({
    platform: currentPlatform,
    arch: currentArch,
    homeDir,
    xdgDataHome: options.xdgDataHome ?? process.env.XDG_DATA_HOME,
    xdgConfigHome: options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME,
    xdgStateHome: options.xdgStateHome ?? process.env.XDG_STATE_HOME,
  });
  checks.push({ name: 'platform', level: 'ok', detail: `${currentPlatform}/${currentArch}` });
  checks.push({
    name: 'node',
    level: Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'error',
    detail: `Node.js ${process.versions.node}`,
  });

  const configResult = await checkConfig(
    options.configPath ?? join(layout.configDir, 'xangi.json')
  );
  checks.push(configResult.check);
  if (configResult.config) {
    try {
      await access(configResult.config.workspacePath, constants.R_OK | constants.W_OK);
      checks.push({ name: 'workspace', level: 'ok', detail: 'readable and writable' });
    } catch {
      checks.push({ name: 'workspace', level: 'error', detail: 'configured path is unavailable' });
    }
    checks.push(await checkBackend(configResult.config, options.pathEnv ?? process.env.PATH ?? ''));
    checks.push(checkWebChatBind(configResult.config));
  }

  const checkoutDir =
    options.checkoutDir === false ? undefined : (options.checkoutDir ?? sourceCheckoutDir());
  const healthUrl =
    options.healthUrl ??
    (checkoutDir ? await checkoutHealthUrl(checkoutDir) : 'http://127.0.0.1:18888/health');
  if (configResult.config?.webChatEnabled && configResult.config.webChatAccess === 'tailscale') {
    const port = Number.parseInt(new URL(healthUrl).port || '80', 10);
    checks.push(await (options.tailscaleServeCheck ?? checkTailscaleServe)(port));
  }
  checks.push(
    await (
      options.serviceCheck ??
      (checkoutDir
        ? () => checkCheckoutPm2(checkoutDir)
        : currentPlatform === 'darwin'
          ? checkLaunchAgent
          : checkSystemdUser)
    )(),
    await checkHealth(healthUrl, options.fetchImpl ?? fetch)
  );
  if (configResult.config?.webChatEnabled) {
    checks.push(
      await checkRuntimeWorkspace(
        options.runtimeInfoUrl ?? new URL('/api/sessions', healthUrl).href,
        configResult.config.workspacePath,
        options.fetchImpl ?? fetch
      )
    );
  }
  return checks;
}

export async function doctorCmd(options: DoctorOptions = {}): Promise<string> {
  const checks = await collectDoctorChecks(options);
  const output = checks
    .map(
      (check) =>
        `${check.level === 'ok' ? 'OK' : check.level === 'warn' ? 'WARN' : 'ERROR'} ${check.name}: ${check.detail}`
    )
    .join('\n');
  if (checks.some((check) => check.level === 'error')) {
    throw new Error(`xangi doctor found errors:\n${output}`);
  }
  return output;
}
