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
import { getEventsConfig } from './events-emitter.js';
import { resolveAppLayout } from './installer/layout.js';
import { resolveWebChatHost, resolveWebChatPort } from './web-endpoint-config.js';

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

export interface ExtensionStartup {
  exclusiveGroup: string;
  timeoutSeconds: number;
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
  startup?: ExtensionStartup;
  setup?: {
    instructions: string;
  };
  update?: {
    prepare: ExtensionUpdatePreparation;
  };
  ui?: {
    capability: string;
    path: string;
    composer?: { path: string; permissions?: Array<'microphone'> };
  };
  deviceIngress?: {
    capability: string;
    authentication: 'extension-bearer';
  };
  agentBackend?: ExtensionAgentBackend;
  capabilities: ExtensionCapability[];
}

export interface LinkedExtension {
  id: string;
  manifestPath: string;
  enabled: boolean;
  autostart: boolean;
  /** null disables the manifest startup group for this installation. */
  startup?: ExtensionStartup | null;
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
  ready?: boolean;
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

function managedExtensionHostUrl(env: NodeJS.ProcessEnv): string {
  const port = resolveWebChatPort(undefined, env).port;
  const host = resolveWebChatHost(undefined, env);
  if (host === '::1') return `http://[::1]:${port}`;
  if (host === '0.0.0.0' || host === '::' || host === '*') {
    return `http://127.0.0.1:${port}`;
  }
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

export function managedExtensionHostContext(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const eventsConfig = getEventsConfig();
  const context: NodeJS.ProcessEnv = {
    XANGI_EXTENSION_INSTANCE_ID: eventsConfig.instanceId,
  };
  if (env.WEB_CHAT_ENABLED !== 'true') return context;

  const hostUrl = managedExtensionHostUrl(env);
  context.XANGI_EXTENSION_HOST_URL = hostUrl;
  if (eventsConfig.enabled) {
    context.XANGI_EXTENSION_EVENTS_URL = `${hostUrl}/api/events/stream`;
  }
  return context;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defaultExtensionsFile(): string {
  if (process.env.XANGI_EXTENSIONS_FILE) return process.env.XANGI_EXTENSIONS_FILE;
  if (process.env.DATA_DIR) return join(resolve(process.env.DATA_DIR), 'extensions.json');
  if (process.env.WORKSPACE_PATH) {
    return join(resolve(process.env.WORKSPACE_PATH), '.xangi', 'extensions.json');
  }
  return legacyExtensionsFile();
}

function legacyExtensionsFile(): string {
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

function effectiveDataDir(): string | undefined {
  if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR);
  if (process.env.WORKSPACE_PATH) return join(resolve(process.env.WORKSPACE_PATH), '.xangi');
  return undefined;
}

function parseStartup(value: unknown): ExtensionStartup {
  if (
    !isRecord(value) ||
    typeof value.exclusiveGroup !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,63}$/.test(value.exclusiveGroup)
  ) {
    throw new Error('startup.exclusiveGroup must be a resource group name');
  }
  const timeoutSeconds = value.timeoutSeconds ?? 120;
  if (
    typeof timeoutSeconds !== 'number' ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 3600
  ) {
    throw new Error('startup.timeoutSeconds must be between 1 and 3600');
  }
  return { exclusiveGroup: value.exclusiveGroup, timeoutSeconds };
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
  let parsedDeviceIngress: ExtensionManifest['deviceIngress'];
  if (value.deviceIngress !== undefined) {
    const ingress = value.deviceIngress;
    if (
      !isRecord(ingress) ||
      typeof ingress.capability !== 'string' ||
      !parsedCapabilities.some((item) => item.id === ingress.capability) ||
      ingress.authentication !== 'extension-bearer'
    ) {
      throw new Error('invalid extension device ingress declaration');
    }
    parsedDeviceIngress = { capability: ingress.capability, authentication: 'extension-bearer' };
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
    if (ui.composer !== undefined) {
      const composer = ui.composer;
      if (
        !isRecord(composer) ||
        typeof composer.path !== 'string' ||
        !/^\/(?!\/)[A-Za-z0-9/_.-]*$/.test(composer.path) ||
        composer.path.includes('..') ||
        (composer.permissions !== undefined &&
          (!Array.isArray(composer.permissions) ||
            composer.permissions.some((permission) => permission !== 'microphone')))
      )
        throw new Error('invalid extension composer contribution');
      parsedUi.composer = {
        path: composer.path,
        ...(composer.permissions
          ? { permissions: [...composer.permissions] as Array<'microphone'> }
          : {}),
      };
    }
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
    ...(value.startup !== undefined ? { startup: parseStartup(value.startup) } : {}),
    ...(parsedSetup ? { setup: parsedSetup } : {}),
    ...(parsedUpdate ? { update: parsedUpdate } : {}),
    ...(parsedUi ? { ui: parsedUi } : {}),
    ...(parsedDeviceIngress ? { deviceIngress: parsedDeviceIngress } : {}),
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
    return {
      ...extension,
      ...(extension.startup !== undefined && extension.startup !== null
        ? { startup: parseStartup(extension.startup) }
        : {}),
    } as unknown as LinkedExtension;
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

/**
 * Move only entries owned by this instance out of the pre-DATA_DIR registry.
 *
 * Older xangi versions stored one registry per OS user. Copying that complete
 * file would reproduce the cross-instance leak, so only repository-managed
 * manifests below this instance's DATA_DIR are eligible. Listing remains
 * read-only; startup invokes this migration before autostart.
 */
export async function migrateLegacyExtensionStore(
  options: { legacyPath?: string } = {}
): Promise<number> {
  if (process.env.XANGI_EXTENSIONS_FILE) return 0;
  const dataDir = effectiveDataDir();
  if (!dataDir) return 0;
  const destination = defaultExtensionsFile();
  const legacy = options.legacyPath ?? legacyExtensionsFile();
  if (resolve(destination) === resolve(legacy) || existsSync(destination) || !existsSync(legacy)) {
    return 0;
  }

  const managedRoot = join(dataDir, 'extensions', 'sources');
  const legacyStore = await readExtensionStore(legacy);
  const owned = legacyStore.extensions.filter((linked) => {
    const rel = relative(managedRoot, resolve(linked.manifestPath));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (owned.length === 0) return 0;

  await writeExtensionStore({ schemaVersion: 1, extensions: owned }, destination);
  return owned.length;
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
    ...(() => {
      const previous = store.extensions.find((item) => item.id === manifest.id);
      return previous?.startup !== undefined ? { startup: previous.startup } : {};
    })(),
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

// Resource names are instance-local coordination labels, not GPU device selectors.
const startupQueues = new Map<string, Promise<unknown>>();
const startupOwners = new Map<string, string>();
const startupMessages = new Map<string, string>();
const startupPending = new Map<string, Promise<ExtensionActionResult>>();
const startupGeneration = new Map<string, number>();

function initializationFinished(status: ExtensionActionResult): boolean {
  if (status.running === false) return true;
  const health = status.health;
  if (!isRecord(health) || !isRecord(health.startup)) return false;
  return health.startup.state === 'complete' || health.startup.state === 'failed';
}

function startupPolicy(linked: LinkedExtension, manifest: ExtensionManifest) {
  return linked.startup === undefined ? manifest.startup : linked.startup;
}

async function startWithStartupGroup(
  linked: LinkedExtension,
  manifest: ExtensionManifest,
  options: { workspace?: string; timeoutMs?: number }
): Promise<ExtensionActionResult> {
  const pending = startupPending.get(linked.id);
  if (pending) return pending;
  const policy = startupPolicy(linked, manifest);
  if (!policy) {
    startupMessages.delete(linked.id);
    return startManagedExtension(linked, manifest, options);
  }
  const group = policy.exclusiveGroup;
  const generation = startupGeneration.get(linked.id) ?? 0;
  const previous = startupQueues.get(group) ?? Promise.resolve();
  startupMessages.set(linked.id, `waiting for startup group ${group}`);
  const task = previous
    .catch(() => {})
    .then(async () => {
      if ((startupGeneration.get(linked.id) ?? 0) !== generation) {
        return { id: linked.id, ok: false, running: false, detail: 'startup cancelled' };
      }
      const owner = startupOwners.get(group);
      if (owner) {
        const status = await managedExtensionStatus(owner, undefined, false, false);
        if (!initializationFinished(status)) {
          const detail = `startup group ${group} blocked by ${owner}; initialization has not finished`;
          startupMessages.set(linked.id, detail);
          return {
            id: linked.id,
            ok: false,
            running: managedRuntimes.has(linked.id),
            ready: false,
            detail,
          };
        }
        startupOwners.delete(group);
        startupMessages.delete(owner);
      }
      startupOwners.set(group, linked.id);
      startupMessages.set(linked.id, `initializing startup group ${group}`);
      try {
        let status = await startManagedExtension(linked, manifest, options);
        if ((startupGeneration.get(linked.id) ?? 0) !== generation) {
          return await stopManagedExtension(linked.id);
        }
        const deadline = Date.now() + policy.timeoutSeconds * 1000;
        while (!initializationFinished(status)) {
          if (Date.now() >= deadline) {
            const detail = `startup group ${group} timed out initializing ${linked.id}; group remains blocked`;
            startupMessages.set(linked.id, detail);
            return { ...status, ok: false, detail };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          status = await managedExtensionStatus(linked.id, undefined, false, false);
        }
        startupOwners.delete(group);
        startupMessages.delete(linked.id);
        const failed =
          isRecord(status.health) &&
          isRecord(status.health.startup) &&
          status.health.startup.state === 'failed';
        return { ...status, ...(failed ? { ok: false } : {}), changed: true };
      } catch (error) {
        // Retain ownership if a child may still be initializing after a failed start.
        if (!managedRuntimes.has(linked.id)) startupOwners.delete(group);
        startupMessages.delete(linked.id);
        throw error;
      }
    });
  startupQueues.set(group, task);
  startupPending.set(linked.id, task);
  try {
    return await task;
  } finally {
    if (startupQueues.get(group) === task) startupQueues.delete(group);
    if (startupPending.get(linked.id) === task) startupPending.delete(linked.id);
  }
}

export async function runExtensionAction(
  linked: LinkedExtension,
  action: ExtensionAction,
  options: { workspace?: string; timeoutMs?: number } = {}
): Promise<ExtensionActionResult> {
  const manifest = await linkedManifest(linked);
  if (action === 'start') return startWithStartupGroup(linked, manifest, options);
  if (action === 'stop') return stopManagedExtension(linked.id);
  if (action === 'restart') {
    await stopManagedExtension(linked.id);
    await startupPending.get(linked.id);
    return startWithStartupGroup(linked, manifest, options);
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
  const childEnv = { ...process.env };
  delete childEnv.XANGI_EXTENSION_HOST_URL;
  delete childEnv.XANGI_EXTENSION_EVENTS_URL;
  delete childEnv.XANGI_EXTENSION_INSTANCE_ID;
  Object.assign(childEnv, managedExtensionHostContext(), {
    XANGI_EXTENSION_AUTH_TOKEN: token,
  });
  const child = spawn(executable, ['serve', '--workspace', workspace], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });
  let ready: ManagedReadyMessage;
  let baseUrl: string;
  try {
    ready = await waitForReady(linked, child, options.timeoutMs ?? 30_000);
    child.stdout?.resume();
    child.stderr?.resume();
    if (ready.id !== linked.id) throw new Error(`readiness id mismatch: ${ready.id}`);
    if (resolve(ready.workspace) !== workspace) {
      throw new Error(`readiness workspace mismatch: ${ready.workspace}`);
    }
    baseUrl = validateManagedBaseUrl(ready.baseUrl);
  } catch (error) {
    await terminateFailedStart(child);
    throw error;
  }

  const runtime: ManagedExtensionRuntime = {
    id: linked.id,
    workspace,
    baseUrl,
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

  // A valid readiness message establishes the managed runtime. Health is an
  // observable state that may recover after a slow cold start, not a reason to
  // tear down an otherwise valid child process.
  const status = await managedExtensionStatus(linked.id, workspace, false, false);
  await observeStartupChildExit(child, status.healthy === true ? 0 : 100);
  if (
    status.running !== true ||
    managedChildExited(child) ||
    managedRuntimes.get(linked.id)?.child !== child
  ) {
    if (managedRuntimes.get(linked.id)?.child === child) managedRuntimes.delete(linked.id);
    await terminateFailedStart(child);
    throw new Error(`${linked.id} exited during startup`);
  }
  return { ...status, changed: true };
}

async function observeStartupChildExit(
  child: ReturnType<typeof spawn>,
  graceMs: number
): Promise<void> {
  if (managedChildExited(child)) return;
  await new Promise<void>((resolvePromise) => {
    let settled = false;
    let immediate: NodeJS.Immediate | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (immediate) clearImmediate(immediate);
      if (timer) clearTimeout(timer);
      child.removeListener('exit', finish);
      resolvePromise();
    };
    child.once('exit', finish);
    if (graceMs > 0) timer = setTimeout(finish, graceMs);
    else immediate = setImmediate(finish);
  });
}

function managedChildExited(child: ReturnType<typeof spawn>): boolean {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return true;
  try {
    process.kill(child.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

async function terminateFailedStart(child: ReturnType<typeof spawn>): Promise<void> {
  child.stdin?.end();
  if (child.exitCode === null) child.kill('SIGTERM');
  if (!(await waitForExit(child, 1_000))) child.kill('SIGKILL');
  await waitForExit(child, 500);
}

async function stopManagedExtension(id: string): Promise<ExtensionActionResult> {
  startupGeneration.set(id, (startupGeneration.get(id) ?? 0) + 1);
  startupMessages.delete(id);
  const runtime = managedRuntimes.get(id);
  if (!runtime) {
    return {
      schemaVersion: 2,
      id,
      ok: true,
      running: false,
      healthy: false,
      ready: false,
      changed: false,
    };
  }
  runtime.child.stdin?.end();
  if (!(await waitForExit(runtime.child, 1_000))) runtime.child.kill('SIGTERM');
  if (!(await waitForExit(runtime.child, 1_000))) runtime.child.kill('SIGKILL');
  const exited = await waitForExit(runtime.child, 500);
  if (!exited) throw new Error(`${id} did not exit; startup group remains reserved`);
  if (managedRuntimes.get(id) === runtime) managedRuntimes.delete(id);
  return {
    schemaVersion: 2,
    id,
    ok: true,
    running: false,
    healthy: false,
    ready: false,
    changed: true,
  };
}

async function managedExtensionStatus(
  id: string,
  expectedWorkspace?: string,
  requireReady = false,
  includeStartupMessage = true
): Promise<ExtensionActionResult> {
  const runtime = managedRuntimes.get(id);
  if (includeStartupMessage && startupMessages.has(id)) {
    const message = startupMessages.get(id);
    const generation = startupGeneration.get(id) ?? 0;
    // A startup deadline ends the caller's wait, not the child's initialization.
    // Probe the child before allowing a saved timeout to hide its terminal state.
    if (runtime && [...startupOwners.values()].includes(id)) {
      const status = await managedExtensionStatus(id, expectedWorkspace, requireReady, false);
      if (
        managedRuntimes.get(id) !== runtime ||
        (startupGeneration.get(id) ?? 0) !== generation ||
        startupMessages.get(id) !== message
      ) {
        return managedExtensionStatus(id, expectedWorkspace, requireReady);
      }
      if (initializationFinished(status)) {
        for (const [group, owner] of startupOwners) {
          if (owner === id) startupOwners.delete(group);
        }
        startupMessages.delete(id);
        return status;
      }
      return { ...status, ok: false, ready: false, detail: message };
    }
    return {
      schemaVersion: 2,
      id,
      ok: false,
      running: Boolean(runtime),
      ready: false,
      detail: startupMessages.get(id),
    };
  }
  if (!runtime || runtime.child.exitCode !== null) {
    return { schemaVersion: 2, id, ok: false, running: false, healthy: false, ready: false };
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
    // Schema-v2 health payloads may explicitly report a warming state. Older
    // extensions omit `ready`; a successful legacy health response is ready.
    const ready = healthy && (!isRecord(health) || health.ready !== false);
    const initializationFailed =
      isRecord(health) && isRecord(health.startup) && health.startup.state === 'failed';
    return {
      schemaVersion: 2,
      id,
      ok: healthy && !initializationFailed && workspaceMatches && (!requireReady || ready),
      running: true,
      healthy,
      ready,
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
      ready: false,
      workspace: runtime.workspace,
      workspaceMatches,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function stopManagedExtensions(): Promise<void> {
  const ids = new Set([...managedRuntimes.keys(), ...startupPending.keys()]);
  await Promise.all([...ids].map((id) => stopManagedExtension(id)));
  await Promise.allSettled([...startupPending.values()]);
  startupMessages.clear();
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
  const migrated = await migrateLegacyExtensionStore();
  if (migrated > 0) {
    console.log(
      `[extensions] migrated ${migrated} instance-owned extension${migrated === 1 ? '' : 's'} to ${defaultExtensionsFile()}`
    );
  }
  const grouped: Promise<void>[] = [];
  for (const linked of await listExtensions()) {
    if (!linked.enabled || !linked.autostart) continue;
    const launch = async () => {
      try {
        const status = await runExtensionAction(linked, 'start', {
          workspace: options.workspace,
          timeoutMs: 30_000,
        });
        if (status.ready === true) console.log(`[extensions] ${linked.id} is ready`);
        else if (status.running === true) {
          console.warn(
            `[extensions] ${linked.id} started but is not ready${status.detail ? `: ${status.detail}` : ''}`
          );
        } else {
          console.warn(
            `[extensions] ${linked.id} failed to stay running after startup${status.detail ? `: ${status.detail}` : ''}`
          );
        }
      } catch (error) {
        console.warn(
          `[extensions] ${linked.id} failed to start: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };
    try {
      if (startupPolicy(linked, await linkedManifest(linked))) grouped.push(launch());
      else await launch();
    } catch (error) {
      console.warn(`[extensions] ${linked.id} invalid startup configuration: ${String(error)}`);
    }
  }
  await Promise.all(grouped);
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
