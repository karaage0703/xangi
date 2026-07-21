import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { arch as hostArch, homedir, platform as hostPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveAppLayout } from '../installer/layout.js';
import { ManifestVerifier } from '../installer/manifest.js';
import { createDarwinServiceAdapter, type ServiceAdapter } from '../installer/platform/darwin.js';
import { createDarwinUpdateScheduler } from '../installer/platform/darwin-update.js';
import { createLinuxServiceAdapter } from '../installer/platform/linux.js';
import { createLinuxUpdateScheduler } from '../installer/platform/linux-update.js';
import {
  externallyManagedUpdateScheduler,
  type UpdateSchedulerAdapter,
} from '../installer/platform/update-scheduler.js';
import type { AppLayout, ManifestPublicKey } from '../installer/types.js';
import { managedServicePath } from '../installer/service-environment.js';
import { streamTarListing } from '../installer/tar-listing.js';
import { parseSetupConfig } from '../setup/schema.js';
import {
  Updater,
  type ArtifactExtractor,
  type HealthCheck,
  type ReleaseDownloader,
  type UpdateResult,
} from '../installer/updater.js';

const execFileAsync = promisify(execFile);

export type InstallerFlags = Record<string, string | boolean>;

export interface ManagedCommandDependencies {
  layout?: AppLayout;
  manifestVerifier?: ManifestVerifier;
  publicKey?: ManifestPublicKey;
  fetchManifest?: (url: string) => Promise<unknown>;
  download?: ReleaseDownloader;
  extractArtifact?: ArtifactExtractor;
  service?: ServiceAdapter;
  updateScheduler?: UpdateSchedulerAdapter;
  healthCheck?: HealthCheck;
  healthTimeoutMs?: number;
  healthRetryIntervalMs?: number;
  homeDir?: string;
  platform?: string;
  arch?: string;
  xdgDataHome?: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
  wsl?: boolean;
  /** Internal install path: activate an already-current bundle to provision its service. */
  forceActivate?: boolean;
}

export async function updateCmd(
  flags: InstallerFlags,
  dependencies: ManagedCommandDependencies = {}
): Promise<string> {
  const result = await executeManagedUpdate(flags, dependencies);
  return `Updated xangi to ${result.version}${result.previousVersion ? ` (previous ${result.previousVersion})` : ''}`;
}

export async function executeManagedUpdate(
  flags: InstallerFlags,
  dependencies: ManagedCommandDependencies = {}
): Promise<UpdateResult> {
  const runtime = await resolveManagedRuntime(flags, dependencies);
  const manifestUrl = await resolveManifestUrl(flags, runtime.layout);
  const manifest = await (dependencies.fetchManifest ?? fetchJson)(manifestUrl);
  const updater = new Updater({
    layout: runtime.layout,
    manifestVerifier: runtime.manifestVerifier,
    download: dependencies.download ?? downloadBytes,
    extractArtifact: dependencies.extractArtifact ?? extractTarGzip,
    service: runtime.service,
    healthCheck: dependencies.healthCheck ?? checkLocalHealth,
    healthTimeoutMs: dependencies.healthTimeoutMs,
    healthRetryIntervalMs: dependencies.healthRetryIntervalMs,
  });
  return updater.update(manifest, {
    allowDowngrade: booleanFlag(flags, 'allow-downgrade'),
    forceActivate: dependencies.forceActivate,
  });
}

export async function resolveManagedRuntime(
  flags: InstallerFlags,
  dependencies: ManagedCommandDependencies
): Promise<{
  layout: AppLayout;
  manifestVerifier: ManifestVerifier;
  service: ServiceAdapter;
  updateScheduler: UpdateSchedulerAdapter;
}> {
  const lifecycle = await resolveManagedLifecycle(dependencies);
  const manifestVerifier =
    dependencies.manifestVerifier ??
    new ManifestVerifier(
      dependencies.publicKey ?? (await readPublicKey(resolvePublicKeyPath(flags, lifecycle.layout)))
    );
  return { ...lifecycle, manifestVerifier };
}

export async function resolveManagedLifecycle(
  dependencies: ManagedCommandDependencies = {}
): Promise<{
  layout: AppLayout;
  service: ServiceAdapter;
  updateScheduler: UpdateSchedulerAdapter;
}> {
  const platform = dependencies.platform ?? dependencies.layout?.platform ?? hostPlatform();
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`Managed xangi preview supports macOS and Linux/WSL2 (detected ${platform})`);
  }
  const homeDir = dependencies.homeDir ?? homedir();
  const layout =
    dependencies.layout ??
    resolveAppLayout({
      platform,
      arch: dependencies.arch ?? hostArch(),
      homeDir,
      xdgDataHome: dependencies.xdgDataHome ?? process.env.XDG_DATA_HOME,
      xdgConfigHome: dependencies.xdgConfigHome ?? process.env.XDG_CONFIG_HOME,
      xdgStateHome: dependencies.xdgStateHome ?? process.env.XDG_STATE_HOME,
    });
  const service = dependencies.service ?? createDefaultService(layout, homeDir, dependencies.wsl);
  const updateScheduler =
    dependencies.updateScheduler ??
    (dependencies.service
      ? externallyManagedUpdateScheduler
      : createDefaultUpdateScheduler(layout, homeDir));
  return { layout, service, updateScheduler };
}

function createDefaultUpdateScheduler(layout: AppLayout, homeDir: string): UpdateSchedulerAdapter {
  const logsDir = join(layout.stateDir, 'logs');
  const launcherPath = join(layout.appRoot, 'bin', 'xangi');
  if (layout.platform === 'linux') {
    const unitDir = join(dirname(layout.configDir), 'systemd', 'user');
    return createLinuxUpdateScheduler({
      serviceName: 'xangi-update.service',
      servicePath: join(unitDir, 'xangi-update.service'),
      timerName: 'xangi-update.timer',
      timerPath: join(unitDir, 'xangi-update.timer'),
      launcherPath,
      workingDirectory: layout.currentLink,
    });
  }
  return createDarwinUpdateScheduler({
    label: 'dev.xangi.update',
    plistPath: join(homeDir, 'Library', 'LaunchAgents', 'dev.xangi.update.plist'),
    launcherPath,
    workingDirectory: layout.currentLink,
    stdoutPath: join(logsDir, 'update.log'),
    stderrPath: join(logsDir, 'update.error.log'),
  });
}

function createDefaultService(layout: AppLayout, homeDir: string, wsl?: boolean): ServiceAdapter {
  const logsDir = join(layout.stateDir, 'logs');
  const servicePath = resolveManagedServicePath(layout, homeDir);
  if (layout.platform === 'linux') {
    return createLinuxServiceAdapter({
      unitName: 'xangi.service',
      unitPath: join(dirname(layout.configDir), 'systemd', 'user', 'xangi.service'),
      nodePath: join(layout.currentLink, 'runtime', 'bin', 'node'),
      configLoaderPath: join(layout.currentLink, 'dist', 'installer', 'runtime-config-main.js'),
      configPath: layout.configFile,
      stateDir: layout.stateDir,
      entrypoint: join(layout.currentLink, 'dist', 'index.js'),
      workingDirectory: layout.currentLink,
      path: servicePath,
      wsl,
    });
  }
  return createDarwinServiceAdapter({
    label: 'dev.xangi.app',
    nodePath: join(layout.currentLink, 'runtime', 'bin', 'node'),
    configLoaderPath: join(layout.currentLink, 'dist', 'installer', 'runtime-config-main.js'),
    configPath: layout.configFile,
    stateDir: layout.stateDir,
    entrypoint: join(layout.currentLink, 'dist', 'index.js'),
    workingDirectory: layout.currentLink,
    stdoutPath: join(logsDir, 'xangi.log'),
    stderrPath: join(logsDir, 'xangi.error.log'),
    path: servicePath,
    plistPath: join(layout.configDir, 'service', 'dev.xangi.app.plist'),
    autostartPlistPath: join(homeDir, 'Library', 'LaunchAgents', 'dev.xangi.app.plist'),
  });
}

export function resolveManagedServicePath(layout: AppLayout, homeDir: string): string {
  let backendExecutable: string | undefined;
  try {
    backendExecutable = parseSetupConfig(
      JSON.parse(readFileSync(layout.configFile, 'utf8')) as unknown
    ).backendExecutable;
  } catch {
    // install before setup and legacy configs use the safe platform baseline.
  }
  return managedServicePath(layout, homeDir, backendExecutable);
}

async function readPublicKey(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Release public key not found: ${path}`);
    }
    throw error;
  }
}

async function resolveManifestUrl(flags: InstallerFlags, layout: AppLayout): Promise<string> {
  const explicit = stringValue(flags.manifest) ?? process.env.XANGI_RELEASE_MANIFEST_URL?.trim();
  if (explicit) return requireHttpsUrl(explicit, 'Release manifest URL');
  const configPath = join(layout.configDir, 'release.json');
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !Object.hasOwn(parsed, 'manifestUrl') ||
      typeof (parsed as { manifestUrl?: unknown }).manifestUrl !== 'string'
    ) {
      throw new Error('manifestUrl must be a string');
    }
    return requireHttpsUrl((parsed as { manifestUrl: string }).manifestUrl, 'Release manifest URL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Release configuration not found: ${configPath}; specify --manifest <https-url>`
      );
    }
    throw new Error(
      `Invalid release configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function resolvePublicKeyPath(flags: InstallerFlags, layout: AppLayout): string {
  return (
    stringValue(flags['public-key']) ??
    process.env.XANGI_RELEASE_PUBLIC_KEY_PATH?.trim() ??
    join(layout.appRoot, 'trust', 'release-public-key.pem')
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Manifest download failed: HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function downloadBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Release download failed: HTTP ${response.status}`);
  return readLimitedBody(response, maxBytes, 'Release download');
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
  label: string
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`${label} size is invalid`);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes)
    throw new Error(`${label} exceeds signed size`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds signed size`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function extractTarGzip(artifact: Uint8Array, destination: string): Promise<void> {
  const archivePath = join(
    dirname(destination),
    `.xangi-artifact-${process.pid}-${Date.now()}.tar.gz`
  );
  try {
    await writeFile(archivePath, artifact, { mode: 0o600 });
    const state: ReleaseTarValidationState = {};
    await streamTarListing(archivePath, false, (line) => validateReleasePath(line, state));
    if (!state.archiveRoot) throw new Error('Release archive is empty');
    await streamTarListing(archivePath, true, validateReleaseType);
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destination, '--strip-components', '1']);
  } finally {
    await rm(archivePath, { force: true });
  }
}

export function validateTarListing(pathsOutput: string, verboseOutput: string): void {
  const paths = pathsOutput.split(/\r?\n/).filter(Boolean);
  if (paths.length === 0) throw new Error('Release archive is empty');
  const state: ReleaseTarValidationState = {};
  for (const path of paths) {
    validateReleasePath(path, state);
  }
  for (const line of verboseOutput.split(/\r?\n/).filter(Boolean)) {
    validateReleaseType(line);
  }
}

interface ReleaseTarValidationState {
  archiveRoot?: string;
}

function validateReleasePath(path: string, state: ReleaseTarValidationState): void {
  const parts = path.split('/').filter(Boolean);
  if (
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.includes('\\') ||
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) ||
    parts.includes('..') ||
    parts.length < 2
  ) {
    throw new Error(`Unsafe release archive path: ${path}`);
  }
  state.archiveRoot ??= parts[0];
  if (parts[0] !== state.archiveRoot) {
    throw new Error('Release archive must contain exactly one top-level directory');
  }
}

function validateReleaseType(line: string): void {
  if (!line.startsWith('-') && !line.startsWith('d')) {
    throw new Error('Release archive may contain only regular files and directories');
  }
}

async function checkLocalHealth(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:18888/health', { signal });
    return response.ok;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

function stringValue(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireHttpsUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return url.href;
}

function booleanFlag(flags: InstallerFlags, key: string): boolean {
  const value = flags[key];
  return value === true || value === 'true';
}
