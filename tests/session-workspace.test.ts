import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureSessionWithWorkspace } from '../src/session-workspace.js';
import {
  clearSessions,
  deleteSession,
  ensureSession,
  getSessionEntry,
  initSessions,
} from '../src/sessions.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

const fixtures: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xangi-session-workspace-'));
  fixtures.push(root);
  const dataDir = join(root, 'state');
  const allowedRoot = join(root, 'workspaces');
  const defaultWorkspace = join(allowedRoot, 'default');
  const projectWorkspace = join(allowedRoot, 'project');
  await Promise.all([
    mkdir(defaultWorkspace, { recursive: true }),
    mkdir(projectWorkspace, { recursive: true }),
  ]);
  initSessions(dataDir);
  const registry = await WorkspaceRegistry.open({
    dataDir,
    defaultWorkspacePath: defaultWorkspace,
    allowedRoots: [allowedRoot],
  });
  const project = await registry.register('project', projectWorkspace);
  return { registry, project, dataDir };
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearSessions();
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ensureSessionWithWorkspace', () => {
  it('snapshots the current channel binding only for a new session', async () => {
    const { registry, project } = await fixture();
    await registry.bind('discord', 'parent', project.id);

    const first = await ensureSessionWithWorkspace({
      registry,
      platform: 'discord',
      contextKey: 'thread',
      bindingKey: 'parent',
    });
    await registry.resetBinding('discord', 'parent');
    const existing = await ensureSessionWithWorkspace({
      registry,
      platform: 'discord',
      contextKey: 'thread',
      bindingKey: 'parent',
    });

    expect(existing).toEqual(first);
    expect(getSessionEntry(first.appSessionId)).toMatchObject({
      workspaceId: project.id,
      workspacePath: project.path,
    });

    deleteSession('thread');
    const next = await ensureSessionWithWorkspace({
      registry,
      platform: 'discord',
      contextKey: 'thread',
      bindingKey: 'parent',
    });
    expect(next.workspace?.id).toBe('default');
  });

  it('treats pre-workspace sessions as default sessions', async () => {
    const { registry } = await fixture();
    const legacy = await ensureSessionWithWorkspace({
      platform: 'slack',
      contextKey: 'channel',
      bindingKey: 'channel',
    });

    const resolved = await ensureSessionWithWorkspace({
      registry,
      platform: 'slack',
      contextKey: 'channel',
      bindingKey: 'channel',
    });

    expect(resolved.appSessionId).toBe(legacy.appSessionId);
    expect(resolved.workspace?.id).toBe('default');
  });

  it('keeps the stored path when the registry path changes later', async () => {
    const { registry, project } = await fixture();
    const historicalPath = join(project.path, 'historical');
    await mkdir(historicalPath, { recursive: true });
    ensureSession('moved', {
      platform: 'discord',
      workspaceId: project.id,
      workspacePath: historicalPath,
    });

    const resolved = await ensureSessionWithWorkspace({
      registry,
      platform: 'discord',
      contextKey: 'moved',
      bindingKey: 'parent',
    });

    expect(resolved.workspace).toMatchObject({
      id: project.id,
      name: project.name,
      path: historicalPath,
    });
  });

  it('rejects a stored path that is outside the current allowed roots', async () => {
    const { registry, project } = await fixture();
    ensureSession('tampered', {
      platform: 'discord',
      workspaceId: project.id,
      workspacePath: '/etc',
    });

    await expect(
      ensureSessionWithWorkspace({
        registry,
        platform: 'discord',
        contextKey: 'tampered',
        bindingKey: 'parent',
      })
    ).rejects.toThrow('Start a new session with /new');
  });

  it('returns the persisted snapshot when another turn creates the session concurrently', async () => {
    const { registry, project } = await fixture();
    const otherPath = join(project.path, '..', 'other');
    await mkdir(otherPath, { recursive: true });
    const other = await registry.register('other', otherPath);
    vi.spyOn(registry, 'resolve').mockImplementationOnce(async () => {
      ensureSession('race', {
        platform: 'discord',
        workspaceId: other.id,
        workspacePath: other.path,
      });
      return project;
    });

    const resolved = await ensureSessionWithWorkspace({
      registry,
      platform: 'discord',
      contextKey: 'race',
      bindingKey: 'parent',
    });

    expect(resolved.workspace).toEqual(other);
    expect(getSessionEntry(resolved.appSessionId)).toMatchObject({
      workspaceId: other.id,
      workspacePath: other.path,
    });
  });
});
