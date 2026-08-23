import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const REGISTRY_VERSION = 1;
const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_WORKSPACE_NAME = 'default';
const REGISTRY_FILE = 'workspaces.json';

export interface WorkspaceEntry {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
}

export interface WorkspaceRegistryOptions {
  dataDir: string;
  defaultWorkspacePath: string;
  allowedRoots?: string[];
}

interface PersistedWorkspace {
  id: string;
  name: string;
  path: string;
}

interface PersistedRegistry {
  version: 1;
  defaultWorkspaceId: string;
  workspaces: PersistedWorkspace[];
  bindings: Record<string, Record<string, string>>;
}

/**
 * Persistent registry for selectable workspaces and platform-scoped channel bindings.
 *
 * Use {@link WorkspaceRegistry.open}; opening performs the asynchronous path safety
 * checks and guarantees that the default workspace is present.
 */
export class WorkspaceRegistry {
  readonly dataDir: string;
  readonly registryPath: string;

  private readonly canonicalDataDir: string;
  private readonly allowedRoots: string[];
  private state: PersistedRegistry;
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    dataDir: string,
    canonicalDataDir: string,
    allowedRoots: string[],
    state: PersistedRegistry
  ) {
    this.dataDir = dataDir;
    this.registryPath = join(dataDir, REGISTRY_FILE);
    this.canonicalDataDir = canonicalDataDir;
    this.allowedRoots = allowedRoots;
    this.state = state;
  }

  static async open(options: WorkspaceRegistryOptions): Promise<WorkspaceRegistry> {
    if (!isAbsolute(options.dataDir)) {
      throw new Error('DATA_DIR must be an absolute path');
    }

    await mkdir(options.dataDir, { recursive: true });
    const canonicalDataDir = await realpath(options.dataDir);
    const canonicalDefault = await validateDirectory(options.defaultWorkspacePath, false);
    const optionalRoots: string[] = [];
    for (const root of options.allowedRoots ?? []) {
      try {
        optionalRoots.push(await validateDirectory(root, false));
      } catch (error) {
        console.warn(
          `[xangi] Ignoring unavailable workspace root ${root}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    // 未設定なら任意の既存絶対pathを登録可能。明示時だけdefault＋指定rootへ制限する。
    const canonicalRoots = options.allowedRoots
      ? [...new Set([canonicalDefault, ...optionalRoots])]
      : [];

    assertAllowedWorkspace(canonicalDefault, canonicalRoots, canonicalDataDir);

    const registryPath = join(canonicalDataDir, REGISTRY_FILE);
    let state: PersistedRegistry;
    let needsSave = false;
    try {
      state = parseRegistry(await readFile(registryPath, 'utf8'));
      validateBindings(state);
      validateDefaultEntryShape(state);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        state = emptyRegistry();
        needsSave = true;
      } else if (isRegistryFormatError(error)) {
        const quarantinePath = `${registryPath}.corrupt-${Date.now()}`;
        await rename(registryPath, quarantinePath);
        console.warn(`[workspace-registry] Invalid registry moved to ${quarantinePath}`);
        state = emptyRegistry();
        needsSave = true;
      } else {
        throw error;
      }
    }

    const defaultById = state.workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID);
    const defaultByName = state.workspaces.find(
      (workspace) => workspace.name === DEFAULT_WORKSPACE_NAME
    );
    const existingDefault = defaultById ?? defaultByName;
    if (existingDefault) {
      if (
        existingDefault.id !== DEFAULT_WORKSPACE_ID ||
        existingDefault.name !== DEFAULT_WORKSPACE_NAME
      ) {
        throw new Error('Default workspace entry has an invalid ID or name');
      }
      if (existingDefault.path !== canonicalDefault) {
        // The startup WORKSPACE_PATH remains the authority for the default.
        // Historical sessions keep their own workspacePath snapshots.
        existingDefault.path = canonicalDefault;
        needsSave = true;
      }
    } else {
      state.workspaces.unshift({
        id: DEFAULT_WORKSPACE_ID,
        name: DEFAULT_WORKSPACE_NAME,
        path: canonicalDefault,
      });
      needsSave = true;
    }
    if (state.defaultWorkspaceId !== DEFAULT_WORKSPACE_ID) {
      state.defaultWorkspaceId = DEFAULT_WORKSPACE_ID;
      needsSave = true;
    }

    const registry = new WorkspaceRegistry(
      canonicalDataDir,
      canonicalDataDir,
      canonicalRoots,
      state
    );
    if (needsSave) await registry.persist();
    return registry;
  }

  list(): WorkspaceEntry[] {
    return this.state.workspaces.map((workspace) => this.toEntry(workspace));
  }

  /** Metadata lookup only. Use resolveById before using an entry path for I/O. */
  getById(id: string): WorkspaceEntry | undefined {
    const workspace = this.state.workspaces.find((candidate) => candidate.id === id);
    return workspace ? this.toEntry(workspace) : undefined;
  }

  /** Metadata lookup only. Use resolveById before using an entry path for I/O. */
  getByName(name: string): WorkspaceEntry | undefined {
    const normalizedName = normalizeName(name);
    const workspace = this.state.workspaces.find((candidate) => candidate.name === normalizedName);
    return workspace ? this.toEntry(workspace) : undefined;
  }

  async register(name: string, workspacePath: string): Promise<WorkspaceEntry> {
    return this.mutate(async () => {
      const normalizedName = normalizeName(name);
      const canonicalPath = await validateDirectory(workspacePath);
      assertAllowedWorkspace(canonicalPath, this.allowedRoots, this.canonicalDataDir);

      const existing = this.state.workspaces.find((workspace) => workspace.name === normalizedName);
      if (existing) {
        if (existing.path !== canonicalPath) {
          throw new Error(
            `Workspace name "${normalizedName}" is already registered with a different path`
          );
        }
        return this.toEntry(existing);
      }

      const workspace: PersistedWorkspace = {
        id: randomUUID(),
        name: normalizedName,
        path: canonicalPath,
      };
      this.state.workspaces.push(workspace);
      await this.persist();
      return this.toEntry(workspace);
    });
  }

  /**
   * Remove a workspace from the registry without touching its directory.
   * Callers must separately reject references owned by other stores, such as
   * Web Projects and sessions. Platform channel bindings are guarded here.
   */
  async unregister(workspaceId: string): Promise<WorkspaceEntry> {
    return this.mutate(async () => {
      const workspace = this.state.workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) throw new Error('Workspace not found');
      if (workspace.id === this.state.defaultWorkspaceId) {
        throw new Error('Default workspace cannot be unregistered');
      }
      const bound = Object.values(this.state.bindings).some((bindings) =>
        Object.values(bindings).includes(workspace.id)
      );
      if (bound) throw new Error('Workspace is used by a channel binding');

      this.state.workspaces = this.state.workspaces.filter(
        (candidate) => candidate.id !== workspace.id
      );
      await this.persist();
      return this.toEntry(workspace);
    });
  }

  async bind(platform: string, channelId: string, workspaceId: string): Promise<WorkspaceEntry> {
    return this.mutate(async () => {
      const normalizedPlatform = normalizeNamespace(platform, 'platform');
      const normalizedChannel = normalizeNamespace(channelId, 'channel ID');
      const resolvedWorkspace = await this.resolveById(workspaceId);
      const workspace = this.state.workspaces.find(
        (candidate) => candidate.id === resolvedWorkspace.id
      )!;
      const platformBindings = (this.state.bindings[normalizedPlatform] ??= Object.create(
        null
      ) as Record<string, string>);
      if (platformBindings[normalizedChannel] !== workspace.id) {
        platformBindings[normalizedChannel] = workspace.id;
        await this.persist();
      }
      return this.toEntry(workspace);
    });
  }

  getBinding(platform: string, channelId: string): string | undefined {
    const normalizedPlatform = normalizeNamespace(platform, 'platform');
    const normalizedChannel = normalizeNamespace(channelId, 'channel ID');
    return this.state.bindings[normalizedPlatform]?.[normalizedChannel];
  }

  async resetBinding(platform: string, channelId: string): Promise<boolean> {
    return this.mutate(async () => {
      const normalizedPlatform = normalizeNamespace(platform, 'platform');
      const normalizedChannel = normalizeNamespace(channelId, 'channel ID');
      const platformBindings = this.state.bindings[normalizedPlatform];
      if (!platformBindings || !(normalizedChannel in platformBindings)) return false;

      delete platformBindings[normalizedChannel];
      if (Object.keys(platformBindings).length === 0) {
        delete this.state.bindings[normalizedPlatform];
      }
      await this.persist();
      return true;
    });
  }

  async resolve(platform: string, channelId: string): Promise<WorkspaceEntry> {
    const workspaceId = this.getBinding(platform, channelId) ?? this.state.defaultWorkspaceId;
    return this.resolveById(workspaceId);
  }

  async resolveById(workspaceId: string): Promise<WorkspaceEntry> {
    const workspace = this.state.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`Binding refers to an unknown workspace ID: ${workspaceId}`);
    await this.revalidate(workspace);
    return this.toEntry(workspace);
  }

  async resolveSnapshot(workspaceId: string, snapshotPath: string): Promise<WorkspaceEntry> {
    const workspace = await this.resolveById(workspaceId);
    let canonicalPath: string;
    try {
      canonicalPath = await validateDirectory(snapshotPath, false);
      assertAllowedWorkspace(canonicalPath, this.allowedRoots, this.canonicalDataDir);
    } catch (error) {
      throw new Error(
        `Saved workspace is no longer available or allowed. Start a new session with /new. ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return { ...workspace, path: canonicalPath };
  }

  private async revalidate(workspace: PersistedWorkspace): Promise<void> {
    const canonicalPath = await validateDirectory(workspace.path);
    if (canonicalPath !== workspace.path) {
      throw new Error(`Workspace path changed since registration: ${workspace.path}`);
    }
    assertAllowedWorkspace(canonicalPath, this.allowedRoots, this.canonicalDataDir);
  }

  private toEntry(workspace: PersistedWorkspace): WorkspaceEntry {
    return {
      ...workspace,
      isDefault: workspace.id === this.state.defaultWorkspaceId,
    };
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.mutationQueue;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = structuredClone(this.state);
    try {
      return await operation();
    } catch (error) {
      this.state = snapshot;
      throw error;
    } finally {
      release();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true });
    const temporary = join(
      dirname(this.registryPath),
      `.${basename(this.registryPath)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
    );
    try {
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, this.registryPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function validateDirectory(rawPath: string, requireWritable = true): Promise<string> {
  if (!isAbsolute(rawPath)) {
    throw new Error(`Workspace path must be absolute: ${rawPath}`);
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(rawPath);
    const details = await stat(canonicalPath);
    if (!details.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${rawPath}`);
    }
    const requiredAccess = constants.R_OK | constants.X_OK | (requireWritable ? constants.W_OK : 0);
    await access(canonicalPath, requiredAccess);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workspace path is not')) {
      throw error;
    }
    throw new Error(
      `Workspace path must be an existing ${
        requireWritable ? 'readable, writable, and traversable' : 'readable and traversable'
      } directory: ${rawPath}`,
      {
        cause: error,
      }
    );
  }
  return canonicalPath;
}

function assertAllowedWorkspace(
  workspacePath: string,
  allowedRoots: string[],
  canonicalDataDir: string
): void {
  if (allowedRoots.length > 0 && !allowedRoots.some((root) => containsPath(root, workspacePath))) {
    throw new Error(`Workspace path is outside the allowed roots: ${workspacePath}`);
  }
  if (containsPath(canonicalDataDir, workspacePath)) {
    throw new Error(
      `Workspace path must not be DATA_DIR or one of its descendants: ${workspacePath}`
    );
  }
}

function containsPath(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error('Workspace name must not be empty');
  if (
    Array.from(normalized).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error('Workspace name must not contain control characters');
  }
  return normalized;
}

function normalizeNamespace(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Workspace ${label} must not be empty`);
  if (['__proto__', 'constructor', 'prototype'].includes(normalized)) {
    throw new Error(`Workspace ${label} is reserved`);
  }
  return normalized;
}

function emptyRegistry(): PersistedRegistry {
  return {
    version: REGISTRY_VERSION,
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    workspaces: [],
    bindings: Object.create(null) as Record<string, Record<string, string>>,
  };
}

function parseRegistry(raw: string): PersistedRegistry {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid workspace registry');
  }
  const candidate = value as Partial<PersistedRegistry>;
  if (
    candidate.version !== REGISTRY_VERSION ||
    typeof candidate.defaultWorkspaceId !== 'string' ||
    !Array.isArray(candidate.workspaces) ||
    !candidate.bindings ||
    typeof candidate.bindings !== 'object' ||
    Array.isArray(candidate.bindings)
  ) {
    throw new Error('Invalid workspace registry');
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  const workspaces = candidate.workspaces.map((workspace) => {
    if (
      !workspace ||
      typeof workspace !== 'object' ||
      typeof workspace.id !== 'string' ||
      !workspace.id ||
      typeof workspace.name !== 'string' ||
      !workspace.name ||
      typeof workspace.path !== 'string'
    ) {
      throw new Error('Invalid workspace registry entry');
    }
    const name = normalizeName(workspace.name);
    if (ids.has(workspace.id) || names.has(name)) {
      throw new Error('Workspace registry contains duplicate IDs or names');
    }
    ids.add(workspace.id);
    names.add(name);
    return { id: workspace.id, name, path: workspace.path };
  });

  const bindings = Object.create(null) as Record<string, Record<string, string>>;
  for (const [platform, rawBindings] of Object.entries(candidate.bindings)) {
    const normalizedPlatform = normalizeNamespace(platform, 'platform');
    if (!rawBindings || typeof rawBindings !== 'object' || Array.isArray(rawBindings)) {
      throw new Error('Invalid workspace channel bindings');
    }
    bindings[normalizedPlatform] = Object.create(null) as Record<string, string>;
    for (const [channel, workspaceId] of Object.entries(rawBindings)) {
      const normalizedChannel = normalizeNamespace(channel, 'channel ID');
      if (typeof workspaceId !== 'string') {
        throw new Error('Invalid workspace channel binding');
      }
      bindings[normalizedPlatform][normalizedChannel] = workspaceId;
    }
  }

  return {
    version: REGISTRY_VERSION,
    defaultWorkspaceId: candidate.defaultWorkspaceId,
    workspaces,
    bindings,
  };
}

function validateBindings(state: PersistedRegistry): void {
  const workspaceIds = new Set(state.workspaces.map((workspace) => workspace.id));
  for (const bindings of Object.values(state.bindings)) {
    for (const workspaceId of Object.values(bindings)) {
      if (!workspaceIds.has(workspaceId)) {
        throw new Error(`Workspace binding refers to an unknown workspace ID: ${workspaceId}`);
      }
    }
  }
}

function validateDefaultEntryShape(state: PersistedRegistry): void {
  const defaultById = state.workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID);
  const defaultByName = state.workspaces.find(
    (workspace) => workspace.name === DEFAULT_WORKSPACE_NAME
  );
  if (
    (defaultById && defaultById.name !== DEFAULT_WORKSPACE_NAME) ||
    (defaultByName && defaultByName.id !== DEFAULT_WORKSPACE_ID)
  ) {
    throw new Error('Invalid workspace registry default entry');
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRegistryFormatError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      (error.message.startsWith('Invalid workspace') ||
        error.message.startsWith('Workspace name') ||
        error.message.startsWith('Workspace platform') ||
        error.message.startsWith('Workspace channel ID') ||
        error.message.startsWith('Workspace registry contains') ||
        error.message.startsWith('Workspace binding refers')))
  );
}
