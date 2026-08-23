import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

const fixtures: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xangi-workspace-registry-'));
  fixtures.push(root);
  const dataDir = join(root, 'state');
  const allowedRoot = join(root, 'workspaces');
  const defaultWorkspace = join(allowedRoot, 'default');
  await mkdir(defaultWorkspace, { recursive: true });
  return { root, dataDir, allowedRoot, defaultWorkspace };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('WorkspaceRegistry', () => {
  it('registers an arbitrary existing absolute path when allowed roots are not configured', async () => {
    const { root, dataDir, defaultWorkspace } = await fixture();
    const sibling = join(root, 'sibling-repository');
    await mkdir(sibling);
    const registry = await WorkspaceRegistry.open({ dataDir, defaultWorkspacePath: defaultWorkspace });

    const registered = await registry.register('sibling', sibling);

    expect(registered.path).toBe(await realpath(sibling));
    await expect(registry.resolveById(registered.id)).resolves.toEqual(registered);
  });

  it('atomically persists a deterministic default workspace entry', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });

    expect(registry.list()).toEqual([
      {
        id: 'default',
        name: 'default',
        path: await realpath(defaultWorkspace),
        isDefault: true,
      },
    ]);
    const persisted = JSON.parse(await readFile(join(dataDir, 'workspaces.json'), 'utf8'));
    expect(persisted.workspaces[0]).toMatchObject({ id: 'default', name: 'default' });
    await expect(access(join(dataDir, 'workspaces.json'), constants.R_OK)).resolves.toBeUndefined();
  });

  it('registers canonical paths idempotently and preserves stable IDs after reopen', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const target = join(allowedRoot, 'project');
    const alias = join(allowedRoot, 'project-link');
    await mkdir(target);
    await symlink(target, alias);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });

    const first = await registry.register('project', alias);
    const second = await registry.register('project', target);
    expect(second).toEqual(first);
    expect(first.path).toBe(await realpath(target));
    expect(first.id).not.toBe('default');

    const reopened = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });
    expect(reopened.getByName('project')).toEqual(first);
    expect(reopened.getById(first.id)).toEqual(first);
  });

  it('always allows the configured default even when extra roots omit it', async () => {
    const { root, dataDir, defaultWorkspace } = await fixture();
    const extraRoot = join(root, 'extra');
    await mkdir(extraRoot);

    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [extraRoot],
    });

    expect(registry.getById('default')?.path).toBe(await realpath(defaultWorkspace));
  });

  it('ignores unavailable optional roots without preventing startup', async () => {
    const { root, dataDir, defaultWorkspace } = await fixture();
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [join(root, 'not-mounted')],
    });

    expect(registry.list()).toHaveLength(1);
    expect(registry.getById('default')?.path).toBe(await realpath(defaultWorkspace));
  });

  it('updates the default entry when startup WORKSPACE_PATH changes', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const nextDefault = join(allowedRoot, 'next-default');
    await mkdir(nextDefault);
    await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });

    const reopened = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: nextDefault,
      allowedRoots: [allowedRoot],
    });

    expect(reopened.getById('default')).toMatchObject({
      id: 'default',
      path: await realpath(nextDefault),
      isDefault: true,
    });
  });

  it('quarantines a corrupt registry and recreates the default entry', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'workspaces.json'), '{broken');

    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });

    expect(registry.list()).toHaveLength(1);
    expect(
      (await readdir(dataDir)).some((name) => name.startsWith('workspaces.json.corrupt-'))
    ).toBe(true);
  });

  it('rejects reuse of a name for a different canonical path', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const first = join(allowedRoot, 'one');
    const second = join(allowedRoot, 'two');
    await Promise.all([mkdir(first), mkdir(second)]);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });
    await registry.register('project', first);

    await expect(registry.register('project', second)).rejects.toThrow(/different path/);
  });

  it('requires an absolute, existing directory within an allowed root', async () => {
    const { root, dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });
    const file = join(allowedRoot, 'file.txt');
    const outside = join(root, 'outside');
    await writeFile(file, 'not a directory');
    await mkdir(outside);

    await expect(registry.register('relative', 'relative/path')).rejects.toThrow(/absolute/);
    await expect(registry.register('missing', join(allowedRoot, 'missing'))).rejects.toThrow(
      /existing readable, writable, and traversable/
    );
    await expect(registry.register('file', file)).rejects.toThrow(/not a directory/);
    await expect(registry.register('outside', outside)).rejects.toThrow(
      /outside the allowed roots/
    );
  });

  it('quarantines registry namespaces that would pollute object prototypes', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        defaultWorkspaceId: 'default',
        workspaces: [{ id: 'default', name: 'default', path: defaultWorkspace }],
        bindings: JSON.parse('{"__proto__":{"channel":"default"}}'),
      })
    );

    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });

    expect(registry.list()).toHaveLength(1);
    expect(Object.getPrototypeOf(registry.getById('default'))).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>).channel).toBeUndefined();
  });

  it('rejects DATA_DIR and descendants, including through symlinks', async () => {
    const { root, dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const broadRoot = root;
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [broadRoot],
    });
    const dataChild = join(dataDir, 'child');
    const dataAlias = join(allowedRoot, 'state-link');
    await mkdir(dataChild);
    await symlink(dataChild, dataAlias);

    await expect(registry.register('state', dataDir)).rejects.toThrow(/DATA_DIR/);
    await expect(registry.register('state-child', dataChild)).rejects.toThrow(/DATA_DIR/);
    await expect(registry.register('state-alias', dataAlias)).rejects.toThrow(/DATA_DIR/);
  });

  it('namespaces bindings by platform and resets them independently', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const projectPath = join(allowedRoot, 'project');
    await mkdir(projectPath);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });
    const project = await registry.register('project', projectPath);

    await registry.bind('discord', 'channel-1', project.id);
    expect(registry.getBinding('discord', 'channel-1')).toBe(project.id);
    expect(registry.getBinding('slack', 'channel-1')).toBeUndefined();
    await expect(registry.resolve('discord', 'channel-1')).resolves.toEqual(project);
    await expect(registry.resolve('slack', 'channel-1')).resolves.toMatchObject({
      id: 'default',
    });
    await expect(registry.resetBinding('slack', 'channel-1')).resolves.toBe(false);
    await expect(registry.resetBinding('discord', 'channel-1')).resolves.toBe(true);
    expect(registry.getBinding('discord', 'channel-1')).toBeUndefined();
  });

  it('unregisters an unused workspace without deleting its directory', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const projectPath = join(allowedRoot, 'project');
    await mkdir(projectPath);
    await writeFile(join(projectPath, 'keep.txt'), 'keep');
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });
    const project = await registry.register('project', projectPath);

    await expect(registry.unregister(project.id)).resolves.toEqual(project);

    expect(registry.getById(project.id)).toBeUndefined();
    await expect(readFile(join(projectPath, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    const reopened = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });
    expect(reopened.getById(project.id)).toBeUndefined();
  });

  it('rejects unregistering the default workspace or a workspace used by a binding', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const projectPath = join(allowedRoot, 'project');
    await mkdir(projectPath);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });
    const project = await registry.register('project', projectPath);
    await registry.bind('discord', 'channel-1', project.id);

    await expect(registry.unregister('default')).rejects.toThrow(/Default workspace/);
    await expect(registry.unregister(project.id)).rejects.toThrow(/channel binding/);
    expect(registry.getById(project.id)).toEqual(project);
  });

  it('rejects prototype-polluting platform and channel namespaces', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });

    await expect(registry.bind('__proto__', 'channel', 'default')).rejects.toThrow(/reserved/);
    await expect(registry.bind('discord', '__proto__', 'default')).rejects.toThrow(/reserved/);
    expect((Object.prototype as Record<string, unknown>).channel).toBeUndefined();
  });

  it('revalidates a workspace every time it is resolved', async () => {
    const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const projectPath = join(allowedRoot, 'project');
    await mkdir(projectPath);
    const registry = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });
    const project = await registry.register('project', projectPath);
    await registry.bind('discord', 'channel', project.id);
    await rm(projectPath, { recursive: true });

    await expect(registry.resolve('discord', 'channel')).rejects.toThrow(
      /existing readable, writable, and traversable/
    );

    const reopened = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });
    await expect(reopened.resolve('discord', 'channel')).rejects.toThrow(
      /existing readable, writable, and traversable/
    );
  });

  it('does not expose a tampered persisted path for execution', async () => {
    const { root, dataDir, allowedRoot, defaultWorkspace } = await fixture();
    const registryPath = join(dataDir, 'workspaces.json');
    await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });
    const persisted = JSON.parse(await readFile(registryPath, 'utf8'));
    persisted.workspaces.push({
      id: 'tampered',
      name: 'tampered',
      path: root,
    });
    await writeFile(registryPath, `${JSON.stringify(persisted)}\n`);

    const reopened = await WorkspaceRegistry.open({
      dataDir,
      defaultWorkspacePath: defaultWorkspace,
      allowedRoots: [allowedRoot],
    });

    // Metadata remains listable so a temporarily unavailable workspace does not
    // brick startup, but execution always goes through the validating resolver.
    expect(reopened.getById('tampered')?.path).toBe(root);
    await expect(reopened.resolveById('tampered')).rejects.toThrow(/outside the allowed roots/);
  });

  it.runIf(process.getuid?.() !== 0)(
    'rejects a directory that is not readable, writable, and traversable',
    async () => {
      const { dataDir, allowedRoot, defaultWorkspace } = await fixture();
      const inaccessible = join(allowedRoot, 'inaccessible');
      await mkdir(inaccessible);
      await chmod(inaccessible, 0o000);
      const registry = await WorkspaceRegistry.open({
        dataDir,
        defaultWorkspacePath: defaultWorkspace,
        allowedRoots: [allowedRoot],
      });

      await expect(registry.register('inaccessible', inaccessible)).rejects.toThrow(
        /readable, writable, and traversable/
      );
    }
  );
});
