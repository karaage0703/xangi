import { spawnSync } from 'node:child_process';
import { access, constants, readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { arch, homedir, platform, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppLayout } from '../installer/layout.js';
import { parseSetupConfig, type SetupConfig } from '../setup/schema.js';
import { BACKEND_COMMAND, verifyBackendExecutable } from '../setup/backend-executable.js';
import { managedServicePath } from '../installer/service-environment.js';
import { serviceCmd } from './service-cmd.js';
import { listExtensions, runExtensionAction } from '../extensions.js';
import { runToolCommand } from './tool-command.js';

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
  extensionChecks?: () => Promise<DoctorCheck[]>;
}

async function checkExtensions(workspace?: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const extension of await listExtensions()) {
    if (!extension.enabled) continue;
    try {
      const result = process.env.XANGI_TOOL_SERVER
        ? (JSON.parse(
            (
              await runToolCommand([
                'extension_runtime',
                '--action',
                'doctor',
                '--id',
                extension.id,
              ])
            ).split('\t', 2)[1]
          ) as Awaited<ReturnType<typeof runExtensionAction>>)
        : await runExtensionAction(extension, 'doctor', { workspace });
      checks.push({
        name: `extension:${extension.id}`,
        level: result.ok === false || result.healthy === false ? 'error' : 'ok',
        detail: result.detail || (result.healthy === false ? 'unhealthy' : 'healthy'),
      });
    } catch (error) {
      checks.push({
        name: `extension:${extension.id}`,
        level: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return checks;
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

async function checkBackend(
  config: SetupConfig,
  pathEnv: string,
  managedPath?: string
): Promise<DoctorCheck> {
  const command = BACKEND_COMMAND[config.backend];
  if (config.backendExecutable) {
    try {
      const executable = await verifyBackendExecutable(config.backend, config.backendExecutable);
      const result = spawnSync(executable, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        env: { ...process.env, PATH: managedPath ?? pathEnv },
      });
      if (result.status === 0) {
        return { name: 'backend', level: 'ok', detail: `${executable} is service-ready` };
      }
      return {
        name: 'backend',
        level: 'error',
        detail: `${executable} failed in the OS service environment; run xangi setup again`,
      };
    } catch {
      return {
        name: 'backend',
        level: 'error',
        detail: `saved executable ${config.backendExecutable} is unavailable or unsafe; run xangi setup again`,
      };
    }
  }
  if (managedPath !== undefined) {
    return {
      name: 'backend',
      level: 'error',
      detail: `${command} executable is not recorded for the OS service; run xangi setup again`,
    };
  }
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
  const env = await readCheckoutEnv(dir);
  if (env.WEB_CHAT_PORT) port = env.WEB_CHAT_PORT;
  return `http://127.0.0.1:${port}/health`;
}

async function readCheckoutEnv(dir: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  let content: string;
  try {
    content = await readFile(join(dir, '.env'), 'utf8');
  } catch {
    return env;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

async function checkoutRuntimeWorkspace(dir: string, configuredWorkspace: string): Promise<string> {
  const env = await readCheckoutEnv(dir);
  const setupConfigIsExplicitlyDisabled =
    Object.hasOwn(env, 'XANGI_SETUP_CONFIG_PATH') &&
    Object.hasOwn(env, 'XANGI_SETUP_STATE_DIR') &&
    !env.XANGI_SETUP_CONFIG_PATH &&
    !env.XANGI_SETUP_STATE_DIR;
  if (!setupConfigIsExplicitlyDisabled) return configuredWorkspace;
  return env.WORKSPACE_PATH || dir;
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

  const checkoutDir =
    options.checkoutDir === false ? undefined : (options.checkoutDir ?? sourceCheckoutDir());

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
    checks.push(
      await checkBackend(
        configResult.config,
        options.pathEnv ?? process.env.PATH ?? '',
        checkoutDir
          ? undefined
          : managedServicePath(layout, homeDir, configResult.config.backendExecutable)
      )
    );
    checks.push(checkWebChatBind(configResult.config));
  }

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
    const expectedWorkspace = checkoutDir
      ? await checkoutRuntimeWorkspace(checkoutDir, configResult.config.workspacePath)
      : configResult.config.workspacePath;
    checks.push(
      await checkRuntimeWorkspace(
        options.runtimeInfoUrl ?? new URL('/api/sessions', healthUrl).href,
        expectedWorkspace,
        options.fetchImpl ?? fetch
      )
    );
  }
  checks.push(
    ...(await (
      options.extensionChecks ?? (() => checkExtensions(configResult.config?.workspacePath))
    )())
  );
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
