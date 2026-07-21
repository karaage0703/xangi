import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAppLayout } from '../src/installer/layout.js';
import {
  DEFAULT_WORKSPACE_TEMPLATE,
  installConfiguredWorkspaceTemplate,
  installWorkspaceTemplate,
  validateWorkspaceTarListing,
} from '../src/installer/workspace-template.js';

const roots: string[] = [];
const artifact = Buffer.from('workspace archive');
const commitSha = '60dc28cac0a51ddd3268af9b772002b463885118';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xangi-workspace-template-'));
  roots.push(root);
  return { root, workspaceDir: join(root, 'workspace'), stateDir: join(root, 'state') };
}

const extract = async (_bytes: Uint8Array, destination: string) => {
  await mkdir(join(destination, 'profiles'));
  await writeFile(join(destination, 'AGENTS.md'), '# Assistant\n');
  await writeFile(join(destination, 'profiles', 'USER.md'), '# User\n');
};

const latest = async () => commitSha;

describe('Git-free workspace repository installer', () => {
  it('uses setup config workspacePath and the latest built-in repository commit', async () => {
    const { root } = await fixture();
    const layout = resolveAppLayout({ platform: 'darwin', arch: 'arm64', homeDir: root });
    const selectedWorkspace = join(root, 'my-assistant');
    await mkdir(layout.configDir, { recursive: true });
    await writeFile(
      layout.configFile,
      JSON.stringify({ backend: 'codex', workspacePath: selectedWorkspace, webChatEnabled: true })
    );
    const download = vi.fn(async () => artifact);

    await expect(
      installConfiguredWorkspaceTemplate(layout, { resolveCommit: latest, download, extract })
    ).resolves.toEqual({
      workspacePath: selectedWorkspace,
      template: {
        status: 'installed',
        repository: DEFAULT_WORKSPACE_TEMPLATE.repository,
        commitSha,
      },
    });
    expect(download).toHaveBeenCalledWith(
      `https://github.com/${DEFAULT_WORKSPACE_TEMPLATE.repository}/archive/${commitSha}.tar.gz`,
      50 * 1024 * 1024
    );
    expect(await readFile(join(selectedWorkspace, 'AGENTS.md'), 'utf8')).toBe('# Assistant\n');
  });

  it('records repository, resolved commit, archive hash, and applied time', async () => {
    const { workspaceDir, stateDir } = await fixture();
    await expect(
      installWorkspaceTemplate({
        workspaceDir,
        stateDir,
        resolveCommit: latest,
        download: async () => artifact,
        extract,
        now: () => new Date('2026-07-18T13:00:00.000Z'),
      })
    ).resolves.toEqual({
      status: 'installed',
      repository: DEFAULT_WORKSPACE_TEMPLATE.repository,
      commitSha,
    });
    expect(JSON.parse(await readFile(join(stateDir, 'workspace-template.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      repository: DEFAULT_WORKSPACE_TEMPLATE.repository,
      commitSha,
      appliedAt: '2026-07-18T13:00:00.000Z',
      assetSha256: createHash('sha256').update(artifact).digest('hex'),
    });
  });

  it('installs into an existing empty directory', async () => {
    const { workspaceDir, stateDir } = await fixture();
    await mkdir(workspaceDir);
    await expect(
      installWorkspaceTemplate({
        workspaceDir,
        stateDir,
        resolveCommit: latest,
        download: async () => artifact,
        extract,
      })
    ).resolves.toMatchObject({ status: 'installed', commitSha });
  });

  it('never resolves or downloads when the workspace already contains user files', async () => {
    const { workspaceDir, stateDir } = await fixture();
    await mkdir(workspaceDir);
    await writeFile(join(workspaceDir, 'AGENTS.md'), 'my customized assistant');
    const resolveCommit = vi.fn(latest);
    const download = vi.fn(async () => artifact);
    await expect(
      installWorkspaceTemplate({ workspaceDir, stateDir, resolveCommit, download, extract })
    ).resolves.toEqual({ status: 'skipped', reason: 'workspace-not-empty' });
    expect(resolveCommit).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('does not reapply after successful installation', async () => {
    const { workspaceDir, stateDir } = await fixture();
    const options = {
      workspaceDir,
      stateDir,
      resolveCommit: latest,
      download: async () => artifact,
      extract,
    };
    await installWorkspaceTemplate(options);
    await rm(workspaceDir, { recursive: true });
    await expect(installWorkspaceTemplate(options)).resolves.toEqual({
      status: 'skipped',
      reason: 'already-applied',
    });
  });

  it('reapplies after an explicit setup choice when the workspace is missing or empty', async () => {
    const { workspaceDir, stateDir } = await fixture();
    const resolveCommit = vi.fn(latest);
    const download = vi.fn(async () => artifact);
    const options = { workspaceDir, stateDir, resolveCommit, download, extract };
    await installWorkspaceTemplate(options);
    await rm(workspaceDir, { recursive: true });

    await expect(
      installWorkspaceTemplate({ ...options, reapplyIfEmpty: true })
    ).resolves.toMatchObject({ status: 'installed', commitSha });
    expect(resolveCommit).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledTimes(2);
    await expect(readFile(join(workspaceDir, 'AGENTS.md'), 'utf8')).resolves.toBe('# Assistant\n');
  });

  it('never overwrites user files when explicit template reapplication is requested', async () => {
    const { workspaceDir, stateDir } = await fixture();
    const options = {
      workspaceDir,
      stateDir,
      resolveCommit: vi.fn(latest),
      download: vi.fn(async () => artifact),
      extract,
    };
    await installWorkspaceTemplate(options);
    await writeFile(join(workspaceDir, 'USER-NOTE.md'), 'keep me\n');

    await expect(
      installWorkspaceTemplate({ ...options, reapplyIfEmpty: true })
    ).resolves.toEqual({ status: 'skipped', reason: 'workspace-not-empty' });
    expect(options.resolveCommit).toHaveBeenCalledTimes(1);
    expect(options.download).toHaveBeenCalledTimes(1);
    await expect(readFile(join(workspaceDir, 'USER-NOTE.md'), 'utf8')).resolves.toBe('keep me\n');
  });

  it('treats a workspace symlink as existing and never follows it', async () => {
    const { root, workspaceDir, stateDir } = await fixture();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, workspaceDir);
    await expect(
      installWorkspaceTemplate({
        workspaceDir,
        stateDir,
        resolveCommit: latest,
        download: async () => artifact,
        extract,
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'workspace-not-empty' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects invalid repository names and commit responses', async () => {
    const { workspaceDir, stateDir } = await fixture();
    await expect(
      installWorkspaceTemplate({ workspaceDir, stateDir, repository: 'not-a-repository' })
    ).rejects.toThrow(/owner\/name/);
    await expect(
      installWorkspaceTemplate({
        workspaceDir,
        stateDir,
        resolveCommit: async () => 'main',
      })
    ).rejects.toThrow(/commit SHA/);
  });
});

describe('workspace tar validation', () => {
  it('accepts one root containing regular files and approved compatibility links', () => {
    const paths = [
      'repo/AGENTS.md',
      'repo/skills/example/SKILL.md',
      'repo/.agents/skills',
      'repo/.claude/skills',
      'repo/.grok/skills',
      'repo/CLAUDE.md',
    ].join('\n');
    const verbose = [
      '-rw-r--r-- user/group 1 date repo/AGENTS.md',
      '-rw-r--r-- user/group 1 date repo/skills/example/SKILL.md',
      'lrwxrwxrwx user/group 0 date repo/.agents/skills -> ../skills',
      'lrwxrwxrwx user/group 0 date repo/.claude/skills -> ../skills',
      'lrwxrwxrwx user/group 0 date repo/.grok/skills -> ../skills',
      'lrwxrwxrwx user/group 0 date repo/CLAUDE.md -> AGENTS.md',
    ].join('\n');
    expect(() => validateWorkspaceTarListing(paths, verbose)).not.toThrow();
    expect(() =>
      validateWorkspaceTarListing(paths, verbose.replace('../skills', '/tmp/skills'))
    ).toThrow(/unsafe symbolic link/);
  });

  it.each([
    ['/etc/passwd\n', '-rw-r--r-- user/group 1 date /etc/passwd\n'],
    ['root/../escape\n', '-rw-r--r-- user/group 1 date root/../escape\n'],
    ['one/a\ntwo/b\n', '-rw-r--r-- user/group 1 date one/a\n-rw-r--r-- user/group 1 date two/b\n'],
    ['root/link\n', 'lrwxrwxrwx user/group 0 date root/link -> /etc\n'],
    ['root/device\n', 'crw-rw-rw- user/group 1,3 date root/device\n'],
  ])('rejects traversal, multiple roots, links, or devices', (paths, verbose) => {
    expect(() => validateWorkspaceTarListing(paths, verbose)).toThrow();
  });
});
