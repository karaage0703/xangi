import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants, existsSync, readFileSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveAppLayout } from './installer/layout.js';

export type ExtensionAction = 'start' | 'stop' | 'restart' | 'status' | 'doctor' | 'update';

export interface ExtensionCapability {
  id: string;
  protocol: 'http';
  healthPath: string;
}

export interface ExtensionRuntime {
  kind: 'managed-http';
}

export interface ExtensionAgentBackend {
  id: string;
  displayName: string;
  capability: string;
  path: string;
}

export interface ExtensionUpdatePreparation {
  command: string;
  args: string[];
}

export interface ExtensionManifest {
  schemaVersion: 2;
  id: string;
  displayName: string;
  description?: string;
  permissions?: string[];
  version: string;
  entrypoint: string;
  runtime: ExtensionRuntime;
  setup?: {
    instructions: string;
  };
  update?: {
    prepare: ExtensionUpdatePreparation;
  };
  ui?: {
    capability: string;
    path: string;
  };
  agentBackend?: ExtensionAgentBackend;
  capabilities: ExtensionCapability[];
}

export interface LinkedExtension {
  id: string;
  manifestPath: string;
  enabled: boolean;
  autostart: boolean;
}

interface ExtensionStore {
  schemaVersion: 1;
  extensions: LinkedExtension[];
}

export interface ExtensionActionResult {
  schemaVersion?: number;
  id?: string;
  ok?: boolean;
  running?: boolean;
  healthy?: boolean;
  changed?: boolean;
  unsupported?: boolean;
  detail?: string;
  [key: string]: unknown;
}

const EMPTY_STORE: ExtensionStore = { schemaVersion: 1, extensions: [] };
const EXTENSION_ID = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

interface ManagedExtensionRuntime {
  id: string;
  workspace: string;
  baseUrl: string;
  healthPath: string;
  authorization: string;
  child: ReturnType<typeof spawn>;
}

interface ManagedReadyMessage {
  schemaVersion: 2;
  event: 'ready';
  id: string;
  baseUrl: string;
  workspace: string;
}

const managedRuntimes = new Map<string, ManagedExtensionRuntime>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defaultExtensionsFile(): string {
  if (process.env.XANGI_EXTENSIONS_FILE) return process.env.XANGI_EXTENSIONS_FILE;
  const currentPlatform = platform();
  if (currentPlatform !== 'darwin' && currentPlatform !== 'linux') {
    return join(homedir(), '.config', 'xangi', 'extensions.json');
  }
  const layout = resolveAppLayout({
    platform: currentPlatform,
    arch: arch(),
    homeDir: homedir(),
    xdgDataHome: process.env.XDG_DATA_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgStateHome: process.env.XDG_STATE_HOME,
  });
  return join(layout.configDir, 'extensions.json');
}

export function parseExtensionManifest(value: unknown): ExtensionManifest {
  if (!isRecord(value)) throw new Error('extension manifest must be an object');
  const {
    schemaVersion,
    id,
    displayName,
    description,
    permissions,
    version,
    entrypoint,
    runtime,
    setup,
    update,
    ui,
    capabilities,
    agentBackend,
  } = value;
  if (
    schemaVersion !== 2 ||
    typeof id !== 'string' ||
    !EXTENSION_ID.test(id) ||
    typeof displayName !== 'string' ||
    !displayName.trim() ||
    typeof version !== 'string' ||
    !VERSION.test(version) ||
    typeof entrypoint !== 'string' ||
    !entrypoint ||
    isAbsolute(entrypoint) ||
    entrypoint.split(/[\\/]/).includes('..') ||
    !isRecord(runtime) ||
    runtime.kind !== 'managed-http' ||
    !Array.isArray(capabilities)
  ) {
    throw new Error('invalid extension manifest');
  }
  if (
    description !== undefined &&
    (typeof description !== 'string' || !description.trim() || description.length > 500)
  ) {
    throw new Error('invalid extension description');
  }
  if (
    permissions !== undefined &&
    (!Array.isArray(permissions) ||
      permissions.length > 16 ||
      !permissions.every(
        (permission) =>
          typeof permission === 'string' && permission.trim() && permission.length <= 200
      ))
  ) {
    throw new Error('invalid extension permissions');
  }
  let parsedSetup: ExtensionManifest['setup'];
  if (setup !== undefined) {
    if (
      !isRecord(setup) ||
      typeof setup.instructions !== 'string' ||
      !setup.instructions.trim() ||
      isAbsolute(setup.instructions) ||
      setup.instructions.split(/[\\/]/).includes('..')
    ) {
      throw new Error('invalid extension setup instructions');
    }
    parsedSetup = { instructions: setup.instructions.trim() };
  }
  let parsedUpdate: ExtensionManifest['update'];
  if (update !== undefined) {
    if (!isRecord(update) || !isRecord(update.prepare)) {
      throw new Error('invalid extension update preparation');
    }
    const { command, args = [] } = update.prepare;
    if (
      typeof command !== 'string' ||
      !command.trim() ||
      command.length > 200 ||
      /\s/.test(command) ||
      command === '.' ||
      command === './' ||
      command.includes('\0') ||
      isAbsolute(command) ||
      command.split(/[\\/]/).includes('..') ||
      !Array.isArray(args) ||
      args.length > 32 ||
      !args.every(
        (argument) =>
          typeof argument === 'string' && argument.length <= 500 && !argument.includes('\0')
      )
    ) {
      throw new Error('invalid extension update preparation');
    }
    parsedUpdate = {
      prepare: {
        command: command.trim(),
        args: [...args],
      },
    };
  }
  const parsedCapabilities = capabilities.map((capability) => {
    if (!isRecord(capability)) throw new Error('invalid extension capability');
    const { id: capabilityId, protocol, healthPath } = capability;
    if (
      typeof capabilityId !== 'string' ||
      !EXTENSION_ID.test(capabilityId) ||
      protocol !== 'http' ||
      typeof healthPath !== 'string' ||
      !healthPath.startsWith('/')
    ) {
      throw new Error('invalid extension capability');
    }
    return {
      id: capabilityId,
      protocol: 'http' as const,
      healthPath,
    };
  });
  if (new Set(parsedCapabilities.map((item) => item.id)).size !== parsedCapabilities.length) {
    throw new Error('extension capabilities must be unique');
  }
  let parsedUi: ExtensionManifest['ui'];
  if (ui !== undefined) {
    if (
      !isRecord(ui) ||
      typeof ui.capability !== 'string' ||
      !parsedCapabilities.some((item) => item.id === ui.capability) ||
      typeof ui.path !== 'string' ||
      !ui.path.startsWith('/') ||
      ui.path.includes('..')
    ) {
      throw new Error('invalid extension UI declaration');
    }
    parsedUi = { capability: ui.capability, path: ui.path };
  }
  let parsedAgentBackend: ExtensionManifest['agentBackend'];
  if (agentBackend !== undefined) {
    if (
      !isRecord(agentBackend) ||
      typeof agentBackend.id !== 'string' ||
      !EXTENSION_ID.test(agentBackend.id) ||
      typeof agentBackend.displayName !== 'string' ||
      !agentBackend.displayName.trim() ||
      typeof agentBackend.capability !== 'string' ||
      !parsedCapabilities.some((item) => item.id === agentBackend.capability) ||
      typeof agentBackend.path !== 'string' ||
      !agentBackend.path.startsWith('/') ||
      agentBackend.path.includes('..')
    ) {
      throw new Error('invalid extension agent backend declaration');
    }
    parsedAgentBackend = {
      id: agentBackend.id,
      displayName: agentBackend.displayName.trim(),
      capability: agentBackend.capability,
      path: agentBackend.path,
    };
  }
  return {
    schemaVersion: 2,
    id,
    displayName: displayName.trim(),
    ...(typeof description === 'string' ? { description: description.trim() } : {}),
    ...(Array.isArray(permissions)
      ? { permissions: permissions.map((permission) => permission.trim()) }
      : {}),
    version,
    entrypoint,
    runtime: { kind: 'managed-http' },
    ...(parsedSetup ? { setup: parsedSetup } : {}),
    ...(parsedUpdate ? { update: parsedUpdate } : {}),
    ...(parsedUi ? { ui: parsedUi } : {}),
    ...(parsedAgentBackend ? { agentBackend: parsedAgentBackend } : {}),
    capabilities: parsedCapabilities,
  };
}

export async function loadExtensionManifest(
  manifestPath: string,
  options: { requireEntrypoint?: boolean } = {}
): Promise<ExtensionManifest> {
  const canonical = await realpath(manifestPath);
  const manifest = parseExtensionManifest(JSON.parse(await readFile(canonical, 'utf8')) as unknown);
  const root = dirname(canonical);
  const executable = resolve(root, manifest.entrypoint);
  if (relative(root, executable).startsWith('..'))
    throw new Error('extension entrypoint escapes root');
  if (options.requireEntrypoint !== false) await access(executable, constants.X_OK);
  return manifest;
}

function parseStore(value: unknown): ExtensionStore {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.extensions)) {
    throw new Error('invalid extensions config');
  }
  const extensions = value.extensions.map((extension) => {
    if (
      !isRecord(extension) ||
      typeof extension.id !== 'string' ||
      !EXTENSION_ID.test(extension.id) ||
      typeof extension.manifestPath !== 'string' ||
      !isAbsolute(extension.manifestPath) ||
      typeof extension.enabled !== 'boolean' ||
      typeof extension.autostart !== 'boolean'
    ) {
      throw new Error('invalid linked extension');
    }
    return extension as unknown as LinkedExtension;
  });
  if (new Set(extensions.map((item) => item.id)).size !== extensions.length) {
    throw new Error('linked extension ids must be unique');
  }
  return { schemaVersion: 1, extensions };
}

export async function readExtensionStore(
  configPath = defaultExtensionsFile()
): Promise<ExtensionStore> {
  try {
    const info = await stat(configPath);
    if ((info.mode & 0o077) !== 0) throw new Error('extensions config permissions must be 0600');
    return parseStore(JSON.parse(await readFile(configPath, 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { ...EMPTY_STORE, extensions: [] };
    throw error;
  }
}

async function writeExtensionStore(store: ExtensionStore, configPath: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, configPath);
}

export async function linkExtension(
  manifestPath: string,
  options: { configPath?: string; autostart?: boolean } = {}
): Promise<LinkedExtension> {
  const canonical = await realpath(manifestPath);
  const manifest = await loadExtensionManifest(canonical);
  const configPath = options.configPath ?? defaultExtensionsFile();
  const store = await readExtensionStore(configPath);
  const linked: LinkedExtension = {
    id: manifest.id,
    manifestPath: canonical,
    enabled: true,
    autostart: options.autostart ?? true,
  };
  store.extensions = [...store.extensions.filter((item) => item.id !== manifest.id), linked];
  await writeExtensionStore(store, configPath);
  return linked;
}

export async function unlinkExtension(
  id: string,
  configPath = defaultExtensionsFile()
): Promise<boolean> {
  const store = await readExtensionStore(configPath);
  const next = store.extensions.filter((item) => item.id !== id);
  if (next.length === store.extensions.length) return false;
  await writeExtensionStore({ schemaVersion: 1, extensions: next }, configPath);
  return true;
}

export async function listExtensions(
  configPath = defaultExtensionsFile()
): Promise<LinkedExtension[]> {
  return (await readExtensionStore(configPath)).extensions;
}

async function linkedManifest(linked: LinkedExtension): Promise<ExtensionManifest> {
  const manifest = await loadExtensionManifest(linked.manifestPath);
  if (manifest.id !== linked.id) throw new Error(`extension id changed for ${linked.manifestPath}`);
  return manifest;
}

export async function runExtensionAction(
  linked: LinkedExtension,
  action: ExtensionAction,
  options: { workspace?: string; timeoutMs?: number } = {}
): Promise<ExtensionActionResult> {
  const manifest = await linkedManifest(linked);
  if (action === 'start') return startManagedExtension(linked, manifest, options);
  if (action === 'stop') return stopManagedExtension(linked.id);
  if (action === 'restart') {
    await stopManagedExtension(linked.id);
    return startManagedExtension(linked, manifest, options);
  }
  if (action === 'status' || action === 'doctor') {
    return managedExtensionStatus(
      linked.id,
      action === 'doctor' ? options.workspace : undefined,
      action === 'doctor'
    );
  }

  const executable = resolve(dirname(linked.manifestPath), manifest.entrypoint);
  const args: string[] = [action];
  if (options.workspace) args.push('--workspace', options.workspace);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`${linked.id} ${action} timed out`));
        return;
      }
      let payload: ExtensionActionResult;
      try {
        payload = JSON.parse(stdout.trim()) as ExtensionActionResult;
      } catch {
        reject(
          new Error(
            `${linked.id} ${action} returned invalid JSON${stderr ? `: ${stderr.trim()}` : ''}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(new Error(payload.detail || `${linked.id} ${action} failed`));
        return;
      }
      resolvePromise(payload);
    });
  });
}

function parseReadyMessage(line: string): ManagedReadyMessage {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value)) throw new Error('readiness message must be an object');
  const { schemaVersion, event, id, baseUrl, workspace } = value;
  if (
    schemaVersion !== 2 ||
    event !== 'ready' ||
    typeof id !== 'string' ||
    typeof baseUrl !== 'string' ||
    typeof workspace !== 'string'
  ) {
    throw new Error('invalid readiness message');
  }
  return { schemaVersion, event, id, baseUrl, workspace };
}

function validateManagedBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('managed extension must bind an ephemeral 127.0.0.1 HTTP endpoint');
  }
  return url.href.replace(/\/$/, '');
}

async function waitForReady(
  linked: LinkedExtension,
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<ManagedReadyMessage> {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, ready?: ManagedReadyMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      if (error) reject(error);
      else resolvePromise(ready!);
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    };
    const onStdout = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 65_536) {
        finish(new Error(`${linked.id} readiness output exceeded 64 KiB`));
        return;
      }
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(undefined, parseReadyMessage(stdout.slice(0, newline).trim()));
      } catch (error) {
        finish(
          new Error(
            `${linked.id} returned invalid readiness JSON: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    };
    const onError = (error: Error) => finish(error);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `${linked.id} exited before readiness (${signal ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim()}` : ''}`
        )
      );
    const timer = setTimeout(
      () => finish(new Error(`${linked.id} readiness timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

async function startManagedExtension(
  linked: LinkedExtension,
  manifest: ExtensionManifest,
  options: { workspace?: string; timeoutMs?: number }
): Promise<ExtensionActionResult> {
  const existing = managedRuntimes.get(linked.id);
  if (existing?.child.exitCode === null && !existing.child.killed) {
    return managedExtensionStatus(linked.id, options.workspace);
  }
  managedRuntimes.delete(linked.id);
  const workspace = resolve(options.workspace ?? process.env.WORKSPACE_PATH ?? process.cwd());
  const executable = resolve(dirname(linked.manifestPath), manifest.entrypoint);
  const token = randomBytes(32).toString('base64url');
  const child = spawn(executable, ['serve', '--workspace', workspace], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, XANGI_EXTENSION_AUTH_TOKEN: token },
  });
  try {
    const ready = await waitForReady(linked, child, options.timeoutMs ?? 30_000);
    child.stdout?.resume();
    child.stderr?.resume();
    if (ready.id !== linked.id) throw new Error(`readiness id mismatch: ${ready.id}`);
    if (resolve(ready.workspace) !== workspace) {
      throw new Error(`readiness workspace mismatch: ${ready.workspace}`);
    }
    const runtime: ManagedExtensionRuntime = {
      id: linked.id,
      workspace,
      baseUrl: validateManagedBaseUrl(ready.baseUrl),
      healthPath: manifest.capabilities[0]?.healthPath ?? '/health',
      authorization: `Bearer ${token}`,
      child,
    };
    managedRuntimes.set(linked.id, runtime);
    child.once('close', (code, signal) => {
      if (managedRuntimes.get(linked.id)?.child !== child) return;
      managedRuntimes.delete(linked.id);
      if (code !== 0 && signal !== 'SIGTERM') {
        console.warn(`[extensions] ${linked.id} exited unexpectedly (${signal ?? `code ${code}`})`);
      }
    });
    const status = await managedExtensionStatus(linked.id, workspace);
    if (!status.healthy) throw new Error(`${linked.id} did not pass its health check`);
    return { ...status, changed: true };
  } catch (error) {
    child.stdin?.end();
    child.kill('SIGTERM');
    throw error;
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

async function stopManagedExtension(id: string): Promise<ExtensionActionResult> {
  const runtime = managedRuntimes.get(id);
  if (!runtime) {
    return { schemaVersion: 2, id, ok: true, running: false, healthy: false, changed: false };
  }
  managedRuntimes.delete(id);
  runtime.child.stdin?.end();
  if (!(await waitForExit(runtime.child, 1_000))) runtime.child.kill('SIGTERM');
  if (!(await waitForExit(runtime.child, 1_000))) runtime.child.kill('SIGKILL');
  await waitForExit(runtime.child, 500);
  return { schemaVersion: 2, id, ok: true, running: false, healthy: false, changed: true };
}

async function managedExtensionStatus(
  id: string,
  expectedWorkspace?: string,
  requireReady = false
): Promise<ExtensionActionResult> {
  const runtime = managedRuntimes.get(id);
  if (!runtime || runtime.child.exitCode !== null) {
    return { schemaVersion: 2, id, ok: false, running: false, healthy: false };
  }
  const workspaceMatches =
    expectedWorkspace === undefined || runtime.workspace === resolve(expectedWorkspace);
  try {
    const response = await fetch(`${runtime.baseUrl}${runtime.healthPath}`, {
      headers: { Authorization: runtime.authorization },
      signal: AbortSignal.timeout(2_000),
    });
    const health = response.ok ? ((await response.json()) as unknown) : undefined;
    const healthy = response.ok;
    const ready = !requireReady || !isRecord(health) || health.ready !== false;
    return {
      schemaVersion: 2,
      id,
      ok: healthy && workspaceMatches && ready,
      running: true,
      healthy,
      workspace: runtime.workspace,
      workspaceMatches,
      ...(health !== undefined ? { health } : {}),
      ...(!ready
        ? {
            detail:
              isRecord(health) && typeof health.detail === 'string'
                ? health.detail
                : 'extension is not ready',
          }
        : {}),
      ...(!workspaceMatches ? { detail: 'runtime workspace does not match xangi workspace' } : {}),
    };
  } catch (error) {
    return {
      schemaVersion: 2,
      id,
      ok: false,
      running: true,
      healthy: false,
      workspace: runtime.workspace,
      workspaceMatches,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function stopManagedExtensions(): Promise<void> {
  await Promise.all([...managedRuntimes.keys()].map((id) => stopManagedExtension(id)));
}

export interface ResolvedExtensionCapability {
  baseUrl: string;
  authorization: string;
}

export function resolveExtensionCapability(
  extensionId: string,
  capabilityId: string
): ResolvedExtensionCapability | undefined {
  const configPath = defaultExtensionsFile();
  if (!existsSync(configPath)) return undefined;
  let store: ExtensionStore;
  try {
    store = parseStore(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
  const linked = store.extensions.find((item) => item.id === extensionId && item.enabled);
  const runtime = managedRuntimes.get(extensionId);
  if (!linked || !runtime) return undefined;
  try {
    const manifest = parseExtensionManifest(
      JSON.parse(readFileSync(linked.manifestPath, 'utf8')) as unknown
    );
    if (!manifest.capabilities.some((item) => item.id === capabilityId)) return undefined;
    return { baseUrl: runtime.baseUrl, authorization: runtime.authorization };
  } catch {
    return undefined;
  }
}

export async function startAutostartExtensions(
  options: { workspace?: string } = {}
): Promise<void> {
  for (const linked of await listExtensions()) {
    if (!linked.enabled || !linked.autostart) continue;
    try {
      await runExtensionAction(linked, 'start', {
        workspace: options.workspace,
        timeoutMs: 30_000,
      });
      console.log(`[extensions] ${linked.id} is ready`);
    } catch (error) {
      console.warn(
        `[extensions] ${linked.id} failed to start: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export function resolveCapabilityBaseUrl(capabilityId: string): string | undefined {
  const configPath = defaultExtensionsFile();
  if (!existsSync(configPath)) return undefined;
  let store: ExtensionStore;
  try {
    store = parseStore(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
  for (const linked of store.extensions) {
    if (!linked.enabled) continue;
    try {
      const manifest = parseExtensionManifest(
        JSON.parse(readFileSync(linked.manifestPath, 'utf8')) as unknown
      );
      const capability = manifest.capabilities.find((item) => item.id === capabilityId);
      const runtime = resolveExtensionCapability(manifest.id, capabilityId);
      if (capability && runtime) return runtime.baseUrl;
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface ResolvedExtensionAgentBackend extends ExtensionAgentBackend {
  extensionId: string;
  baseUrl?: string;
  authorization?: string;
}

/** Return enabled extension-backed agent backends from the local extension store. */
export function listExtensionAgentBackends(): ResolvedExtensionAgentBackend[] {
  const configPath = defaultExtensionsFile();
  if (!existsSync(configPath)) return [];
  let store: ExtensionStore;
  try {
    store = parseStore(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
  } catch {
    return [];
  }
  const backends: ResolvedExtensionAgentBackend[] = [];
  for (const linked of store.extensions) {
    if (!linked.enabled) continue;
    try {
      const manifest = parseExtensionManifest(
        JSON.parse(readFileSync(linked.manifestPath, 'utf8')) as unknown
      );
      const declaration = manifest.agentBackend;
      if (!declaration || backends.some((item) => item.id === declaration.id)) continue;
      const capability = manifest.capabilities.find((item) => item.id === declaration.capability);
      const runtime = managedRuntimes.get(manifest.id);
      if (!capability) continue;
      backends.push({
        ...declaration,
        extensionId: manifest.id,
        ...(runtime ? { baseUrl: runtime.baseUrl, authorization: runtime.authorization } : {}),
      });
    } catch {
      continue;
    }
  }
  return backends;
}

export function resolveExtensionAgentBackend(
  backendId: string
): ResolvedExtensionAgentBackend | undefined {
  return listExtensionAgentBackends().find(
    (item) => item.id === backendId && item.baseUrl && item.authorization
  );
}
