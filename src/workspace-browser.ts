import { createHash, randomUUID } from 'crypto';
import { lstat, open, readFile, readdir, realpath, rename, stat, unlink } from 'fs/promises';
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
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
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
  type: 'directory' | 'file';
  size?: number;
  mtimeMs: number;
  tags?: string[];
}

export interface WorkspaceDirectory {
  path: string;
  parent: string | null;
  entries: WorkspaceEntry[];
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

  constructor(
    root: string,
    private readonly maxFileBytes = DEFAULT_MAX_FILE_BYTES
  ) {
    this.root = resolve(root);
  }

  async list(directory = ''): Promise<WorkspaceDirectory> {
    const normalized = normalizeRelativePath(directory, true);
    const target = await this.resolveExisting(normalized, 'directory');
    const entries = await readdir(target, { withFileTypes: true });
    const visible: WorkspaceEntry[] = [];

    for (const entry of entries) {
      if (isExcludedSegment(entry.name) || entry.isSymbolicLink()) continue;
      const childRelative = normalized ? `${normalized}/${entry.name}` : entry.name;
      const childAbsolute = join(target, entry.name);

      if (entry.isDirectory()) {
        const childStat = await stat(childAbsolute);
        visible.push({
          name: entry.name,
          path: childRelative,
          type: 'directory',
          mtimeMs: childStat.mtimeMs,
        });
      } else if (entry.isFile() && isViewableFile(entry.name)) {
        const childStat = await stat(childAbsolute);
        if (childStat.size > this.maxFileBytes) continue;
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
    }

    visible.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

    const parentSeparator = normalized.lastIndexOf('/');
    return {
      path: normalized,
      parent:
        normalized === '' ? null : parentSeparator < 0 ? '' : normalized.slice(0, parentSeparator),
      entries: visible,
    };
  }

  async read(filePath: string): Promise<WorkspaceFile> {
    const normalized = normalizeRelativePath(filePath);
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

    const normalized = normalizeRelativePath(filePath);
    const target = await this.resolveExisting(normalized, 'file');
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
  }

  private async resolveExisting(
    relativePath: string,
    expected: 'directory' | 'file'
  ): Promise<string> {
    const rootRealPath = await this.getRootRealPath();
    let current = rootRealPath;

    for (const segment of relativePath ? relativePath.split('/') : []) {
      current = join(current, segment);
      let currentStat;
      try {
        currentStat = await lstat(current);
      } catch {
        throw new WorkspaceBrowserError('Workspace path was not found', 404);
      }
      if (currentStat.isSymbolicLink()) {
        throw new WorkspaceBrowserError(
          'Symbolic links are not available in the workspace UI',
          403
        );
      }
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
}

async function readMarkdownTags(filePath: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
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
