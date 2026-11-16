import lockfile from 'proper-lockfile';
import { constants } from 'node:fs';
import { access, mkdir, readlink, readdir, rename, rm, symlink, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { versionPath } from './layout.js';
import { ManifestVerifier } from './manifest.js';
import type { AppLayout } from './types.js';

export type ReleaseDownloader = (url: string, maxBytes: number) => Promise<Uint8Array>;
export type ArtifactExtractor = (artifact: Uint8Array, destination: string) => Promise<void>;

export interface ServiceController {
  restart(): Promise<void>;
}

export type HealthCheck = (signal: AbortSignal) => Promise<boolean>;

export interface UpdaterOptions {
  layout: AppLayout;
  manifestVerifier: ManifestVerifier;
  download: ReleaseDownloader;
  extractArtifact: ArtifactExtractor;
  service: ServiceController;
  healthCheck: HealthCheck;
  healthTimeoutMs?: number;
  healthRetryIntervalMs?: number;
}

export interface UpdateOptions {
  onProgress?: (message: string) => void;
  allowDowngrade?: boolean;
  /** Install only: activate the release and provision its OS service, even if already current. */
  forceActivate?: boolean;
}

export interface UpdateResult {
  changed: boolean;
  version: string;
  previousVersion?: string;
}

export class UpdateInProgressError extends Error {
  constructor(readonly lockPath: string) {
    super(`Another update is already in progress for this installation: ${lockPath}`);
    this.name = 'UpdateInProgressError';
  }
}

export class UpdateActivationError extends Error {
  constructor(
    readonly updateError: unknown,
    readonly rollbackError?: unknown
  ) {
    const updateMessage = errorMessage(updateError);
    const rollbackMessage = rollbackError
      ? `; rollback also failed: ${errorMessage(rollbackError)}`
      : '';
    const outcome = rollbackError ? 'rollback failed' : 'rolled back';
    super(`Update activation failed (${outcome}): ${updateMessage}${rollbackMessage}`);
    this.name = 'UpdateActivationError';
  }
}

/**
 * Platform-neutral update orchestration. Network, extraction, service control,
 * and health probing are ports so the state transitions can be tested safely.
 */
export class Updater {
  private readonly layout: AppLayout;
  private readonly manifestVerifier: ManifestVerifier;
  private readonly download: ReleaseDownloader;
  private readonly extractArtifact: ArtifactExtractor;
  private readonly service: ServiceController;
  private readonly healthCheck: HealthCheck;
  private readonly healthTimeoutMs: number;
  private readonly healthRetryIntervalMs: number;

  constructor(options: UpdaterOptions) {
    this.layout = options.layout;
    this.manifestVerifier = options.manifestVerifier;
    this.download = options.download;
    this.extractArtifact = options.extractArtifact;
    this.service = options.service;
    this.healthCheck = options.healthCheck;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 30_000;
    this.healthRetryIntervalMs = options.healthRetryIntervalMs ?? 250;
    if (!Number.isSafeInteger(this.healthTimeoutMs) || this.healthTimeoutMs <= 0) {
      throw new Error('healthTimeoutMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.healthRetryIntervalMs) || this.healthRetryIntervalMs <= 0) {
      throw new Error('healthRetryIntervalMs must be a positive safe integer');
    }
  }

  async update(manifestInput: unknown, options: UpdateOptions = {}): Promise<UpdateResult> {
    const lock = await this.acquireLock();
    let stagingPath: string | undefined;

    try {
      await mkdir(this.layout.versionsDir, { recursive: true });
      await mkdir(this.layout.stagingDir, { recursive: true });

      const currentTarget = await readOptionalLink(this.layout.currentLink);
      const currentVersion = currentTarget ? basename(currentTarget) : undefined;
      options.onProgress?.('Verifying release manifest...');
      const manifest = this.manifestVerifier.verifyManifest(manifestInput, {
        expectedPlatform: this.layout.platform,
        expectedArch: this.layout.arch,
        currentVersion,
        allowDowngrade: options.allowDowngrade,
      });

      if (
        currentTarget &&
        currentVersion === manifest.version &&
        !options.forceActivate &&
        (await pathExists(currentTarget))
      ) {
        options.onProgress?.(`xangi is already up to date (${manifest.version}).`);
        return { version: manifest.version, changed: false };
      }

      options.onProgress?.(`Downloading xangi ${manifest.version}...`);
      const artifact = await this.download(manifest.asset.url, manifest.asset.size);
      options.onProgress?.('Verifying downloaded release...');
      this.manifestVerifier.verifyArtifact(artifact, manifest);

      stagingPath = join(this.layout.stagingDir, `${manifest.version}-${randomUUID()}`);
      await mkdir(stagingPath, { recursive: false });
      options.onProgress?.('Extracting release...');
      await this.extractArtifact(artifact, stagingPath);

      const targetPath = versionPath(this.layout, manifest.version);
      const installedNewVersion = !(await pathExists(targetPath));
      if (installedNewVersion) {
        await rename(stagingPath, targetPath);
        stagingPath = undefined;
      } else {
        await rm(stagingPath, { recursive: true, force: true });
        stagingPath = undefined;
      }

      options.onProgress?.('Switching to the updated release...');
      await atomicLink(targetPath, this.layout.currentLink);
      if (options.forceActivate) {
        try {
          options.onProgress?.('Restarting xangi service...');
          await this.service.restart();
          options.onProgress?.('Checking service health...');
          await this.requireHealthy();
        } catch (updateError) {
          let rollbackError: unknown;
          try {
            options.onProgress?.('Activation failed; rolling back...');
            await this.rollback(currentTarget);
          } catch (error) {
            rollbackError = error;
          }
          if (!rollbackError && installedNewVersion && targetPath !== currentTarget) {
            await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
          }
          throw new UpdateActivationError(updateError, rollbackError);
        }
      }

      if (currentTarget && currentTarget !== targetPath) {
        await atomicLink(currentTarget, this.previousLink);
      }
      // Without activation, an older process may still serve assets from any prior version.
      if (options.forceActivate) await this.retainCurrentAndPrevious();

      return {
        version: manifest.version,
        changed: true,
        ...(currentVersion && currentTarget !== targetPath
          ? { previousVersion: currentVersion }
          : {}),
      };
    } finally {
      if (stagingPath)
        await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      await lock();
    }
  }

  private get previousLink(): string {
    return join(this.layout.appRoot, 'previous');
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(this.layout.appRoot, { recursive: true });
    // Legacy files have no liveness metadata: never delete them speculatively.
    if (await pathExists(this.layout.updateLock))
      throw new UpdateInProgressError(this.layout.updateLock);
    try {
      return await lockfile.lock(this.layout.appRoot, {
        lockfilePath: this.layout.updateLock + '.lease',
        stale: 60_000,
        update: 10_000,
        retries: 0,
      });
    } catch (error) {
      if (errorCode(error) === 'ELOCKED') throw new UpdateInProgressError(this.layout.updateLock);
      throw error;
    }
  }

  private async requireHealthy(): Promise<void> {
    const controller = new AbortController();
    const startedAt = Date.now();
    while (true) {
      const remaining = this.healthTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        controller.abort();
        throw new Error(`Health check timed out after ${this.healthTimeoutMs}ms`);
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        const healthy = await Promise.race([
          this.healthCheck(controller.signal),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`Health check timed out after ${this.healthTimeoutMs}ms`));
            }, remaining);
          }),
        ]);
        if (healthy) return;
      } finally {
        if (timer) clearTimeout(timer);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(this.healthRetryIntervalMs, remaining))
      );
    }
  }

  private async rollback(previousTarget: string | undefined): Promise<void> {
    if (previousTarget) {
      await atomicLink(previousTarget, this.layout.currentLink);
      await this.service.restart();
      return;
    }
    await unlink(this.layout.currentLink).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }

  private async retainCurrentAndPrevious(): Promise<void> {
    const currentTarget = await readOptionalLink(this.layout.currentLink);
    const previousTarget = await readOptionalLink(this.previousLink);
    const retained = new Set(
      [currentTarget, previousTarget].filter((target): target is string => target !== undefined)
    );
    const entries = await readdir(this.layout.versionsDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.layout.versionsDir, entry.name))
        .filter((path) => !retained.has(path))
        .map((path) => rm(path, { recursive: true, force: true }))
    );
  }
}

async function atomicLink(target: string, linkPath: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });
  const temporaryLink = `${linkPath}.${randomUUID()}.tmp`;
  try {
    await symlink(target, temporaryLink, 'dir');
    await rename(temporaryLink, linkPath);
  } finally {
    await unlink(temporaryLink).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }
}

async function readOptionalLink(linkPath: string): Promise<string | undefined> {
  try {
    const target = await readlink(linkPath);
    return isAbsolute(target) ? target : resolve(dirname(linkPath), target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EINVAL') return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
