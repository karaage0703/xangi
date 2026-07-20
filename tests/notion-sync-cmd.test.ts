import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { describe, expect, it, vi } from 'vitest';
import { notionSyncCmd } from '../src/cli/notion-sync-cmd.js';
import type {
  DocumentSnapshot,
  MappingState,
  MappingStateUpdate,
  SyncMapping,
} from '../src/notion-sync/types.js';

class Documents {
  constructor(public value: DocumentSnapshot | undefined) {}
  async read(): Promise<DocumentSnapshot | undefined> {
    return this.value;
  }
  async backup(): Promise<void> {}
  async write(_id: string, markdown: string): Promise<DocumentSnapshot> {
    this.value = { markdown, hash: `hash:${markdown}`, editedTime: 'written' };
    return this.value;
  }
}

class MirrorDocuments extends Documents {
  created: Array<{ parent: string; title: string; markdown: string; id: string }> = [];
  async createPage(parent: string, title: string, markdown: string): Promise<string> {
    const id = `page-${this.created.length + 1}`;
    this.created.push({ parent, title, markdown, id });
    return id;
  }
}

class States {
  value: MappingState | undefined;
  async load(): Promise<MappingState | undefined> {
    return this.value;
  }
  async save(mapping: SyncMapping, update: MappingStateUpdate): Promise<void> {
    this.value = { ...mapping, mappingId: mapping.id, ...update };
  }
}

describe('notionSyncCmd', () => {
  it('runs declared mappings through fixture ports without a token', async () => {
    const workspace = new Documents(undefined);
    const notion = new Documents({ markdown: '# Agent', hash: 'hash:# Agent', editedTime: 'now' });
    const state = new States();
    const output = await notionSyncCmd(
      'run',
      { workspace: '/fixture/workspace', 'data-dir': '/fixture/state', once: true },
      {
        manifestText: `version: 1\nmappings:\n  - id: agents\n    direction: notion-to-local\n    localPath: AGENTS.md\n    notionPageId: page-1\n`,
        workspace,
        notion,
        state,
      }
    );

    expect(output).toBe('agents: pull');
    expect(workspace.value?.markdown).toBe('# Agent');
    expect(state.value?.status).toBe('synced');
  });

  it('does not include Notion tokens in missing-config errors', async () => {
    await expect(
      notionSyncCmd('run', {}, { homeDir: '/definitely-missing', token: 'secret-token' })
    ).rejects.not.toThrow(/secret-token/);
  });

  it('rejects concurrent sync processes before state can be modified', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'xangi-notion-lock-'));
    const release = await lockfile.lock(join(dataDir, 'notion-sync'), {
      realpath: false,
      retries: 0,
    });
    try {
      await expect(
        notionSyncCmd(
          'run',
          { workspace: '/fixture/workspace', 'data-dir': dataDir, once: true },
          {
            manifestText: 'version: 1\nmappings: []\n',
            workspace: new Documents(undefined),
            notion: new Documents(undefined),
          }
        )
      ).rejects.toThrow(/lock/i);
    } finally {
      await release();
    }
  });

  it('reports legacy setup as disabled without accessing Notion', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'xangi-notion-status-'));
    const configPath = join(homeDir, '.config', 'xangi', 'xangi.json');
    await mkdir(join(homeDir, '.config', 'xangi'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        backend: 'codex',
        workspacePath: join(homeDir, 'workspace'),
        webChatEnabled: true,
      })
    );
    const notion = { read: vi.fn(), write: vi.fn() };

    await expect(
      notionSyncCmd(
        'status',
        {},
        { homeDir, platform: 'linux', xdgConfigHome: join(homeDir, '.config'), notion }
      )
    ).resolves.toBe('Notion sync: disabled');
    expect(notion.read).not.toHaveBeenCalled();
    expect(notion.write).not.toHaveBeenCalled();
  });

  it('enables and disables sync atomically while preserving other setup fields', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'xangi-notion-toggle-'));
    const workspacePath = join(homeDir, 'workspace');
    const configPath = join(homeDir, '.config', 'xangi', 'xangi.json');
    const stateHome = join(homeDir, 'state-home');
    const statePath = join(stateHome, 'xangi', 'notion-sync', 'state.json');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(homeDir, '.config', 'xangi'), { recursive: true });
    await mkdir(join(stateHome, 'xangi', 'notion-sync'), { recursive: true });
    await writeFile(statePath, '{"preserved":true}\n');
    await writeFile(
      configPath,
      JSON.stringify({
        backend: 'claude-code',
        workspacePath,
        webChatEnabled: false,
        notionSyncEnabled: false,
      })
    );
    const dependencies = {
      homeDir,
      platform: 'linux',
      xdgConfigHome: join(homeDir, '.config'),
      xdgStateHome: stateHome,
      token: 'secret-token',
      parentPageId: 'parent-page',
      manifestText: 'version: 1\nmappings: []\n',
    };

    await expect(notionSyncCmd('enable', {}, dependencies)).resolves.toBe(
      'Notion sync: enabled（workspaceを正本としてNotionへミラーします）'
    );
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      backend: 'claude-code',
      workspacePath,
      webChatEnabled: false,
      webChatAccess: 'local',
      notionSyncEnabled: true,
    });
    await expect(notionSyncCmd('disable', {}, dependencies)).resolves.toBe('Notion sync: disabled');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      notionSyncEnabled: false,
    });
    expect(await readFile(statePath, 'utf8')).toBe('{"preserved":true}\n');
  });

  it('prompts for a missing token and saves it with mode 0600', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'xangi-notion-secret-'));
    const configHome = join(homeDir, '.config');
    const workspacePath = join(homeDir, 'workspace');
    const configPath = join(configHome, 'xangi', 'xangi.json');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(configHome, 'xangi'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        backend: 'codex',
        workspacePath,
        webChatEnabled: true,
        notionSyncEnabled: false,
      })
    );

    const output = await notionSyncCmd(
      'enable',
      {},
      {
        homeDir,
        platform: 'linux',
        xdgConfigHome: configHome,
        manifestText: 'version: 1\nmappings: []\n',
        promptForToken: async () => 'ntn_user-secret',
        parentPageId: 'parent-page',
      }
    );

    const secretPath = join(configHome, 'xangi', 'secrets.json');
    expect(output).toBe('Notion sync: enabled（workspaceを正本としてNotionへミラーします）');
    expect(await readFile(secretPath, 'utf8')).toContain('ntn_user-secret');
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      notionSyncEnabled: true,
    });
  });

  it('loads a saved token for later sync runs', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'xangi-notion-secret-run-'));
    const configHome = join(homeDir, '.config');
    const stateHome = join(homeDir, '.state');
    const workspacePath = join(homeDir, 'workspace');
    await mkdir(join(configHome, 'xangi'), { recursive: true });
    await writeFile(
      join(configHome, 'xangi', 'xangi.json'),
      JSON.stringify({
        backend: 'codex',
        workspacePath,
        webChatEnabled: true,
        notionSyncEnabled: true,
      })
    );
    await writeFile(
      join(configHome, 'xangi', 'secrets.json'),
      JSON.stringify({ schemaVersion: 1, secrets: { XANGI_NOTION_TOKEN: 'saved-secret' } }),
      { mode: 0o600 }
    );

    await expect(
      notionSyncCmd(
        'run',
        {},
        {
          homeDir,
          platform: 'linux',
          xdgConfigHome: configHome,
          xdgStateHome: stateHome,
          manifestText: 'version: 1\nmappings: []\n',
          workspace: new Documents(undefined),
          state: new States(),
        }
      )
    ).resolves.toBe('Notion sync: no mappings');
  });

  it('refuses a normal run while disabled before accessing Notion', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'xangi-notion-disabled-'));
    const workspacePath = join(homeDir, 'workspace');
    const configPath = join(homeDir, '.config', 'xangi', 'xangi.json');
    await mkdir(join(homeDir, '.config', 'xangi'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        backend: 'codex',
        workspacePath,
        webChatEnabled: true,
        notionSyncEnabled: false,
      })
    );
    const notion = new Documents(undefined);
    const read = vi.spyOn(notion, 'read');

    await expect(
      notionSyncCmd(
        'run',
        {},
        {
          homeDir,
          platform: 'linux',
          xdgConfigHome: join(homeDir, '.config'),
          manifestText: 'version: 1\nmappings: []\n',
          notion,
          workspace: new Documents(undefined),
          state: new States(),
        }
      )
    ).rejects.toThrow(/disabled/);
    expect(read).not.toHaveBeenCalled();
  });

  it('uses the XDG state directory instead of deriving it from the config path', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'xangi-notion-xdg-'));
    const configHome = join(homeDir, 'configuration');
    const stateHome = join(homeDir, 'state-home');
    const workspacePath = join(homeDir, 'workspace');
    await mkdir(join(configHome, 'xangi'), { recursive: true });
    await writeFile(
      join(configHome, 'xangi', 'xangi.json'),
      JSON.stringify({
        backend: 'codex',
        workspacePath,
        webChatEnabled: true,
        notionSyncEnabled: true,
      })
    );
    await expect(
      notionSyncCmd(
        'run',
        {},
        {
          homeDir,
          platform: 'linux',
          xdgConfigHome: configHome,
          xdgStateHome: stateHome,
          manifestText: 'version: 1\nmappings: []\n',
          notion: new Documents(undefined),
          workspace: new Documents(undefined),
        }
      )
    ).resolves.toBe('Notion sync: no mappings');
    expect((await stat(join(stateHome, 'xangi'))).isDirectory()).toBe(true);
  });

  it('mirrors workspace Markdown without a YAML manifest or direction questions', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'xangi-notion-mirror-cmd-'));
    const configHome = join(homeDir, '.config');
    const stateHome = join(homeDir, '.state');
    const workspacePath = join(homeDir, 'workspace');
    await mkdir(join(configHome, 'xangi'), { recursive: true });
    await mkdir(join(workspacePath, 'memory'), { recursive: true });
    await writeFile(join(workspacePath, 'memory', 'profile.md'), '# Profile');
    await writeFile(
      join(configHome, 'xangi', 'xangi.json'),
      JSON.stringify({
        backend: 'codex',
        workspacePath,
        webChatEnabled: true,
        notionSyncEnabled: true,
      })
    );
    const notion = new MirrorDocuments(undefined);

    await expect(
      notionSyncCmd(
        'run',
        {},
        {
          homeDir,
          platform: 'linux',
          xdgConfigHome: configHome,
          xdgStateHome: stateHome,
          token: 'secret',
          parentPageId: 'parent',
          notion,
        }
      )
    ).resolves.toBe('Notion workspace mirror: 1 files（created 2, updated 0）');
    expect(notion.created.map(({ parent, title }) => ({ parent, title }))).toEqual([
      { parent: 'parent', title: 'memory' },
      { parent: 'page-1', title: 'profile' },
    ]);
  });
});
