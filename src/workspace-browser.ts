import { withPathMutation } from './path-mutation.js';
import { createHash, randomUUID } from 'crypto';
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  stat,
  unlink,
} from 'fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { parse as parseYaml } from 'yaml';

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.xangi',
  '.workspace_rag',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'coverage',
]);
const VIEWABLE_EXTENSIONS = new Set([
  '.astro',
  '.c',
  '.cc',
  '.cfg',
  '.cjs',
  '.cpp',
  '.css',
  '.csv',
  '.cts',
  '.cxx',
  '.diff',
  '.go',
  '.h',
  '.hh',
  '.html',
  '.hpp',
  '.hxx',
  '.inl',
  '.ipp',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.less',
  '.log',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.patch',
  '.py',
  '.rs',
  '.sass',
  '.scss',
  '.sh',
  '.svelte',
  '.toml',
  '.ts',
  '.tsv',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);
const VIEWABLE_BASENAMES = new Set([
  'AGENTS.md',
  'BOOTSTRAP.md',
  'CHANGELOG',
  'CHANGELOG.md',
  'CHARACTER.md',
  'CLAUDE.md',
  'CODEOWNERS',
  'CONTRIBUTING',
  'CONTRIBUTING.md',
  'Dockerfile',
  'LICENSE',
  'LICENSE.md',
  'Makefile',
  'MEMORY.md',
  'NOTICE',
  'Procfile',
  'README',
  'README.md',
  'USER.md',
]);

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'symlink';
  linkTarget?: string;
  linkState?: 'internal' | 'external' | 'broken' | 'loop' | 'unavailable';
  targetType?: 'directory' | 'file';
  size?: number;
  mtimeMs: number;
  tags?: string[];
}

export interface WorkspaceDirectory {
  path: string;
  parent: string | null;
  entries: WorkspaceEntry[];
  excludedDirectoryCount: number;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  version: string;
  size: number;
  mtimeMs: number;
}

export class WorkspaceBrowserError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'WorkspaceBrowserError';
  }
}

export class WorkspaceBrowser {
  private readonly root: string;
  private rootRealPath?: string;
  private readonly excludedDirectoryPaths: ReadonlySet<string>;

  constructor(
    root: string,
    private readonly maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    excludedDirectoryPaths: readonly string[] = []
  ) {
    this.root = resolve(root);
    this.excludedDirectoryPaths = new Set(excludedDirectoryPaths);
  }

  async list(directory = ''): Promise<WorkspaceDirectory> {
    const normalized = this.normalizePath(directory, true);
    const target = await this.resolveExisting(normalized, 'directory');
    const entries = await readdir(target, { withFileTypes: true });
    const visible: WorkspaceEntry[] = [];
    let excludedDirectoryCount = 0;

    await mapLimited(entries, 8, async (entry) => {
      if (isExcludedSegment(entry.name)) return;
      const childRelative = normalized ? `${normalized}/${entry.name}` : entry.name;
      const childAbsolute = join(target, entry.name);

      if (entry.isSymbolicLink()) {
        const root = await this.getRootRealPath();
        const childStat = await lstat(childAbsolute);
        let destination = resolve(target, await readlink(childAbsolute));
        let linkState: WorkspaceEntry['linkState'];
        let targetType: WorkspaceEntry['targetType'];
        try {
          destination = await realpath(childAbsolute);
          linkState = isWithin(root, destination) ? 'internal' : 'external';
          if (linkState === 'internal') {
            const destinationStat = await stat(destination);
            targetType = destinationStat.isDirectory()
              ? 'directory'
              : destinationStat.isFile()
                ? 'file'
                : undefined;
            // Apply the same hidden-path and file-type rules to the resolved target.
            if (targetType) await this.resolveExisting(childRelative, targetType);
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          linkState =
            code === 'ELOOP'
              ? 'loop'
              : code === 'ENOENT' || code === 'ENOTDIR'
                ? 'broken'
                : 'unavailable';
          targetType = undefined;
        }
        if (targetType === 'directory' && this.excludedDirectoryPaths.has(childRelative)) {
          excludedDirectoryCount++;
          return;
        }
        visible.push({
          name: entry.name,
          path: childRelative,
          type: 'symlink',
          linkTarget: isWithin(root, destination)
            ? relative(root, destination) || '.'
            : destination,
          linkState,
          targetType,
          mtimeMs: childStat.mtimeMs,
        });
      } else if (entry.isDirectory()) {
        // Display preference only: direct listing, reading and writing stay available.
        if (this.excludedDirectoryPaths.has(childRelative)) {
          excludedDirectoryCount++;
          return;
        }
        const childStat = await stat(childAbsolute);
        visible.push({
          name: entry.name,
          path: childRelative,
          type: 'directory',
          mtimeMs: childStat.mtimeMs,
        });
      } else if (entry.isFile() && isViewableFile(entry.name)) {
        const childStat = await stat(childAbsolute);
        if (childStat.size > this.maxFileBytes) return;
        const tags = entry.name.toLowerCase().endsWith('.md')
          ? await readMarkdownTags(childAbsolute)
          : [];
        visible.push({
          name: entry.name,
          path: childRelative,
          type: 'file',
          size: childStat.size,
          mtimeMs: childStat.mtimeMs,
          ...(tags.length > 0 ? { tags } : {}),
        });
      }
    });

    visible.sort((left, right) => {
      const leftDirectory = left.type === 'directory' || left.targetType === 'directory';
      const rightDirectory = right.type === 'directory' || right.targetType === 'directory';
      if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

    const parentSeparator = normalized.lastIndexOf('/');
    return {
      path: normalized,
      parent:
        normalized === '' ? null : parentSeparator < 0 ? '' : normalized.slice(0, parentSeparator),
      entries: visible,
      excludedDirectoryCount,
    };
  }

  async read(filePath: string): Promise<WorkspaceFile> {
    const normalized = this.normalizePath(filePath);
    const target = await this.resolveExisting(normalized, 'file');
    const fileStat = await stat(target);
    if (fileStat.size > this.maxFileBytes) {
      throw new WorkspaceBrowserError('File is too large to open in the workspace editor', 413);
    }
    const content = await readFile(target, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes) {
      throw new WorkspaceBrowserError('File is too large to open in the workspace editor', 413);
    }
    return filePayload(normalized, content, fileStat.mtimeMs);
  }

  async write(
    filePath: string,
    content: unknown,
    expectedVersion: unknown
  ): Promise<WorkspaceFile> {
    if (typeof content !== 'string') {
      throw new WorkspaceBrowserError('content must be a string', 400);
    }
    if (typeof expectedVersion !== 'string' || !expectedVersion) {
      throw new WorkspaceBrowserError('version is required', 400);
    }
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes) {
      throw new WorkspaceBrowserError('File is too large to save in the workspace editor', 413);
    }

    const normalized = this.normalizePath(filePath);
    const target = await this.resolveExisting(normalized, 'file');
    return withPathMutation(target, async () => {
      const before = await readFile(target, 'utf8');
      if (contentVersion(before) !== expectedVersion) {
        throw new WorkspaceBrowserError(
          'This file changed after it was opened. Reload it before saving.',
          409
        );
      }

      const existingStat = await stat(target);
      const temporary = join(
        resolve(target, '..'),
        `.xangi-workspace-save-${process.pid}-${randomUUID()}`
      );
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, 'wx', existingStat.mode);
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;

        const immediatelyBeforeRename = await readFile(target, 'utf8');
        if (contentVersion(immediatelyBeforeRename) !== expectedVersion) {
          throw new WorkspaceBrowserError(
            'This file changed while it was being saved. Reload it before trying again.',
            409
          );
        }
        await rename(temporary, target);
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }

      const savedStat = await stat(target);
      return filePayload(normalized, content, savedStat.mtimeMs);
    });
  }

  private async resolveExisting(
    relativePath: string,
    expected: 'directory' | 'file'
  ): Promise<string> {
    const rootRealPath = await this.getRootRealPath();
    let current = rootRealPath;

    for (const segment of relativePath ? relativePath.split('/') : []) {
      current = join(current, segment);
      try {
        current = await realpath(current);
      } catch {
        throw new WorkspaceBrowserError('Workspace path was not found', 404);
      }
      if (!isWithin(rootRealPath, current)) {
        throw new WorkspaceBrowserError('Workspace path is outside the configured workspace', 403);
      }
      // A visible alias must not expose hidden or otherwise excluded targets.
      normalizeRelativePath(relative(rootRealPath, current), true);
    }

    let targetRealPath;
    try {
      targetRealPath = await realpath(current);
    } catch {
      throw new WorkspaceBrowserError('Workspace path was not found', 404);
    }
    if (!isWithin(rootRealPath, targetRealPath)) {
      throw new WorkspaceBrowserError('Workspace path is outside the configured workspace', 403);
    }

    const targetStat = await stat(targetRealPath);
    if (expected === 'directory' && !targetStat.isDirectory()) {
      throw new WorkspaceBrowserError('Workspace path is not a directory', 400);
    }
    if (expected === 'file') {
      if (!targetStat.isFile()) {
        throw new WorkspaceBrowserError('Workspace path is not a file', 400);
      }
      if (!isViewableFile(basename(targetRealPath))) {
        throw new WorkspaceBrowserError('This file type is not available in the workspace UI', 403);
      }
    }
    return targetRealPath;
  }

  private async getRootRealPath(): Promise<string> {
    if (!this.rootRealPath) this.rootRealPath = await realpath(this.root);
    return this.rootRealPath;
  }

  private normalizePath(value: string, allowEmpty = false): string {
    if (typeof value !== 'string') return normalizeRelativePath(value, allowEmpty);
    if (!isAbsolute(value)) return normalizeRelativePath(value, allowEmpty);
    const workspaceRelative = relative(this.root, resolve(value));
    if (workspaceRelative.startsWith('..') || isAbsolute(workspaceRelative)) {
      throw new WorkspaceBrowserError('Workspace path is outside the configured workspace', 400);
    }
    return normalizeRelativePath(workspaceRelative, allowEmpty);
  }
}

async function mapLimited<T>(
  items: T[],
  limit: number,
  visit: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await visit(items[next++]);
    })
  );
}

async function readMarkdownTags(filePath: string): Promise<string[]> {
  let content: string;
  try {
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytesRead).toString('utf8');
      // Preserve valid large frontmatter; only the common short-header case avoids the body.
      if (content.startsWith('---') && !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content)) {
        content = await readFile(filePath, 'utf8');
      }
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return [];
  try {
    const frontmatter = parseYaml(match[1]);
    const rawTags = frontmatter && typeof frontmatter === 'object' ? frontmatter.tags : undefined;
    const values = Array.isArray(rawTags) ? rawTags : typeof rawTags === 'string' ? [rawTags] : [];
    return [
      ...new Set(
        values
          .map((tag) => String(tag).trim())
          .filter(Boolean)
          .slice(0, 50)
      ),
    ];
  } catch {
    return [];
  }
}

function normalizeRelativePath(value: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) {
    throw new WorkspaceBrowserError('Invalid workspace path', 400);
  }
  if (isAbsolute(value)) {
    throw new WorkspaceBrowserError('Workspace path must be relative', 400);
  }
  const segments = value.split('/').filter((segment) => segment.length > 0);
  if (
    (!allowEmpty && segments.length === 0) ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new WorkspaceBrowserError('Invalid workspace path', 400);
  }
  if (segments.some(isExcludedSegment)) {
    throw new WorkspaceBrowserError('This workspace path is not available', 403);
  }
  return segments.join('/');
}

function isExcludedSegment(segment: string): boolean {
  return segment.startsWith('.') || EXCLUDED_SEGMENTS.has(segment);
}

function isViewableFile(name: string): boolean {
  if (isExcludedSegment(name)) return false;
  return VIEWABLE_BASENAMES.has(name) || VIEWABLE_EXTENSIONS.has(extname(name).toLowerCase());
}

function isWithin(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

function contentVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function filePayload(path: string, content: string, mtimeMs: number): WorkspaceFile {
  return {
    path,
    content,
    version: contentVersion(content),
    size: Buffer.byteLength(content, 'utf8'),
    mtimeMs,
  };
}
