import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectPublicGitHubExtension,
  listRemoteExtensionSources,
  parsePublicGitHubRepositoryUrl,
  preparePublicGitHubExtension,
  validateExtensionTarListing,
} from '../src/extension-repository.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('public GitHub extension repositories', () => {
  it('accepts only public GitHub repository root URLs', () => {
    expect(parsePublicGitHubRepositoryUrl('https://github.com/example/demo.git/')).toEqual({
      repository: 'example/demo',
      repositoryUrl: 'https://github.com/example/demo',
    });
    for (const value of [
      'http://github.com/example/demo',
      'https://github.example/example/demo',
      'https://github.com/example/demo/tree/main',
      'https://github.com/example/demo?tab=readme',
      'https://user@github.com/example/demo',
    ]) {
      expect(() => parsePublicGitHubRepositoryUrl(value)).toThrow();
    }
  });

  it('pins, validates, and records a repository before setup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'xangi-extension-repository-'));
    temporaryDirectories.push(dataDir);
    const sha = 'a'.repeat(40);
    const request = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/repos/example/demo')) {
        return Response.json({
          private: false,
          default_branch: 'main',
          license: { spdx_id: 'MIT' },
        });
      }
      if (url.endsWith('/repos/example/demo/commits/main')) return Response.json({ sha });
      return new Response(null, { status: 404 });
    };

    const source = await preparePublicGitHubExtension('https://github.com/example/demo', {
      dataDir,
      fetch: request as typeof fetch,
      download: async (url, maxBytes) => {
        expect(url).toBe(`https://api.github.com/repos/example/demo/tarball/${sha}`);
        expect(maxBytes).toBe(50 * 1024 * 1024);
        return new Uint8Array([1, 2, 3]);
      },
      extract: async (_artifact, destination) => {
        await mkdir(destination, { recursive: true });
        await writeFile(
          join(destination, 'xangi-extension.json'),
          JSON.stringify({
            schemaVersion: 2,
            id: 'demo',
            displayName: 'Demo',
            version: '1.0.0',
            entrypoint: 'bin/demo',
            runtime: { kind: 'managed-http' },
            setup: { instructions: 'README.md' },
            capabilities: [],
          })
        );
        await writeFile(join(destination, 'README.md'), '# Setup\n');
      },
      now: () => new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(source).toMatchObject({
      repository: 'example/demo',
      repositoryUrl: 'https://github.com/example/demo',
      commitSha: sha,
      license: 'MIT',
      addedAt: '2026-08-15T00:00:00.000Z',
    });
    expect(JSON.parse(await readFile(source.manifestPath, 'utf8'))).toMatchObject({ id: 'demo' });
    expect(await listRemoteExtensionSources(dataDir)).toEqual([source]);
  });

  it('rejects private repositories before downloading', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'xangi-extension-repository-'));
    temporaryDirectories.push(dataDir);
    let downloaded = false;
    await expect(
      preparePublicGitHubExtension('https://github.com/example/private', {
        dataDir,
        fetch: (async () =>
          Response.json({ private: true, default_branch: 'main' })) as typeof fetch,
        download: async () => {
          downloaded = true;
          return new Uint8Array();
        },
      })
    ).rejects.toThrow('Only public GitHub repositories are supported');
    expect(downloaded).toBe(false);
  });

  it('inspects the latest commit without downloading an archive', async () => {
    const sha = 'c'.repeat(40);
    const requested: string[] = [];
    const result = await inspectPublicGitHubExtension('https://github.com/example/demo', {
      fetch: (async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith('/repos/example/demo')) {
          return Response.json({
            private: false,
            default_branch: 'main',
            license: { spdx_id: 'Apache-2.0' },
          });
        }
        if (url.endsWith('/repos/example/demo/commits/main')) return Response.json({ sha });
        return new Response(null, { status: 404 });
      }) as typeof fetch,
    });

    expect(result).toEqual({
      repository: 'example/demo',
      repositoryUrl: 'https://github.com/example/demo',
      commitSha: sha,
      license: 'Apache-2.0',
    });
    expect(requested.every((url) => !url.includes('/tarball/'))).toBe(true);
  });

  it('restores the previous source when post-swap preparation fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'xangi-extension-repository-'));
    temporaryDirectories.push(dataDir);
    let sha = 'a'.repeat(40);
    let version = '1.0.0';
    const request = (async (input) => {
      const url = String(input);
      if (url.endsWith('/repos/example/demo')) {
        return Response.json({ private: false, default_branch: 'main' });
      }
      if (url.endsWith('/repos/example/demo/commits/main')) return Response.json({ sha });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const extract = async (_artifact: Uint8Array, destination: string) => {
      await mkdir(destination, { recursive: true });
      await writeFile(
        join(destination, 'xangi-extension.json'),
        JSON.stringify({
          schemaVersion: 2,
          id: 'demo',
          displayName: 'Demo',
          version,
          entrypoint: 'bin/demo',
          runtime: { kind: 'managed-http' },
          capabilities: [],
        })
      );
      await writeFile(join(destination, 'README.md'), '# Setup\n');
    };
    const current = await preparePublicGitHubExtension('https://github.com/example/demo', {
      dataDir,
      fetch: request,
      download: async () => new Uint8Array([1]),
      extract,
    });

    sha = 'b'.repeat(40);
    version = '1.1.0';
    const hooks: string[] = [];
    await expect(
      preparePublicGitHubExtension('https://github.com/example/demo', {
        dataDir,
        fetch: request,
        download: async () => new Uint8Array([2]),
        extract,
        expectedPreviousCommitSha: current.commitSha,
        beforeSwap: async () => {
          hooks.push('before-swap');
        },
        afterSwap: async () => {
          hooks.push('after-swap');
          throw new Error('dependency preparation failed');
        },
        beforeRollback: async () => {
          hooks.push('before-rollback');
        },
        afterRollback: async () => {
          hooks.push('after-rollback');
        },
      })
    ).rejects.toThrow('dependency preparation failed');

    expect(hooks).toEqual(['before-swap', 'after-swap', 'before-rollback', 'after-rollback']);
    expect(JSON.parse(await readFile(current.manifestPath, 'utf8'))).toMatchObject({
      version: '1.0.0',
    });
    expect(await listRemoteExtensionSources(dataDir)).toEqual([current]);
  });

  it('rejects traversal, multiple roots, and archive links', () => {
    expect(() =>
      validateExtensionTarListing(
        'repo/\nrepo/xangi-extension.json\n',
        'drwxr-xr-x user/group 0 date repo/\n-rw-r--r-- user/group 10 date repo/xangi-extension.json\n'
      )
    ).not.toThrow();
    expect(() =>
      validateExtensionTarListing('repo/\nrepo/../escape\n', 'drwxr-xr-x repo/\n')
    ).toThrow('Unsafe extension repository archive path');
    expect(() =>
      validateExtensionTarListing('repo/\nother/file\n', '-rw-r--r-- other/file\n')
    ).toThrow('exactly one top-level directory');
    expect(() =>
      validateExtensionTarListing(
        'repo/\nrepo/link\n',
        'drwxr-xr-x user/group 0 date repo/\nlrwxrwxrwx user/group 0 date repo/link -> /tmp\n'
      )
    ).toThrow('only regular files and directories');
  });
});
