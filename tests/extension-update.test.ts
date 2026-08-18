import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listRemoteExtensionSources,
  preparePublicGitHubExtension,
} from '../src/extension-repository.js';
import {
  createExtensionUpdateRequest,
  updateExtension,
} from '../src/extension-update.js';
import type { ExtensionAction, LinkedExtension } from '../src/extensions.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture(options: { withSetupDocument?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'xangi-extension-update-'));
  temporaryDirectories.push(dataDir);
  let sha = 'a'.repeat(40);
  let version = '1.0.0';
  let permissions: string[] = [];
  let updatePreparation = {
    command: './prepare-update',
    args: ['$SHOULD_NOT_EXPAND'],
  };
  const request = (async (input) => {
    const url = String(input);
    if (url.endsWith('/repos/example/demo-extension')) {
      return Response.json({ private: false, default_branch: 'main' });
    }
    if (url.endsWith('/repos/example/demo-extension/commits/main')) {
      return Response.json({ sha });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const extract = async (_artifact: Uint8Array, destination: string) => {
    const entrypoint = join(destination, 'bin', 'demo-extension');
    const updatePreparationPath = join(destination, 'prepare-update');
    await mkdir(dirname(entrypoint), { recursive: true });
    await writeFile(entrypoint, '#!/bin/sh\n');
    await chmod(entrypoint, 0o755);
    await writeFile(
      updatePreparationPath,
      '#!/bin/sh\nprintf %s "$1" > prepared-argument.txt\n'
    );
    await chmod(updatePreparationPath, 0o755);
    await writeFile(
      join(destination, 'xangi-extension.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'demo-extension',
        displayName: 'Demo extension',
        version,
        entrypoint: 'bin/demo-extension',
        runtime: { kind: 'managed-http' },
        ...(options.withSetupDocument === false
          ? {}
          : { setup: { instructions: 'XANGI_SETUP.md' } }),
        update: { prepare: updatePreparation },
        permissions,
        capabilities: [],
      })
    );
    await writeFile(join(destination, 'README.md'), '# Setup\n');
    await writeFile(join(destination, 'XANGI_SETUP.md'), '# Extension setup\n');
  };
  const source = await preparePublicGitHubExtension(
    'https://github.com/example/demo-extension',
    {
      dataDir,
      fetch: request,
      download: async () => new Uint8Array([1]),
      extract,
    }
  );
  const linked: LinkedExtension = {
    id: 'demo-extension',
    manifestPath: source.manifestPath,
    enabled: true,
    autostart: true,
  };
  return {
    dataDir,
    request,
    extract,
    linked,
    currentSha: sha,
    setCandidate(candidate: {
      sha: string;
      version: string;
      permissions?: string[];
      updatePreparation?: { command: string; args: string[] };
    }) {
      sha = candidate.sha;
      version = candidate.version;
      permissions = candidate.permissions ?? [];
      updatePreparation = candidate.updatePreparation ?? updatePreparation;
    },
  };
}

describe('repository-managed extension updates', () => {
  it('opens an update conversation pinned to the inspected commit', async () => {
    const setup = await fixture();
    setup.setCandidate({ sha: 'b'.repeat(40), version: '1.1.0' });

    const request = await createExtensionUpdateRequest('demo-extension', {
      dataDir: setup.dataDir,
      fetch: setup.request,
      listLinkedExtensions: async () => [setup.linked],
    });

    expect(request.info).toMatchObject({
      currentVersion: '1.0.0',
      currentCommitSha: setup.currentSha,
      targetCommitSha: 'b'.repeat(40),
      updateAvailable: true,
    });
    expect(request.prompt).toContain(
      `xangi tool extension_update --id demo-extension --to ${'b'.repeat(40)}`
    );
    expect(request.prompt).toContain(`extension root: ${dirname(setup.linked.manifestPath)}`);
    expect(request.prompt).toContain(
      `setup document: ${join(dirname(setup.linked.manifestPath), 'XANGI_SETUP.md')}`
    );
    expect(request.prompt).toContain('更新後のextensionとworkspaceの統合状態');
    expect(request.prompt).toContain('同梱スキルとworkspace側の同名スキル');
    expect(request.prompt).toContain('AGENTS.md');
    expect(request.prompt).toContain('明示承認するまで');
    expect(request.prompt).toContain('表記や整形だけの差分は提案しません');
  });

  it('keeps the workspace review optional when no setup document is declared', async () => {
    const setup = await fixture({ withSetupDocument: false });
    setup.setCandidate({ sha: 'b'.repeat(40), version: '1.1.0' });

    const request = await createExtensionUpdateRequest('demo-extension', {
      dataDir: setup.dataDir,
      fetch: setup.request,
      listLinkedExtensions: async () => [setup.linked],
    });

    expect(request.prompt).toContain('setup document: not declared');
    expect(request.prompt).toContain('利用者向けsetup文書や同梱スキルがある場合だけ');
  });

  it('prepares, relinks, starts, and doctors a pinned update in the host process', async () => {
    const setup = await fixture();
    const target = 'b'.repeat(40);
    setup.setCandidate({ sha: target, version: '1.1.0' });
    const actions: ExtensionAction[] = [];
    let preparedAt = '';
    const result = await updateExtension(
      {
        id: 'demo-extension',
        expectedCommitSha: target,
        workspace: '/workspace',
      },
      {
        dataDir: setup.dataDir,
        fetch: setup.request,
        download: async () => new Uint8Array([2]),
        extract: setup.extract,
        listLinkedExtensions: async () => [setup.linked],
        prepareDependencies: async (root, preparation) => {
          preparedAt = root;
          expect(preparation).toEqual({
            command: './prepare-update',
            args: ['$SHOULD_NOT_EXPAND'],
          });
        },
        link: async (manifestPath, options) => ({
          ...setup.linked,
          manifestPath,
          autostart: options.autostart,
        }),
        runAction: async (_linked, action) => {
          actions.push(action);
          if (action === 'status') return { running: true, healthy: true };
          if (action === 'doctor') return { running: true, healthy: true };
          return { running: action === 'start', healthy: action === 'start' };
        },
      }
    );

    expect(result).toEqual({
      id: 'demo-extension',
      previousVersion: '1.0.0',
      version: '1.1.0',
      previousCommitSha: setup.currentSha,
      commitSha: target,
      running: true,
      healthy: true,
      doctorPassed: true,
      rolledBack: false,
    });
    expect(preparedAt).toBe(dirname(setup.linked.manifestPath));
    expect(actions).toEqual(['status', 'stop', 'start', 'doctor']);
  });

  it('requires explicit approval before adding manifest permissions', async () => {
    const setup = await fixture();
    const target = 'c'.repeat(40);
    setup.setCandidate({
      sha: target,
      version: '1.1.0',
      permissions: ['read workspace index'],
    });
    const actions: ExtensionAction[] = [];

    await expect(
      updateExtension(
        {
          id: 'demo-extension',
          expectedCommitSha: target,
          workspace: '/workspace',
        },
        {
          dataDir: setup.dataDir,
          fetch: setup.request,
          download: async () => new Uint8Array([3]),
          extract: setup.extract,
          listLinkedExtensions: async () => [setup.linked],
          runAction: async (_linked, action) => {
            actions.push(action);
            return { running: true, healthy: true };
          },
        }
      )
    ).rejects.toThrow('permission added: read workspace index');
    expect(actions).toEqual(['status']);
  });

  it('executes the manifest preparation without shell expansion', async () => {
    const setup = await fixture();
    const target = 'f'.repeat(40);
    setup.setCandidate({ sha: target, version: '1.1.0' });
    await updateExtension(
      {
        id: 'demo-extension',
        expectedCommitSha: target,
        workspace: '/workspace',
      },
      {
        dataDir: setup.dataDir,
        fetch: setup.request,
        download: async () => new Uint8Array([5]),
        extract: setup.extract,
        listLinkedExtensions: async () => [setup.linked],
        link: async (manifestPath, options) => ({
          ...setup.linked,
          manifestPath,
          autostart: options.autostart,
        }),
        runAction: async (_linked, action) =>
          action === 'status'
            ? { running: false, healthy: false }
            : { running: action !== 'stop', healthy: action === 'doctor' },
      }
    );

    expect(
      await readFile(join(dirname(setup.linked.manifestPath), 'prepared-argument.txt'), 'utf8')
    ).toBe('$SHOULD_NOT_EXPAND');
  });

  it('requires explicit approval before changing the preparation command', async () => {
    const setup = await fixture();
    const target = '1'.repeat(40);
    setup.setCandidate({
      sha: target,
      version: '1.1.0',
      updatePreparation: { command: 'other-pm', args: ['install'] },
    });
    const actions: ExtensionAction[] = [];

    await expect(
      updateExtension(
        {
          id: 'demo-extension',
          expectedCommitSha: target,
          workspace: '/workspace',
        },
        {
          dataDir: setup.dataDir,
          fetch: setup.request,
          download: async () => new Uint8Array([6]),
          extract: setup.extract,
          listLinkedExtensions: async () => [setup.linked],
          runAction: async (_linked, action) => {
            actions.push(action);
            return { running: true, healthy: true };
          },
        }
      )
    ).rejects.toThrow('update preparation changed');
    expect(actions).toEqual(['status']);
  });

  it('restores and doctors the running previous version when candidate doctor fails', async () => {
    const setup = await fixture();
    const target = 'd'.repeat(40);
    setup.setCandidate({ sha: target, version: '1.1.0' });
    const actions: ExtensionAction[] = [];
    let doctorCalls = 0;
    let linkCalls = 0;

    await expect(
      updateExtension(
        {
          id: 'demo-extension',
          expectedCommitSha: target,
          workspace: '/workspace',
        },
        {
          dataDir: setup.dataDir,
          fetch: setup.request,
          download: async () => new Uint8Array([4]),
          extract: setup.extract,
          listLinkedExtensions: async () => [setup.linked],
          prepareDependencies: async () => {},
          link: async (manifestPath, options) => {
            linkCalls += 1;
            return { ...setup.linked, manifestPath, autostart: options.autostart };
          },
          runAction: async (_linked, action) => {
            actions.push(action);
            if (action === 'status') return { running: true, healthy: true };
            if (action === 'doctor') {
              doctorCalls += 1;
              return { running: true, healthy: doctorCalls > 1 };
            }
            return { running: action === 'start', healthy: action === 'start' };
          },
        }
      )
    ).rejects.toThrow('did not pass doctor after update');

    expect(actions).toEqual(['status', 'stop', 'start', 'doctor', 'stop', 'start', 'doctor']);
    expect(linkCalls).toBe(2);
    expect(JSON.parse(await readFile(setup.linked.manifestPath, 'utf8'))).toMatchObject({
      version: '1.0.0',
    });
    expect(await listRemoteExtensionSources(setup.dataDir)).toEqual([
      expect.objectContaining({ commitSha: setup.currentSha }),
    ]);
  });
});
