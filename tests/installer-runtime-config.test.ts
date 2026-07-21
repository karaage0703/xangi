import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  applySetupRuntimeEnvFromProcess,
  loadSetupRuntimeEnv,
  runConfiguredRuntime,
  SETUP_CONFIG_PATH_ENV,
  SETUP_STATE_DIR_ENV,
} from '../src/installer/runtime-config.js';

const execFileAsync = promisify(execFile);

describe('setup runtime config bridge', () => {
  it('maps typed JSON to the runtime environment and forces Web Chat to loopback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-runtime-config-'));
    const configPath = join(root, 'config', 'xangi.json');
    await mkdir(join(root, 'config'));
    await writeFile(
      configPath,
      JSON.stringify({
        backend: 'codex',
        workspacePath: join(root, 'workspace'),
        webChatEnabled: true,
        webChatAccess: 'tailscale',
        notionSyncEnabled: true,
      })
    );
    await expect(loadSetupRuntimeEnv(configPath, join(root, 'state'))).resolves.toEqual({
      AGENT_BACKEND: 'codex',
      WORKSPACE_PATH: join(root, 'workspace'),
      DATA_DIR: join(root, 'state'),
      WEB_CHAT_ENABLED: 'true',
      WEB_CHAT_HOST: '127.0.0.1',
      XANGI_NOTION_SYNC_ENABLED: 'true',
    });
  });

  it('applies environment before importing the runtime entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-runtime-config-'));
    const configPath = join(root, 'config', 'xangi.json');
    await mkdir(join(root, 'config'));
    await writeFile(
      configPath,
      JSON.stringify({
        backend: 'claude-code',
        workspacePath: root,
        webChatEnabled: false,
        notionSyncEnabled: false,
      })
    );
    const importer = vi.fn(async () => {
      expect(process.env.AGENT_BACKEND).toBe('claude-code');
      expect(process.env.WEB_CHAT_ENABLED).toBe('false');
    });
    await runConfiguredRuntime(configPath, join(root, 'state'), join(root, 'index.js'), importer);
    expect(importer).toHaveBeenCalledOnce();
  });

  it('binds all interfaces only for an explicit LAN setup choice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-runtime-lan-'));
    const configPath = join(root, 'config', 'xangi.json');
    await mkdir(join(root, 'config'));
    await writeFile(
      configPath,
      JSON.stringify({
        backend: 'codex',
        workspacePath: root,
        webChatEnabled: true,
        webChatAccess: 'lan',
      })
    );
    await expect(loadSetupRuntimeEnv(configPath, join(root, 'state'))).resolves.toMatchObject({
      WEB_CHAT_HOST: '0.0.0.0',
    });
  });

  it('uses the explicit XDG state directory instead of deriving it from config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-runtime-xdg-'));
    const configPath = join(root, '.config', 'xangi', 'xangi.json');
    const stateDir = join(root, 'custom-state', 'xangi');
    await mkdir(join(root, '.config', 'xangi'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ backend: 'codex', workspacePath: root, webChatEnabled: true })
    );
    await expect(loadSetupRuntimeEnv(configPath, stateDir)).resolves.toMatchObject({
      DATA_DIR: stateDir,
    });
  });

  it('starts through a symlinked execution-only entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-runtime-symlink-'));
    const configPath = join(root, 'config', 'xangi.json');
    const stateDir = join(root, 'state');
    const outputPath = join(root, 'started.txt');
    const runtimeEntrypoint = join(root, 'runtime-entrypoint.mjs');
    const linkedEntrypoint = join(root, 'runtime-config-main.ts');
    await mkdir(join(root, 'config'));
    await writeFile(
      configPath,
      JSON.stringify({ backend: 'codex', workspacePath: root, webChatEnabled: true })
    );
    await writeFile(
      runtimeEntrypoint,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(outputPath)}, process.env.WORKSPACE_PATH ?? '');\n`
    );
    await symlink(
      fileURLToPath(new URL('../src/installer/runtime-config-main.ts', import.meta.url)),
      linkedEntrypoint
    );

    await execFileAsync(join(process.cwd(), 'node_modules', '.bin', 'tsx'), [
      linkedEntrypoint,
      configPath,
      stateDir,
      runtimeEntrypoint,
    ]);

    await expect(readFile(outputPath, 'utf8')).resolves.toBe(root);
  });

  it('makes setup values authoritative over checkout environment values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-runtime-checkout-'));
    const configPath = join(root, 'config', 'xangi.json');
    const workspacePath = join(root, 'selected-workspace');
    await mkdir(join(root, 'config'));
    await writeFile(
      configPath,
      JSON.stringify({ backend: 'codex', workspacePath, webChatEnabled: true })
    );
    const env = {
      WORKSPACE_PATH: join(root, 'checkout'),
      [SETUP_CONFIG_PATH_ENV]: configPath,
      [SETUP_STATE_DIR_ENV]: join(root, 'state'),
    };

    await expect(applySetupRuntimeEnvFromProcess(env)).resolves.toBe(true);
    expect(env).toMatchObject({
      WORKSPACE_PATH: workspacePath,
      AGENT_BACKEND: 'codex',
      WEB_CHAT_ENABLED: 'true',
      DATA_DIR: join(root, 'state'),
    });
  });
});
