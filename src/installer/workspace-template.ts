import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseSetupConfig } from '../setup/schema.js';
import type { AppLayout } from './types.js';

const execFileAsync = promisify(execFile);
const STATE_KEYS = [
  'schemaVersion',
  'repository',
  'commitSha',
  'appliedAt',
  'assetSha256',
] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_TEMPLATE_BYTES = 50 * 1024 * 1024;
const ALLOWED_TEMPLATE_LINKS = new Map([
  ['.agents/skills', '../skills'],
  ['.claude/skills', '../skills'],
  ['.grok/skills', '../skills'],
  ['CLAUDE.md', 'AGENTS.md'],
]);

export const DEFAULT_WORKSPACE_TEMPLATE = {
  repository: 'karaage0703/ai-assistant-workspace',
  ref: 'main',
} as const;

export interface WorkspaceTemplateState {
  schemaVersion: 1;
  repository: string;
  commitSha: string;
  appliedAt: string;
  assetSha256: string;
}

export type WorkspaceTemplateResult =
  | { status: 'installed'; repository: string; commitSha: string }
  | { status: 'skipped'; reason: 'already-applied' | 'workspace-not-empty' };

export interface WorkspaceTemplateInstallerOptions {
  workspaceDir: string;
  stateDir: string;
  /** Allow an explicit setup choice to repair a missing or empty workspace. */
  reapplyIfEmpty?: boolean;
  repository?: string;
  ref?: string;
  resolveCommit?: (repository: string, ref: string) => Promise<string>;
  download?: (url: string, maxBytes: number) => Promise<Uint8Array>;
  extract?: (artifact: Uint8Array, destination: string) => Promise<void>;
  now?: () => Date;
}

export interface ConfiguredWorkspaceTemplateResult {
  workspacePath: string;
  template: WorkspaceTemplateResult;
}

export type ConfiguredWorkspaceTemplateOptions = Omit<
  WorkspaceTemplateInstallerOptions,
  'workspaceDir' | 'stateDir'
>;

/** Installs the latest selected repository snapshot without requiring Git. */
export async function installConfiguredWorkspaceTemplate(
  layout: AppLayout,
  options: ConfiguredWorkspaceTemplateOptions = {}
): Promise<ConfiguredWorkspaceTemplateResult> {
  const setup = parseSetupConfig(JSON.parse(await readFile(layout.configFile, 'utf8')) as unknown);
  const template = await installWorkspaceTemplate({
    workspaceDir: setup.workspacePath,
    stateDir: layout.stateDir,
    ...options,
  });
  return { workspacePath: setup.workspacePath, template };
}

/**
 * Resolves the repository's latest commit at selection time and seeds an empty
 * workspace exactly once. Existing user-owned workspaces are never updated.
 */
export async function installWorkspaceTemplate(
  options: WorkspaceTemplateInstallerOptions
): Promise<WorkspaceTemplateResult> {
  const workspaceDir = resolve(options.workspaceDir);
  const stateDir = resolve(options.stateDir);
  const repository = validateRepository(
    options.repository ?? DEFAULT_WORKSPACE_TEMPLATE.repository
  );
  const ref = validateRef(options.ref ?? DEFAULT_WORKSPACE_TEMPLATE.ref);
  const statePath = join(stateDir, 'workspace-template.json');
  const lockDir = join(stateDir, 'workspace-template.lock');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await acquireLock(lockDir);

  let stagingDir: string | undefined;
  try {
    if (!(await isMissingOrEmptyDirectory(workspaceDir))) {
      return { status: 'skipped', reason: 'workspace-not-empty' };
    }
    if (!options.reapplyIfEmpty && (await hasAppliedState(statePath))) {
      return { status: 'skipped', reason: 'already-applied' };
    }

    const commitSha = await (options.resolveCommit ?? resolveGitHubCommit)(repository, ref);
    if (!COMMIT_PATTERN.test(commitSha)) {
      throw new Error('Workspace template commit SHA is invalid');
    }
    const archiveUrl = `https://github.com/${repository}/archive/${commitSha}.tar.gz`;
    const artifact = await (options.download ?? downloadBytes)(archiveUrl, MAX_TEMPLATE_BYTES);
    const assetSha256 = createHash('sha256').update(artifact).digest('hex');

    const parentDir = dirname(workspaceDir);
    await mkdir(parentDir, { recursive: true });
    stagingDir = await mkdtemp(join(parentDir, '.xangi-workspace-template-'));
    await (options.extract ?? extractWorkspaceTarGzip)(artifact, stagingDir);
    if ((await readdir(stagingDir)).length === 0) {
      throw new Error('Workspace template archive is empty');
    }

    if (await pathExists(workspaceDir)) await rmdir(workspaceDir);
    await rename(stagingDir, workspaceDir);
    stagingDir = undefined;

    await writeStateAtomic(statePath, {
      schemaVersion: 1,
      repository,
      commitSha,
      appliedAt: (options.now ?? (() => new Date()))().toISOString(),
      assetSha256,
    });
    return { status: 'installed', repository, commitSha };
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  }
}

export async function resolveGitHubCommit(repository: string, ref: string): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${validateRepository(repository)}/commits/${encodeURIComponent(validateRef(ref))}`,
    {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xangi' },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok) {
    throw new Error(`Workspace template repository lookup failed: HTTP ${response.status}`);
  }
  const value = (await response.json()) as unknown;
  if (!isRecord(value) || typeof value.sha !== 'string' || !COMMIT_PATTERN.test(value.sha)) {
    throw new Error('Workspace template repository returned an invalid commit SHA');
  }
  return value.sha;
}

export async function extractWorkspaceTarGzip(
  artifact: Uint8Array,
  destination: string
): Promise<void> {
  const archivePath = join(
    dirname(destination),
    `.xangi-workspace-${process.pid}-${Date.now()}.tgz`
  );
  try {
    await writeFile(archivePath, artifact, { mode: 0o600 });
    const listing = await execFileAsync('tar', ['-tzf', archivePath], {
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8',
    });
    const verbose = await execFileAsync('tar', ['-tvzf', archivePath], {
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8',
    });
    validateWorkspaceTarListing(listing.stdout, verbose.stdout);
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destination, '--strip-components', '1']);
  } finally {
    await rm(archivePath, { force: true });
  }
}

export function validateWorkspaceTarListing(pathsOutput: string, verboseOutput: string): void {
  const paths = pathsOutput.split(/\r?\n/).filter(Boolean);
  if (paths.length === 0) throw new Error('Workspace template archive is empty');
  let archiveRoot: string | undefined;
  let hasFile = false;
  for (const archivePath of paths) {
    const parts = archivePath.split('/').filter(Boolean);
    if (
      archivePath.startsWith('/') ||
      archivePath.startsWith('\\') ||
      archivePath.includes('\\') ||
      [...archivePath].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      }) ||
      parts.includes('..') ||
      parts.length === 0
    ) {
      throw new Error(`Unsafe workspace template archive path: ${archivePath}`);
    }
    archiveRoot ??= parts[0];
    if (parts[0] !== archiveRoot) {
      throw new Error('Workspace template archive must contain exactly one top-level directory');
    }
    if (parts.length === 1 && !archivePath.endsWith('/')) {
      throw new Error(`Unsafe workspace template archive path: ${archivePath}`);
    }
  }
  for (const line of verboseOutput.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith('-')) hasFile = true;
    else if (line.startsWith('l')) {
      if (!archiveRoot || !isAllowedSkillLink(line, archiveRoot)) {
        throw new Error('Workspace template archive contains an unsafe symbolic link');
      }
    } else if (!line.startsWith('d')) {
      throw new Error('Workspace template archive may contain only regular files and directories');
    }
  }
  if (!hasFile) throw new Error('Workspace template archive contains no files');
}

function isAllowedSkillLink(verboseLine: string, archiveRoot: string): boolean {
  for (const [relativePath, target] of ALLOWED_TEMPLATE_LINKS) {
    if (verboseLine.endsWith(` ${archiveRoot}/${relativePath} -> ${target}`)) return true;
  }
  return false;
}

function validateRepository(value: string): string {
  if (!REPOSITORY_PATTERN.test(value)) {
    throw new Error('Workspace template repository must use owner/name format');
  }
  return value;
}

function validateRef(value: string): string {
  if (
    !value ||
    value.length > 255 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error('Workspace template ref is invalid');
  }
  return value;
}

async function acquireLock(lockDir: string): Promise<void> {
  try {
    await mkdir(lockDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Workspace template installation is already running');
    }
    throw error;
  }
}

async function hasAppliedState(statePath: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    if (!isRecord(value) || !hasExactKeys(value, STATE_KEYS)) throw new Error('schema mismatch');
    if (
      value.schemaVersion !== 1 ||
      typeof value.repository !== 'string' ||
      !REPOSITORY_PATTERN.test(value.repository) ||
      typeof value.commitSha !== 'string' ||
      !COMMIT_PATTERN.test(value.commitSha) ||
      typeof value.appliedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.appliedAt)) ||
      typeof value.assetSha256 !== 'string' ||
      !SHA256_PATTERN.test(value.assetSha256)
    ) {
      throw new Error('invalid fields');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(
      `Invalid workspace template state ${statePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function isMissingOrEmptyDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && (await readdir(path)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writeStateAtomic(path: string, state: WorkspaceTemplateState): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function downloadBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Workspace template download failed: HTTP ${response.status}`);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error('Workspace template download exceeds size limit');
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
      throw new Error('Workspace template download exceeds size limit');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}
