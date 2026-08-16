import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadExtensionManifest, type ExtensionManifest } from './extensions.js';
import { streamTarListing } from './installer/tar-listing.js';

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export interface RemoteExtensionSource {
  repository: string;
  repositoryUrl: string;
  commitSha: string;
  manifestPath: string;
  assetSha256: string;
  addedAt: string;
  updatedAt?: string;
  license?: string;
}

interface RemoteExtensionSourceStore {
  schemaVersion: 1;
  sources: RemoteExtensionSource[];
}

export interface PrepareExtensionRepositoryOptions {
  dataDir?: string;
  fetch?: typeof fetch;
  download?: (url: string, maxBytes: number) => Promise<Uint8Array>;
  extract?: (artifact: Uint8Array, destination: string) => Promise<void>;
  now?: () => Date;
  reservedIds?: ReadonlySet<string>;
  expectedCommitSha?: string;
  expectedExtensionId?: string;
  expectedPreviousCommitSha?: string;
  beforeSwap?: (context: ExtensionRepositorySwapContext) => Promise<void>;
  afterSwap?: (context: ExtensionRepositorySwapContext) => Promise<void>;
  beforeRollback?: (context: ExtensionRepositorySwapContext) => Promise<void>;
  afterRollback?: (context: ExtensionRepositorySwapContext) => Promise<void>;
}

export interface PublicGitHubExtensionInspection {
  repository: string;
  repositoryUrl: string;
  commitSha: string;
  license?: string;
}

export interface ExtensionRepositorySwapContext {
  candidateManifest: ExtensionManifest;
  source: RemoteExtensionSource;
  currentSource?: RemoteExtensionSource;
}

interface GitHubRepositoryDetails {
  repository: string;
  repositoryUrl: string;
  defaultBranch: string;
  license?: string;
}

export function parsePublicGitHubRepositoryUrl(value: string): {
  repository: string;
  repositoryUrl: string;
} {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('GitHub repository URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use a public https://github.com/owner/repository URL');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new Error('Use a repository root URL without an extra path');
  }
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/, '');
  if (
    !owner ||
    !name ||
    owner === '.' ||
    owner === '..' ||
    name === '.' ||
    name === '..' ||
    owner.length > 100 ||
    name.length > 100 ||
    !REPOSITORY_SEGMENT.test(owner) ||
    !REPOSITORY_SEGMENT.test(name)
  ) {
    throw new Error('GitHub repository owner or name is invalid');
  }
  const repository = `${owner}/${name}`;
  return { repository, repositoryUrl: `https://github.com/${repository}` };
}

export function defaultRemoteExtensionDataDir(): string {
  return resolve(
    process.env.DATA_DIR || join(process.env.WORKSPACE_PATH || process.cwd(), '.xangi')
  );
}

export async function listRemoteExtensionSources(
  dataDir = defaultRemoteExtensionDataDir()
): Promise<RemoteExtensionSource[]> {
  const statePath = join(dataDir, 'extension-sources.json');
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.sources)) {
      throw new Error('schema mismatch');
    }
    return value.sources.map((source) => parseRemoteExtensionSource(source, dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `Invalid extension source state ${statePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function preparePublicGitHubExtension(
  repositoryUrl: string,
  options: PrepareExtensionRepositoryOptions = {}
): Promise<RemoteExtensionSource> {
  const inspection = await inspectPublicGitHubExtension(repositoryUrl, { fetch: options.fetch });
  if (options.expectedCommitSha && inspection.commitSha !== options.expectedCommitSha) {
    throw new Error(
      `Extension update target changed: expected ${options.expectedCommitSha}, got ${inspection.commitSha}`
    );
  }
  const archiveUrl = `https://api.github.com/repos/${inspection.repository}/tarball/${inspection.commitSha}`;
  const artifact = await (options.download ?? downloadBytes)(archiveUrl, MAX_ARCHIVE_BYTES);
  const dataDir = resolve(options.dataDir ?? defaultRemoteExtensionDataDir());
  const sourcesDir = join(dataDir, 'extensions', 'sources');
  const destination = join(sourcesDir, inspection.repository.replace('/', '--'));
  const lockDir = join(dataDir, 'extension-source.lock');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await acquireLock(lockDir);

  let stagingDir: string | undefined;
  let previousDir: string | undefined;
  let destinationInstalled = false;
  let swapStarted = false;
  let swapContext: ExtensionRepositorySwapContext | undefined;
  try {
    const current = await listRemoteExtensionSources(dataDir);
    const currentSource = current.find((item) => item.repository === inspection.repository);
    if (
      options.expectedPreviousCommitSha &&
      currentSource?.commitSha !== options.expectedPreviousCommitSha
    ) {
      throw new Error('Extension source changed after the update conversation started');
    }
    await mkdir(sourcesDir, { recursive: true, mode: 0o700 });
    stagingDir = await mkdtemp(join(sourcesDir, '.xangi-extension-'));
    await (options.extract ?? extractExtensionTarGzip)(artifact, stagingDir);
    const manifestPath = join(stagingDir, 'xangi-extension.json');
    const manifest = await loadExtensionManifest(manifestPath, { requireEntrypoint: false });
    await validateSetupDocument(stagingDir, manifest.setup?.instructions);
    if (options.expectedExtensionId && manifest.id !== options.expectedExtensionId) {
      throw new Error(
        `Extension id changed: expected ${options.expectedExtensionId}, got ${manifest.id}`
      );
    }
    if (options.reservedIds?.has(manifest.id)) {
      throw new Error(
        `An extension with id ${manifest.id} already exists in the repository catalog`
      );
    }

    const now = (options.now ?? (() => new Date()))();
    const source: RemoteExtensionSource = {
      repository: inspection.repository,
      repositoryUrl: inspection.repositoryUrl,
      commitSha: inspection.commitSha,
      manifestPath: join(destination, 'xangi-extension.json'),
      assetSha256: createHash('sha256').update(artifact).digest('hex'),
      addedAt: currentSource?.addedAt ?? now.toISOString(),
      ...(currentSource ? { updatedAt: now.toISOString() } : {}),
      ...(inspection.license ? { license: inspection.license } : {}),
    };
    swapContext = {
      candidateManifest: manifest,
      source,
      ...(currentSource ? { currentSource } : {}),
    };
    await options.beforeSwap?.(swapContext);
    swapStarted = true;

    previousDir = `${destination}.previous-${process.pid}-${Date.now()}`;
    try {
      await rename(destination, previousDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      previousDir = undefined;
    }
    await rename(stagingDir, destination);
    stagingDir = undefined;
    destinationInstalled = true;

    await options.afterSwap?.(swapContext);
    const next = current.filter(
      (item) => item.repository !== source.repository && item.manifestPath !== source.manifestPath
    );
    const duplicateId = await Promise.all(
      next.map(
        async (item) =>
          (await loadExtensionManifest(item.manifestPath, { requireEntrypoint: false })).id
      )
    );
    if (duplicateId.includes(manifest.id)) {
      throw new Error(
        `An extension with id ${manifest.id} already exists in the repository catalog`
      );
    }
    await writeStoreAtomic(join(dataDir, 'extension-sources.json'), {
      schemaVersion: 1,
      sources: [...next, source],
    });
    const obsoleteDir = previousDir;
    previousDir = undefined;
    if (obsoleteDir) await rm(obsoleteDir, { recursive: true, force: true }).catch(() => {});
    destinationInstalled = false;
    return source;
  } catch (error) {
    let rollbackError: unknown;
    if (swapStarted && swapContext) {
      try {
        await options.beforeRollback?.(swapContext);
      } catch (cause) {
        rollbackError = cause;
      }
    }
    if (previousDir) {
      try {
        await rm(destination, { recursive: true, force: true });
        await rename(previousDir, destination);
        previousDir = undefined;
        destinationInstalled = false;
      } catch (cause) {
        rollbackError ??= cause;
      }
    } else if (destinationInstalled) {
      try {
        await rm(destination, { recursive: true, force: true });
        destinationInstalled = false;
      } catch (cause) {
        rollbackError ??= cause;
      }
    }
    if (swapStarted && !previousDir && swapContext) {
      try {
        await options.afterRollback?.(swapContext);
      } catch (cause) {
        rollbackError ??= cause;
      }
    }
    if (rollbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; rollback failed: ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`
      );
    }
    throw error;
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
    if (previousDir && !destinationInstalled)
      await rm(previousDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  }
}

export async function inspectPublicGitHubExtension(
  repositoryUrl: string,
  options: { fetch?: typeof fetch } = {}
): Promise<PublicGitHubExtensionInspection> {
  const parsed = parsePublicGitHubRepositoryUrl(repositoryUrl);
  const request = options.fetch ?? fetch;
  const details = await readGitHubRepository(parsed.repository, request);
  const commitSha = await resolveGitHubCommit(details.repository, details.defaultBranch, request);
  return {
    repository: details.repository,
    repositoryUrl: details.repositoryUrl,
    commitSha,
    ...(details.license ? { license: details.license } : {}),
  };
}

async function validateSetupDocument(root: string, configured?: string): Promise<void> {
  const candidates = configured ? [configured] : ['XANGI_SETUP.md', 'README.md'];
  for (const candidate of candidates) {
    const path = join(root, candidate);
    try {
      await access(path, constants.R_OK);
      if ((await stat(path)).isFile()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  if (configured) throw new Error(`Extension setup instructions not found: ${configured}`);
  throw new Error('Extension setup instructions not found (XANGI_SETUP.md or README.md)');
}

async function readGitHubRepository(
  repository: string,
  request: typeof fetch
): Promise<GitHubRepositoryDetails> {
  const response = await request(`https://api.github.com/repos/${repository}`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub repository lookup failed: HTTP ${response.status}`);
  const value = (await response.json()) as unknown;
  if (!isRecord(value) || typeof value.default_branch !== 'string' || !value.default_branch) {
    throw new Error('GitHub repository metadata is invalid');
  }
  if (value.private !== false) throw new Error('Only public GitHub repositories are supported');
  let license: string | undefined;
  if (isRecord(value.license) && typeof value.license.spdx_id === 'string') {
    license = value.license.spdx_id;
  }
  return {
    repository,
    repositoryUrl: `https://github.com/${repository}`,
    defaultBranch: value.default_branch,
    ...(license && license !== 'NOASSERTION' ? { license } : {}),
  };
}

async function resolveGitHubCommit(
  repository: string,
  ref: string,
  request: typeof fetch
): Promise<string> {
  const response = await request(
    `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`,
    { headers: githubHeaders(), signal: AbortSignal.timeout(15_000) }
  );
  if (!response.ok) throw new Error(`GitHub commit lookup failed: HTTP ${response.status}`);
  const value = (await response.json()) as unknown;
  if (!isRecord(value) || typeof value.sha !== 'string' || !COMMIT_PATTERN.test(value.sha)) {
    throw new Error('GitHub repository returned an invalid commit SHA');
  }
  return value.sha;
}

function githubHeaders(): Record<string, string> {
  return { Accept: 'application/vnd.github+json', 'User-Agent': 'xangi' };
}

async function downloadBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: githubHeaders(),
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`Extension repository download failed: HTTP ${response.status}`);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error('Extension repository download exceeds 50 MB');
  }
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
      throw new Error('Extension repository download exceeds 50 MB');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function extractExtensionTarGzip(
  artifact: Uint8Array,
  destination: string
): Promise<void> {
  const archivePath = join(
    dirname(destination),
    `.xangi-extension-${process.pid}-${Date.now()}.tgz`
  );
  try {
    await writeFile(archivePath, artifact, { mode: 0o600 });
    const state: { root?: string; hasFile: boolean } = { hasFile: false };
    await streamTarListing(archivePath, false, (line) => validateArchivePath(line, state));
    if (!state.root) throw new Error('Extension repository archive is empty');
    await streamTarListing(archivePath, true, (line) => validateArchiveType(line, state));
    if (!state.hasFile) throw new Error('Extension repository archive contains no files');
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destination, '--strip-components', '1']);
  } finally {
    await rm(archivePath, { force: true });
  }
}

export function validateExtensionTarListing(pathsOutput: string, verboseOutput: string): void {
  const paths = pathsOutput.split(/\r?\n/).filter(Boolean);
  const state: { root?: string; hasFile: boolean } = { hasFile: false };
  for (const path of paths) validateArchivePath(path, state);
  if (!state.root) throw new Error('Extension repository archive is empty');
  for (const line of verboseOutput.split(/\r?\n/).filter(Boolean)) {
    validateArchiveType(line, state);
  }
  if (!state.hasFile) throw new Error('Extension repository archive contains no files');
}

function validateArchivePath(path: string, state: { root?: string; hasFile: boolean }): void {
  const parts = path.split('/').filter(Boolean);
  if (
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.includes('\\') ||
    parts.includes('..') ||
    parts.length === 0 ||
    [...path].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  ) {
    throw new Error(`Unsafe extension repository archive path: ${path}`);
  }
  state.root ??= parts[0];
  if (parts[0] !== state.root) {
    throw new Error('Extension repository archive must contain exactly one top-level directory');
  }
  if (parts.length === 1 && !path.endsWith('/')) {
    throw new Error(`Unsafe extension repository archive path: ${path}`);
  }
}

function validateArchiveType(line: string, state: { root?: string; hasFile: boolean }): void {
  if (line.startsWith('-')) state.hasFile = true;
  else if (!line.startsWith('d')) {
    throw new Error('Extension repository archive may contain only regular files and directories');
  }
}

async function acquireLock(lockDir: string): Promise<void> {
  try {
    await mkdir(lockDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another extension repository is already being added');
    }
    throw error;
  }
}

async function writeStoreAtomic(path: string, value: RemoteExtensionSourceStore): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

function parseRemoteExtensionSource(value: unknown, dataDir: string): RemoteExtensionSource {
  if (
    !isRecord(value) ||
    typeof value.repository !== 'string' ||
    typeof value.repositoryUrl !== 'string' ||
    typeof value.commitSha !== 'string' ||
    !COMMIT_PATTERN.test(value.commitSha) ||
    typeof value.manifestPath !== 'string' ||
    typeof value.assetSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.assetSha256) ||
    typeof value.addedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.addedAt)) ||
    (value.updatedAt !== undefined &&
      (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)))) ||
    (value.license !== undefined && typeof value.license !== 'string')
  ) {
    throw new Error('invalid extension source entry');
  }
  const parsed = parsePublicGitHubRepositoryUrl(value.repositoryUrl);
  if (parsed.repository !== value.repository)
    throw new Error('extension source repository mismatch');
  const expectedManifestPath = join(
    resolve(dataDir),
    'extensions',
    'sources',
    value.repository.replace('/', '--'),
    'xangi-extension.json'
  );
  if (resolve(value.manifestPath) !== expectedManifestPath) {
    throw new Error('extension source manifest path mismatch');
  }
  return {
    repository: value.repository,
    repositoryUrl: value.repositoryUrl,
    commitSha: value.commitSha,
    manifestPath: value.manifestPath,
    assetSha256: value.assetSha256,
    addedAt: value.addedAt,
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
    ...(value.license ? { license: value.license } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
