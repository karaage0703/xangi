import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAppLayout } from '../src/installer/layout.js';
import {
  applyGuidedSetup,
  buildOnboardingPrompt,
  completeGuidedSetup,
  detectGuidedBackends,
  detectKnownWorkspaces,
  GUIDED_BACKENDS,
  guidedSetupCmd,
  missingBackendGuide,
  prepareOnboardingLaunch,
  readOnboardingStatus,
  SetupPrerequisiteError,
} from '../src/setup/guided-onboarding.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), 'xangi-guided-'));
  roots.push(homeDir);
  const layout = resolveAppLayout({ platform: 'darwin', arch: 'arm64', homeDir });
  return { homeDir, layout };
}

describe('guided setup backend preflight', () => {
  it('detects only executable supported agent CLIs and records versions', async () => {
    const executable = new Set(['/agents/codex', '/agents/claude', '/agents/grok']);
    const detected = await detectGuidedBackends({
      pathEnv: '/agents',
      canExecute: async (path) => executable.has(path),
      version: (path) =>
        path.endsWith('codex')
          ? 'codex 1.2.3'
          : path.endsWith('claude')
            ? 'claude 4.5.6'
            : undefined,
    });
    expect(detected.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: 'codex', version: 'codex 1.2.3' },
      { id: 'claude-code', version: 'claude 4.5.6' },
    ]);
  });

  it('finds only known workspace locations without recursively scanning home', async () => {
    const { homeDir } = await fixture();
    const configured = join(homeDir, 'configured');
    const current = join(homeDir, 'current');
    const unrelated = join(homeDir, 'unrelated');
    const template = join(homeDir, 'ai-assistant-workspace');
    await mkdir(configured);
    await mkdir(current);
    await mkdir(unrelated);
    await mkdir(template);
    await writeFile(join(configured, 'AGENTS.md'), '# Agent\n');
    await writeFile(join(current, 'BOOTSTRAP.md'), '# Bootstrap\n');
    await writeFile(join(unrelated, 'AGENTS.md'), '# Not a known location\n');
    await expect(
      detectKnownWorkspaces({ homeDir, cwd: current, workspaceEnv: configured })
    ).resolves.toEqual([configured, current, template]);
  });

  it('gives deterministic install guidance when no agent is available', () => {
    expect(missingBackendGuide()).toContain('setup-ai-tools.sh');
    expect(missingBackendGuide()).toContain('bash <(curl -fsSL');
    expect(missingBackendGuide()).toContain('codex / claude-code / cursor / grok / antigravity');
    expect(missingBackendGuide()).toContain('もう一度 `xangi setup` を実行');
    expect(missingBackendGuide()).not.toContain('npm install');
  });

  it('records rule-based authentication status when the CLI supports it', async () => {
    const authStatus = vi.fn((command: string) => command.endsWith('codex'));
    const detected = await detectGuidedBackends({
      pathEnv: '/agents',
      canExecute: async (path) => path === '/agents/codex' || path === '/agents/claude',
      version: () => 'test-version',
      authStatus,
    });
    expect(detected.map(({ id, authenticated }) => ({ id, authenticated }))).toEqual([
      { id: 'codex', authenticated: true },
      { id: 'claude-code', authenticated: false },
    ]);
    expect(authStatus).toHaveBeenCalledWith('/agents/codex', ['login', 'status']);
    expect(authStatus).toHaveBeenCalledWith('/agents/claude', ['auth', 'status']);
  });

  it('stops with a resumable prerequisite status when no ready CLI exists', async () => {
    await expect(
      guidedSetupCmd({
        launcherCommand: 'xangi',
        documentationRoot: '/xangi',
        installationKind: 'managed',
        pathEnv: '/agents',
        canExecute: async () => false,
      })
    ).rejects.toMatchObject({ name: 'SetupPrerequisiteError', exitCode: 3 });

    await expect(
      guidedSetupCmd({
        launcherCommand: 'xangi',
        documentationRoot: '/xangi',
        installationKind: 'managed',
        pathEnv: '/agents',
        canExecute: async (path) => path === '/agents/codex',
        version: () => 'test-version',
        authStatus: () => false,
      })
    ).rejects.toBeInstanceOf(SetupPrerequisiteError);
  });

  it('workspace未検出時は日本語でai-assistant-workspaceを最初に推奨する', () => {
    const prompt = buildOnboardingPrompt({
      backend: {
        ...GUIDED_BACKENDS[0]!,
        executable: '/agents/codex',
        version: 'test-version',
      },
      launcherCommand: "'/Applications/Xangi/xangi'",
      documentationRoot: '/Applications/Xangi/current',
      installationKind: 'managed',
      homeDir: '/Users/tester',
      workspaceCandidates: [],
    });
    expect(prompt).toContain('質問、説明、確認、要約はすべて日本語');
    expect(prompt).toContain('既知のworkspaceは見つかりませんでした');
    expect(prompt).toContain('/Users/tester/ai-assistant-workspace');
    expect(prompt.indexOf('main最新commitをGitなしで取得する推奨テンプレート')).toBeLessThan(
      prompt.indexOf('別の絶対pathにある既存workspace')
    );
  });

  it('keeps detailed instructions out of the visible agent prompt', async () => {
    const prepared = await prepareOnboardingLaunch('secret detailed setup --apply instructions');
    roots.push(prepared.instructionPath.replace(/\/instructions\.md$/, ''));
    expect(prepared.visiblePrompt).toContain('日本語で一問ずつ');
    expect(prepared.visiblePrompt).not.toContain('setup --apply');
    expect(await readFile(prepared.instructionPath, 'utf8')).toContain('setup --apply');
    const mode = (await import('node:fs/promises')).stat(prepared.instructionPath);
    expect((await mode).mode & 0o777).toBe(0o600);
    await prepared.cleanup();
    await expect(readFile(prepared.instructionPath, 'utf8')).rejects.toThrow();
  });

  it('launches the selected agent with the required conversational flow', async () => {
    const launch = vi.fn(async () => 0);
    const onSelected = vi.fn(async () => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await guidedSetupCmd({
      homeDir: '/Users/tester',
      cwd: '/Users/tester/not-a-workspace',
      launcherCommand: "'/Applications/Xangi/xangi'",
      documentationRoot: '/Applications/Xangi/current',
      installationKind: 'managed',
      pathEnv: '/agents',
      canExecute: async (path) => path === '/agents/codex' || path === '/agents/claude',
      version: () => 'test-version',
      authStatus: (command) => command.endsWith('claude'),
      selectBackend: async (backends) => backends.find((backend) => backend.id === 'claude-code')!,
      onSelected,
      launch,
    });
    expect(result).toContain('Claude Code');
    expect(onSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'claude-code',
        executable: '/agents/claude',
        version: 'test-version',
      })
    );
    expect(launch).toHaveBeenCalledTimes(1);
    const prompt = launch.mock.calls[0]![1];
    expect(prompt).toContain('質問、説明、確認、要約はすべて日本語');
    expect(prompt).toContain('ai-assistant-workspace');
    expect(prompt).toContain('BOOTSTRAP.md');
    expect(prompt).toContain('setup --apply --backend claude-code');
    expect(prompt).toContain('--web-chat-access');
    expect(prompt).toContain('Tailscale経由');
    expect(prompt).toContain('tailscale serve --bg --tcp=18888');
    expect(prompt).toContain('tailscale serve --tcp=18888 off');
    expect(prompt).toContain('他のServe/Funnel設定は変更しない');
    expect(prompt).toContain('Web Chat自体には認証がなく');
    expect(prompt).toContain('Discord');
    expect(prompt).toContain('Notion同期はOFFのまま');
    expect(prompt).toContain('setup --complete');
    expect(prompt).toContain('/Applications/Xangi/current/README.md');
    expect(prompt).toContain('/Applications/Xangi/current/docs/usage.md');
    expect(prompt).toContain('/Applications/Xangi/current/docs/discord-setup.md');
    expect(prompt).toContain('workspace内にxangiのオンボーディング手順を探してはいけません');
    expect(prompt).toContain("`'/Applications/Xangi/xangi' install`");
    expect(prompt).toContain("`'/Applications/Xangi/xangi' service autostart enable`");
    expect(prompt).toContain("`'/Applications/Xangi/xangi' service autostart disable`");
    expect(prompt).toContain('利用者が明確に希望した場合だけ');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('今回の選択肢から除外'));
    log.mockRestore();
  });

  it('managed版の再開setupではservice登録とdoctorまで案内する', () => {
    const prompt = buildOnboardingPrompt({
      backend: {
        ...GUIDED_BACKENDS[0]!,
        executable: '/agents/codex',
        version: 'test-version',
        authenticated: true,
      },
      launcherCommand: "'/Applications/Xangi/xangi'",
      documentationRoot: '/Applications/Xangi/current',
      installationKind: 'managed',
      homeDir: '/Users/tester',
      workspaceCandidates: [],
    });
    expect(prompt).toContain("'/Applications/Xangi/xangi' install");
    expect(prompt).toContain("'/Applications/Xangi/xangi' service autostart enable");
    expect(prompt).toContain("'/Applications/Xangi/xangi' service autostart disable");
    expect(prompt).toContain("'/Applications/Xangi/xangi' doctor");
  });

  it('checkout版では公式READMEを読んでstartとdoctorを実行する', () => {
    const prompt = buildOnboardingPrompt({
      backend: {
        ...GUIDED_BACKENDS[0]!,
        executable: '/agents/codex',
        version: 'test-version',
      },
      launcherCommand: "'/Users/tester/xangi/bin/xangi'",
      documentationRoot: '/Users/tester/xangi',
      installationKind: 'checkout',
      homeDir: '/Users/tester',
      workspaceCandidates: [],
    });
    expect(prompt).toContain("'/Users/tester/xangi/bin/xangi' service start");
    expect(prompt).toContain("'/Users/tester/xangi/bin/xangi' service autostart enable");
    expect(prompt).toContain("'/Users/tester/xangi/bin/xangi' service autostart disable");
    expect(prompt).toContain("'/Users/tester/xangi/bin/xangi' doctor");
    expect(prompt).toContain('runtime-workspace');
    expect(prompt).toContain('/Users/tester/xangi/README.md');
  });

  it('uses the configured Web Chat port in Tailscale Serve guidance', () => {
    const prompt = buildOnboardingPrompt({
      backend: {
        ...GUIDED_BACKENDS[0]!,
        executable: '/agents/codex',
        version: 'test-version',
      },
      launcherCommand: 'xangi',
      documentationRoot: '/xangi',
      installationKind: 'managed',
      homeDir: '/Users/tester',
      workspaceCandidates: [],
      webChatPort: 19991,
    });
    expect(prompt).toContain('tailscale serve --bg --tcp=19991');
    expect(prompt).toContain('tailscale serve --tcp=19991 off');
  });
});

describe('guided setup deterministic apply and completion', () => {
  it('creates a blank workspace BOOTSTRAP and keeps Notion disabled', async () => {
    const { homeDir, layout } = await fixture();
    const workspacePath = join(homeDir, 'blank-workspace');
    const binDir = join(homeDir, '.nvm', 'versions', 'node', 'v22.16.0', 'bin');
    const backendExecutable = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await writeFile(backendExecutable, '#!/bin/sh\nexit 0\n');
    await chmod(backendExecutable, 0o700);
    await expect(
      applyGuidedSetup(
        { backend: 'codex', backendExecutable, workspacePath, workspaceMode: 'blank' },
        { layout, backendAvailable: async () => true }
      )
    ).resolves.toContain(workspacePath);

    const config = JSON.parse(await readFile(layout.configFile, 'utf8'));
    expect(config).toEqual({
      backend: 'codex',
      backendExecutable,
      workspacePath,
      webChatEnabled: true,
      webChatAccess: 'local',
      notionSyncEnabled: false,
    });
    expect(await readFile(join(workspacePath, 'BOOTSTRAP.md'), 'utf8')).toContain(
      'すべて日本語で一度に一つずつ質問'
    );
    expect(
      JSON.parse(await readFile(join(layout.configDir, 'onboarding.json'), 'utf8'))
    ).toMatchObject({
      phase: 'bootstrap_in_progress',
      workspaceMode: 'blank',
      webChatAccess: 'local',
    });
  });

  it('uses the repository template initializer only for template mode', async () => {
    const { homeDir, layout } = await fixture();
    const workspacePath = join(homeDir, 'template-workspace');
    const initializeTemplate = vi.fn(async () => {
      await writeFile(join(workspacePath, 'AGENTS.md'), '# Agent\n');
    });
    await applyGuidedSetup(
      { backend: 'claude-code', workspacePath, workspaceMode: 'template' },
      { layout, initializeTemplate, backendAvailable: async () => true }
    );
    expect(initializeTemplate).toHaveBeenCalledWith(layout);
    await expect(readFile(join(workspacePath, 'AGENTS.md'), 'utf8')).resolves.toContain('Agent');
  });

  it('restores the previous config when template initialization fails', async () => {
    const { homeDir, layout } = await fixture();
    const previousWorkspace = join(homeDir, 'previous');
    await mkdir(previousWorkspace);
    await applyGuidedSetup(
      { backend: 'codex', workspacePath: previousWorkspace, workspaceMode: 'existing' },
      { layout, backendAvailable: async () => true }
    );
    const previousConfig = await readFile(layout.configFile, 'utf8');
    await expect(
      applyGuidedSetup(
        {
          backend: 'claude-code',
          workspacePath: join(homeDir, 'template'),
          workspaceMode: 'template',
        },
        {
          layout,
          backendAvailable: async () => true,
          initializeTemplate: async () => {
            throw new Error('signature rejected');
          },
        }
      )
    ).rejects.toThrow(/signature rejected/);
    await expect(readFile(layout.configFile, 'utf8')).resolves.toBe(previousConfig);
  });

  it('does not overwrite an existing workspace', async () => {
    const { homeDir, layout } = await fixture();
    const workspacePath = join(homeDir, 'existing-workspace');
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, 'AGENTS.md'), 'keep me\n');
    await applyGuidedSetup(
      { backend: 'codex', workspacePath, workspaceMode: 'existing' },
      { layout, backendAvailable: async () => true }
    );
    await expect(readFile(join(workspacePath, 'AGENTS.md'), 'utf8')).resolves.toBe('keep me\n');
  });

  it('requires BOOTSTRAP removal before marking minimum setup ready', async () => {
    const { homeDir, layout } = await fixture();
    const workspacePath = join(homeDir, 'workspace');
    await applyGuidedSetup(
      { backend: 'codex', workspacePath, workspaceMode: 'blank' },
      { layout, backendAvailable: async () => true }
    );
    await expect(completeGuidedSetup(layout)).rejects.toThrow(/BOOTSTRAP/);
    await unlink(join(workspacePath, 'BOOTSTRAP.md'));
    await expect(completeGuidedSetup(layout)).resolves.toContain('最低限のセットアップが完了');
    expect(
      JSON.parse(await readFile(join(layout.configDir, 'onboarding.json'), 'utf8'))
    ).toMatchObject({ phase: 'minimum_ready', notionSyncEnabled: false });
    await expect(readOnboardingStatus(layout)).resolves.toMatchObject({
      phase: 'minimum_ready',
      backend: 'codex',
      workspacePath,
      webChatAccess: 'local',
      notionSyncEnabled: false,
    });
  });

  it('reports preflight before onboarding state exists and rejects invalid phases', async () => {
    const { layout } = await fixture();
    await expect(readOnboardingStatus(layout)).resolves.toEqual({ phase: 'preflight' });
    await mkdir(layout.configDir, { recursive: true });
    await writeFile(
      join(layout.configDir, 'onboarding.json'),
      JSON.stringify({ phase: 'unknown' })
    );
    await expect(readOnboardingStatus(layout)).rejects.toThrow(/Invalid onboarding phase/);
  });
});
