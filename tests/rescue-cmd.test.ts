import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveAppLayout } from '../src/installer/layout.js';
import { buildRescuePrompt, prepareRescueLaunch, rescueCmd } from '../src/cli/rescue-cmd.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), 'xangi-rescue-test-'));
  roots.push(homeDir);
  const layout = resolveAppLayout({ platform: 'darwin', arch: 'arm64', homeDir });
  const workspace = join(homeDir, 'workspace');
  const codex = join(homeDir, 'agents', 'codex');
  const claude = join(homeDir, 'agents', 'claude');
  await mkdir(workspace);
  await mkdir(dirname(codex), { recursive: true });
  await writeFile(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(claude, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await mkdir(dirname(layout.configFile), { recursive: true });
  await writeFile(
    layout.configFile,
    JSON.stringify({
      backend: 'codex',
      backendExecutable: codex,
      workspacePath: workspace,
      webChatEnabled: true,
      webChatAccess: 'local',
    }),
    { mode: 0o600 }
  );
  await chmod(layout.configFile, 0o600);
  return { homeDir, layout, workspace, codex, claude };
}

describe('xangi rescue', () => {
  it('uses the configured AI and gives it local diagnostic paths and repair authority', async () => {
    const { homeDir, layout, workspace, codex, claude } = await fixture();
    const launch = vi.fn(async () => 0);
    const result = await rescueCmd({
      layout,
      homeDir,
      launcherCommand: "'/Applications/Xangi/xangi'",
      documentationRoot: '/Applications/Xangi/current',
      installationKind: 'managed',
      pathEnv: dirname(codex),
      canExecute: async (path) => path === codex || path === claude,
      version: () => 'test-version',
      authStatus: () => true,
      selectBackend: async () => {
        throw new Error('configured backend should be selected without prompting');
      },
      launch,
    });

    expect(result).toContain('Codex');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ id: 'codex', executable: codex })
    );
    expect(launch.mock.calls[0]![2]).toBe(workspace);
    const prompt = launch.mock.calls[0]![1];
    expect(prompt).toContain(layout.configFile);
    expect(prompt).toContain(join(layout.stateDir, 'logs'));
    expect(prompt).toContain("'/Applications/Xangi/xangi' doctor");
    expect(prompt).toContain('調査と修正を続ける');
    expect(prompt).toContain('secretの値を表示・会話へ転記・外部送信しない');
  });

  it('keeps detailed rescue instructions in a private temporary file and removes it', async () => {
    const prepared = await prepareRescueLaunch('private diagnostic instructions');
    roots.push(dirname(prepared.instructionPath));
    expect(prepared.visiblePrompt).not.toContain('private diagnostic instructions');
    expect(await readFile(prepared.instructionPath, 'utf8')).toContain('private diagnostic');
    expect((await stat(prepared.instructionPath)).mode & 0o777).toBe(0o600);
    await prepared.cleanup();
    await expect(readFile(prepared.instructionPath, 'utf8')).rejects.toThrow();
  });

  it('describes checkout diagnostics without embedding secret values', () => {
    const layout = resolveAppLayout({ platform: 'linux', arch: 'x64', homeDir: '/home/tester' });
    const prompt = buildRescuePrompt({
      launcherCommand: "'/home/tester/xangi/bin/xangi'",
      documentationRoot: '/home/tester/xangi',
      checkoutDir: '/home/tester/xangi',
      installationKind: 'checkout',
      layout,
    });
    expect(prompt).toContain('installation: checkout');
    expect(prompt).toContain('/home/tester/xangi');
    expect(prompt).toContain("service start --dir '/home/tester/xangi'");
    expect(prompt).toContain("doctor --dir '/home/tester/xangi'");
    expect(prompt).toContain('設定の有無だけを扱う');
  });

  it('still launches when the configured workspace is missing', async () => {
    const { homeDir, layout, codex } = await fixture();
    const missingWorkspace = join(homeDir, 'missing-workspace');
    await writeFile(
      layout.configFile,
      JSON.stringify({
        backend: 'codex',
        backendExecutable: codex,
        workspacePath: missingWorkspace,
        webChatEnabled: true,
        webChatAccess: 'local',
      }),
      { mode: 0o600 }
    );
    const launch = vi.fn(async () => 0);
    await rescueCmd({
      layout,
      homeDir,
      launcherCommand: 'xangi',
      documentationRoot: homeDir,
      installationKind: 'managed',
      canExecute: async (path) => path === codex,
      version: () => 'test-version',
      authStatus: () => true,
      launch,
    });
    expect(launch.mock.calls[0]![2]).toBe(homeDir);
    expect(launch.mock.calls[0]![1]).toContain(missingWorkspace);
  });
});
