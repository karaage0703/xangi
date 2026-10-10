import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import readline from 'node:readline/promises';
import type { SetupBackend, SetupWebChatAccess } from './schema.js';
import { parseSetupConfig, SETUP_WEB_CHAT_ACCESS } from './schema.js';
import { verifyBackendExecutable } from './backend-executable.js';
import { SetupStore } from './store.js';
import { writePrivateJsonFile } from './private-json-file.js';
import type { AppLayout } from '../installer/types.js';

export interface OnboardingStatus {
  phase: 'preflight' | 'bootstrap_in_progress' | 'minimum_ready';
  backend?: string;
  backendExecutable?: string;
  model?: string;
  opencodeConfigPath?: string;
  workspacePath?: string;
  workspaceMode?: string;
  webChatAccess?: string;
  updatedAt?: string;
}

export interface GuidedBackend {
  id: Exclude<SetupBackend, 'local-llm'>;
  label: string;
  command: string;
  authCheck?: readonly string[];
  authGuide: string;
}

export const GUIDED_BACKENDS: readonly GuidedBackend[] = [
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    authCheck: ['login', 'status'],
    authGuide: 'codex login',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    authGuide: 'opencode auth login（またはOpenAI互換providerを設定）',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    authCheck: ['auth', 'status'],
    authGuide: 'claude auth login',
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    command: 'cursor-agent',
    authCheck: ['status'],
    authGuide: 'cursor-agent login',
  },
  {
    id: 'grok',
    label: 'Grok CLI',
    command: 'grok',
    authGuide: 'grok login',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    command: 'agy',
    authGuide: 'agyを初回起動して認証',
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot CLI',
    command: 'copilot',
    authGuide: 'copilot を起動して /login（または COPILOT_GITHUB_TOKEN）',
  },
] as const;

const AI_TOOL_SETUP_URL =
  'https://github.com/karaage0703/xangi/releases/latest/download/setup-ai-tools.sh';

export interface DetectedBackend extends GuidedBackend {
  executable: string;
  version?: string;
  authenticated?: boolean;
}

export interface DetectBackendsOptions {
  pathEnv?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  canExecute?: (path: string) => Promise<boolean>;
  version?: (command: string) => string | undefined | Promise<string | undefined>;
  authStatus?: (command: string, args: readonly string[]) => boolean;
}

export class SetupPrerequisiteError extends Error {
  readonly exitCode = 3;

  constructor(message: string) {
    super(message);
    this.name = 'SetupPrerequisiteError';
  }
}

export async function detectGuidedBackends(
  options: DetectBackendsOptions = {}
): Promise<DetectedBackend[]> {
  const directories = await backendSearchDirectories(options);
  const canExecute =
    options.canExecute ??
    (async (path: string) => {
      try {
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const version =
    options.version ??
    (async (command: string) => {
      try {
        const result = await promisify(execFile)(command, ['--version'], {
          encoding: 'utf8',
          timeout: 5_000,
          maxBuffer: 256 * 1024,
        });
        return (result.stdout || result.stderr || '').trim().split('\n')[0] || undefined;
      } catch {
        return undefined;
      }
    });
  const authStatus =
    options.authStatus ??
    ((command: string, args: readonly string[]) => {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5_000 });
      return result.status === 0;
    });
  const detected: DetectedBackend[] = [];
  for (const backend of GUIDED_BACKENDS) {
    for (const directory of directories) {
      if (!isAbsolute(directory)) continue;
      const executable = join(directory, backend.command);
      if (!(await canExecute(executable))) continue;
      const detectedVersion = await version(executable);
      if (!detectedVersion) continue;
      detected.push({
        ...backend,
        executable,
        version: detectedVersion,
        authenticated: backend.authCheck ? authStatus(executable, backend.authCheck) : undefined,
      });
      break;
    }
  }
  return detected;
}

async function backendSearchDirectories(options: DetectBackendsOptions): Promise<string[]> {
  const env = options.env ?? process.env;
  const directories = (options.pathEnv ?? env.PATH ?? '').split(delimiter).filter(isAbsolute);
  if (env.NVM_BIN && isAbsolute(env.NVM_BIN)) directories.push(env.NVM_BIN);

  // Supplying pathEnv makes unit tests and callers explicitly PATH-only unless a home is also given.
  const homeDir = options.homeDir ?? (options.pathEnv === undefined ? homedir() : undefined);
  const nvmDir =
    env.NVM_DIR && isAbsolute(env.NVM_DIR) ? env.NVM_DIR : homeDir && join(homeDir, '.nvm');
  if (nvmDir) {
    try {
      const versions = await readdir(join(nvmDir, 'versions', 'node'), { withFileTypes: true });
      versions
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
        .forEach((version) => directories.push(join(nvmDir, 'versions', 'node', version, 'bin')));
    } catch {
      // NVM is optional. An unavailable NVM directory must not hide CLIs already found on PATH.
    }
  }
  return [...new Set(directories)];
}

export function aiToolSetupGuide(tool = 'codex'): string {
  return `bash <(curl -fsSL ${AI_TOOL_SETUP_URL}) ${tool}`;
}

export function missingBackendGuide(): string {
  return [
    '対応しているAIエージェントCLIがPATH上に見つかりませんでした。',
    'xangiとは独立したAIコーディングツール用スクリプトで、いずれかをセットアップしてください:',
    aiToolSetupGuide(),
    '利用可能な引数: codex / claude-code / cursor / grok / antigravity / github-copilot / opencode',
    '完了後、もう一度 `xangi setup` を実行してください。',
    '- ローカルLLMはセットアップ後に利用できますが、この対話型オンボーディング自体は実行できません。',
  ].join('\n');
}

export function authenticationGuide(
  backends: readonly DetectedBackend[],
  options: { blocking?: boolean } = {}
): string {
  const blocking = options.blocking ?? true;
  return [
    blocking
      ? '検出したAIエージェントCLIの認証が完了していません。'
      : '次のAIエージェントCLIは認証未完了のため、今回の選択肢から除外します。',
    ...backends.map((backend) => `- ${backend.label}: ${backend.authGuide}`),
    '単体セットアップスクリプトを使う場合:',
    aiToolSetupGuide(backends[0]?.id ?? 'codex'),
    blocking
      ? '認証後、もう一度 `xangi setup` を実行してください。'
      : '現在のセットアップは、認証済みのAIエージェントCLIで続行します。',
  ].join('\n');
}

export async function selectGuidedBackend(backends: DetectedBackend[]): Promise<DetectedBackend> {
  if (backends.length === 1) return backends[0]!;
  console.log('利用可能なAIエージェント:');
  backends.forEach((backend, index) =>
    console.log(`${index + 1}. ${backend.label}${backend.version ? ` (${backend.version})` : ''}`)
  );
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await terminal.question(
        'セットアップを案内するAIエージェントを選んでください: '
      );
      const selected = Number(answer);
      if (Number.isInteger(selected) && selected >= 1 && selected <= backends.length) {
        return backends[selected - 1]!;
      }
      console.log(`1から${backends.length}までの番号を入力してください。`);
    }
  } finally {
    terminal.close();
  }
}

export interface DetectWorkspacesOptions {
  homeDir: string;
  cwd: string;
  workspaceEnv?: string;
}

export async function detectKnownWorkspaces(options: DetectWorkspacesOptions): Promise<string[]> {
  const candidates = [
    options.workspaceEnv,
    options.cwd,
    join(options.homeDir, 'ai-assistant-workspace'),
    join(options.homeDir, 'xangi-workspace'),
  ].filter((value): value is string => Boolean(value && isAbsolute(value)));
  const result: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!(await stat(candidate)).isDirectory()) continue;
      const entries = await readdir(candidate);
      const knownHomePath =
        candidate === join(options.homeDir, 'ai-assistant-workspace') ||
        candidate === join(options.homeDir, 'xangi-workspace');
      if (!knownHomePath && !entries.includes('AGENTS.md') && !entries.includes('BOOTSTRAP.md')) {
        continue;
      }
      result.push(candidate);
    } catch {
      // Missing and unreadable candidates are not offered.
    }
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildOnboardingPrompt(options: {
  backend: DetectedBackend;
  launcherCommand: string;
  documentationRoot: string;
  installationKind: 'checkout' | 'managed';
  homeDir: string;
  workspaceCandidates: string[];
  webChatPort?: number;
}): string {
  const webChatPort = options.webChatPort ?? 18888;
  const candidates =
    options.workspaceCandidates.length > 0
      ? options.workspaceCandidates.map((path) => `- ${path}`).join('\n')
      : '- None found in known locations';
  const templateChoice = `the recommended template at the default path ${join(options.homeDir, 'ai-assistant-workspace')}, fetched without Git from the latest main commit of karaage0703/ai-assistant-workspace on GitHub at selection time`;
  const workspaceFlow =
    options.workspaceCandidates.length > 0
      ? `1. Ask in Japanese whether to use one of the detected workspaces. Do not recursively search the home directory. If the user selects none, offer ${templateChoice}, a new blank workspace, and an existing workspace at another absolute path, in that order.`
      : `1. Tell the user in Japanese that no known workspace was found. First offer ${templateChoice}. Also offer a new blank workspace or an existing workspace at another absolute path as alternatives.`;
  const readmePath = join(options.documentationRoot, 'README.md');
  const usagePath = join(options.documentationRoot, 'docs', 'usage.md');
  const discordSetupPath = join(options.documentationRoot, 'docs', 'discord-setup.md');
  const startCommand =
    options.installationKind === 'managed'
      ? `${options.launcherCommand} install`
      : `${options.launcherCommand} service start`;
  const startupFlow = `6. Read ${readmePath} for startup instructions, then run \`${startCommand}\` to start xangi locally. Then run \`${options.launcherCommand} doctor\` and verify config, workspace, backend, service, health, and runtime-workspace, including that the actual workspace matches the configured value. Do not inspect or change Tailscale status or Serve settings yet. If required software such as PM2 is missing, explain the official installation steps and obtain permission instead of installing it unilaterally. Report basic setup complete only after all these local checks pass. Then separately ask whether xangi should start automatically at OS login or boot. Only if the user explicitly wants this, run \`${options.launcherCommand} service autostart enable\`; do not register autostart if the user declines or their answer is unclear. The command to disable it later is \`${options.launcherCommand} service autostart disable\`.`;
  return `Guide initial xangi setup. Ask questions, explain, confirm, and summarize in Japanese. Ask one short question at a time without assuming the answer.

Rule-based preflight selected ${options.backend.label}. xangi validates and saves settings; you do not.

Workspaces detected by rule-based checks:
${candidates}

Required sequence:
${workspaceFlow}
2. Once the user selects the workspace absolute path and mode, replace placeholders and run only the following local command without asking about Web Chat access scope:
   ${options.launcherCommand} setup --apply --backend ${options.backend.id} --workspace <ABSOLUTE_PATH> --workspace-mode <existing|template|blank> --web-chat-access local
3. Change to the selected workspace. If BOOTSTRAP.md exists, read and follow it. xangi creates a safe BOOTSTRAP.md for a new blank workspace.
4. Initially configure only essentials such as names, AI personality, and important rules.
5. After minimal setup is complete and BOOTSTRAP.md has been deleted according to its instructions, run:
   ${options.launcherCommand} setup --complete
${startupFlow}
7. Only after basic setup works locally, ask one question: use only this device or other devices too? For this device only, keep local access and run no Tailscale commands. Only for other-device access, offer:
   - Tailscale: keep Web Chat on loopback and forward only within the tailnet using Tailscale Serve
   - Other LAN devices: 0.0.0.0. Warn first that Web Chat itself has no authentication and is accessible to reachable devices on the same LAN
8. Only if Tailscale is selected, verify availability with \`tailscale status\` and use \`tailscale serve status --json\` to confirm TCP ${webChatPort} is not forwarding elsewhere before running the following. Afterward, verify forwarding from TCP ${webChatPort} to 127.0.0.1:${webChatPort}. Do not use Funnel or change other forwarding destinations or Serve/Funnel settings. If routing setup fails, explain that the optional setup failed and finish with local settings:
   tailscale serve --bg --tcp=${webChatPort} tcp://127.0.0.1:${webChatPort}
   Only after Tailscale forwarding verification succeeds: ${options.launcherCommand} setup --access tailscale
9. Only if LAN is selected and the user explicitly accepts the warning, run:
   ${options.launcherCommand} setup --access lan
10. Only if access settings changed, run \`${options.launcherCommand} service restart\` and \`${options.launcherCommand} doctor\` and report whether verification of the selected access path succeeded.
11. Then ask in Japanese whether to start using xangi now or continue configuring Discord, other chat platforms, schedules, skills, or other extras. Do not search the workspace for xangi onboarding instructions when configuring xangi itself. The workspace contains AI personality, BOOTSTRAP, and user data. Read relevant parts of the following official documents bundled with xangi before guiding the user one question at a time:
   - README: ${readmePath}
   - CLI and settings usage: ${usagePath}
   - Discord setup: ${discordSetupPath}
   Do not ask users to paste secrets or tokens into the AI conversation or construct shell commands such as read, printf, or echo to save them. For Discord allowed user IDs or Discord, Slack, LINE, or Telegram tokens, tell the user to run \`${options.launcherCommand} settings\` themselves in Terminal and enter values in the dedicated local settings screen.
Do not unilaterally install software, fetch unsigned workspace templates, display secrets, or enable external integrations without an explicit user choice.`;
}

export interface GuidedSetupOptions extends DetectBackendsOptions {
  homeDir?: string;
  cwd?: string;
  workspaceEnv?: string;
  launcherCommand: string;
  documentationRoot: string;
  installationKind: 'checkout' | 'managed';
  webChatPort?: number;
  selectBackend?: (backends: DetectedBackend[]) => Promise<DetectedBackend>;
  onSelected?: (backend: DetectedBackend) => Promise<void>;
  launch?: (backend: DetectedBackend, prompt: string, cwd: string) => Promise<number>;
}

export async function prepareOnboardingLaunch(initialPrompt: string): Promise<{
  visiblePrompt: string;
  instructionPath: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'xangi-onboarding-'));
  await chmod(directory, 0o700);
  const instructionPath = join(directory, 'instructions.md');
  await writeFile(instructionPath, initialPrompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(instructionPath, 0o600);
  return {
    visiblePrompt: `Begin xangi setup. First read ${instructionPath}, then follow its instructions and guide the user in Japanese, one question at a time.`,
    instructionPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function buildGuidedLaunchArgs(
  selected: DetectedBackend,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (selected.id === 'opencode') {
    return [
      'run',
      '--auto',
      '--agent',
      'build',
      ...(env.AGENT_MODEL ? ['--model', env.AGENT_MODEL] : []),
      prompt,
    ];
  } else if (selected.id === 'antigravity') {
    return ['-i', prompt];
  }
  return [prompt];
}

async function defaultLaunchGuidedBackend(
  selected: DetectedBackend,
  initialPrompt: string,
  cwd: string
): Promise<number> {
  const prepared = await prepareOnboardingLaunch(initialPrompt);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(
        selected.executable,
        buildGuidedLaunchArgs(selected, prepared.visiblePrompt),
        {
          cwd,
          env: process.env,
          stdio: 'inherit',
        }
      );
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
  } finally {
    await prepared.cleanup();
  }
}

export async function guidedSetupCmd(options: GuidedSetupOptions): Promise<string> {
  const homeDir = options.homeDir ?? homedir();
  const backends = await detectGuidedBackends({ ...options, homeDir });
  if (backends.length === 0) {
    throw new SetupPrerequisiteError(missingBackendGuide());
  }
  const readyBackends = backends.filter((backend) => backend.authenticated !== false);
  const unauthenticated = backends.filter((backend) => backend.authenticated === false);
  if (readyBackends.length === 0) {
    throw new SetupPrerequisiteError(authenticationGuide(unauthenticated));
  }
  if (unauthenticated.length > 0)
    console.log(authenticationGuide(unauthenticated, { blocking: false }));
  const backend = await (options.selectBackend ?? selectGuidedBackend)(readyBackends);
  if (!readyBackends.some((candidate) => candidate.id === backend.id)) {
    throw new Error('選択したAIエージェントは事前確認で検出されていません');
  }
  await options.onSelected?.(backend);
  const workspaceCandidates = await detectKnownWorkspaces({
    homeDir,
    cwd: options.cwd ?? process.cwd(),
    workspaceEnv: options.workspaceEnv ?? process.env.WORKSPACE_PATH,
  });
  const prompt = buildOnboardingPrompt({
    backend,
    launcherCommand: options.launcherCommand,
    documentationRoot: options.documentationRoot,
    installationKind: options.installationKind,
    webChatPort: options.webChatPort,
    homeDir,
    workspaceCandidates,
  });
  const launch = options.launch ?? defaultLaunchGuidedBackend;
  const code = await launch(backend, prompt, homeDir);
  if (code !== 0)
    throw new Error(`${backend.label}のオンボーディングが終了コード${code}で終了しました`);
  return `${backend.label}によるAIガイド付きセットアップが終了しました。\`xangi doctor\`で結果を確認してください。困ったときは \`${options.launcherCommand} rescue\` でAIに診断・修復を依頼できます。`;
}

export type WorkspaceMode = 'existing' | 'template' | 'blank';

export interface ApplySetupOptions {
  backend: string;
  backendExecutable?: string;
  model?: string;
  opencodeConfigPath?: string;
  workspacePath: string;
  workspaceMode: string;
  webChatEnabled?: boolean;
  webChatAccess?: string;
}

export interface ApplySetupDependencies {
  layout: AppLayout;
  initializeTemplate?: (layout: AppLayout) => Promise<unknown>;
  backendAvailable?: (backend: SetupBackend, executable?: string) => Promise<boolean>;
}

const BLANK_BOOTSTRAP = `# BOOTSTRAP.md

Set up a new workspace for a personal AI assistant.

Ask one question at a time in Japanese and create only the essential files:

1. Ask the user's name and preferred form of address.
2. Ask the AI assistant's name and desired behavior.
3. Ask about important prohibitions and actions requiring confirmation before execution.
4. Record the agreed personality, rules, and workspace conventions in AGENTS.md.
5. Create USER.md and CHARACTER.md only if they help separate information clearly.
6. Ask whether to start using the assistant now or continue setting up external integrations.

Delete this file only after minimal setup is complete.
`;

export async function writeOnboardingState(
  layout: AppLayout,
  value: Record<string, unknown>
): Promise<void> {
  await writePrivateJsonFile(join(layout.configDir, 'onboarding.json'), value);
}

export async function readOnboardingStatus(layout: AppLayout): Promise<OnboardingStatus> {
  try {
    const value = JSON.parse(
      await readFile(join(layout.configDir, 'onboarding.json'), 'utf8')
    ) as Record<string, unknown>;
    if (
      value.phase !== 'preflight' &&
      value.phase !== 'bootstrap_in_progress' &&
      value.phase !== 'minimum_ready'
    ) {
      throw new Error('Invalid onboarding phase');
    }
    return {
      phase: value.phase,
      backend: typeof value.backend === 'string' ? value.backend : undefined,
      backendExecutable:
        typeof value.backendExecutable === 'string' ? value.backendExecutable : undefined,
      model: typeof value.model === 'string' ? value.model : undefined,
      opencodeConfigPath:
        typeof value.opencodeConfigPath === 'string' ? value.opencodeConfigPath : undefined,
      workspacePath: typeof value.workspacePath === 'string' ? value.workspacePath : undefined,
      workspaceMode: typeof value.workspaceMode === 'string' ? value.workspaceMode : undefined,
      webChatAccess: typeof value.webChatAccess === 'string' ? value.webChatAccess : undefined,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { phase: 'preflight' };
    throw error;
  }
}

export async function applyGuidedSetup(
  options: ApplySetupOptions,
  dependencies: ApplySetupDependencies
): Promise<string> {
  if (!GUIDED_BACKENDS.some((backend) => backend.id === options.backend)) {
    throw new Error('対応していないAIガイド用backendです');
  }
  if (!isAbsolute(options.workspacePath))
    throw new Error('workspace pathは絶対pathで指定してください');
  if (!['existing', 'template', 'blank'].includes(options.workspaceMode)) {
    throw new Error('workspace modeはexisting、template、blankのいずれかです');
  }
  const backend = options.backend as SetupBackend;
  const backendExecutable = options.backendExecutable
    ? await verifyBackendExecutable(backend, options.backendExecutable)
    : undefined;
  if (
    dependencies.backendAvailable &&
    !(await dependencies.backendAvailable(backend, backendExecutable))
  ) {
    throw new Error(`選択したbackend ${backend}は現在利用できません`);
  }
  const mode = options.workspaceMode as WorkspaceMode;
  if (mode === 'existing') {
    try {
      await access(options.workspacePath, constants.R_OK | constants.W_OK);
    } catch {
      throw new Error('既存workspaceには読み取り・書き込み権限が必要です');
    }
  } else {
    await mkdir(options.workspacePath, { recursive: true });
  }
  if (mode === 'blank' && (await readdir(options.workspacePath)).length > 0) {
    throw new Error('空の新規workspaceには空のdirectoryを指定してください');
  }
  let previousConfig: string | undefined;
  try {
    previousConfig = await readFile(dependencies.layout.configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let bootstrapCreated = false;
  try {
    await new SetupStore(dependencies.layout.configFile).save({
      backend,
      ...(backendExecutable ? { backendExecutable } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.opencodeConfigPath ? { opencodeConfigPath: options.opencodeConfigPath } : {}),
      workspacePath: options.workspacePath,
      webChatEnabled: options.webChatEnabled ?? true,
      webChatAccess: options.webChatAccess ?? 'local',
    });
    if (mode === 'template') {
      if (!dependencies.initializeTemplate) {
        throw new Error('workspaceテンプレート取得機能を利用できません');
      }
      await dependencies.initializeTemplate(dependencies.layout);
    } else if (mode === 'blank') {
      const bootstrapPath = join(options.workspacePath, 'BOOTSTRAP.md');
      await writeFile(bootstrapPath, BLANK_BOOTSTRAP, { flag: 'wx', mode: 0o600 });
      bootstrapCreated = true;
    }
    await writeOnboardingState(dependencies.layout, {
      schemaVersion: 1,
      phase: 'bootstrap_in_progress',
      backend,
      ...(backendExecutable ? { backendExecutable } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.opencodeConfigPath ? { opencodeConfigPath: options.opencodeConfigPath } : {}),
      workspacePath: options.workspacePath,
      workspaceMode: mode,
      webChatAccess: options.webChatAccess ?? 'local',
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (bootstrapCreated) {
      await unlink(join(options.workspacePath, 'BOOTSTRAP.md')).catch(() => undefined);
    }
    if (previousConfig === undefined) {
      await unlink(dependencies.layout.configFile).catch(() => undefined);
    } else {
      await writeFile(dependencies.layout.configFile, previousConfig, { mode: 0o600 });
      await chmod(dependencies.layout.configFile, 0o600);
    }
    throw error;
  }
  return `セットアップ設定を保存しました。${options.workspacePath}でAIとの対話を続けてください。`;
}

export async function completeGuidedSetup(layout: AppLayout): Promise<string> {
  const setup = parseSetupConfig(JSON.parse(await readFile(layout.configFile, 'utf8')) as unknown);
  try {
    await access(setup.workspacePath, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error('設定済みworkspaceを利用できません');
  }
  try {
    await access(join(setup.workspacePath, 'BOOTSTRAP.md'));
    throw new Error('BOOTSTRAP.mdが残っています。最低限のオンボーディングを完了してください');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeOnboardingState(layout, {
    schemaVersion: 1,
    phase: 'minimum_ready',
    backend: setup.backend,
    ...(setup.backendExecutable ? { backendExecutable: setup.backendExecutable } : {}),
    ...(setup.model ? { model: setup.model } : {}),
    ...(setup.opencodeConfigPath ? { opencodeConfigPath: setup.opencodeConfigPath } : {}),
    workspacePath: setup.workspacePath,
    webChatAccess: setup.webChatAccess,
    updatedAt: new Date().toISOString(),
  });
  return '最低限のセットアップが完了しました。Discord、schedule、skillは後から設定できます。';
}

export async function updateGuidedSetupAccess(layout: AppLayout, access: string): Promise<string> {
  if (!(SETUP_WEB_CHAT_ACCESS as readonly string[]).includes(access)) {
    throw new Error('Web Chat accessはlocal、tailscale、lanのいずれかです');
  }
  const config = parseSetupConfig(JSON.parse(await readFile(layout.configFile, 'utf8')) as unknown);
  const onboarding = await readOnboardingStatus(layout);
  if (onboarding.phase !== 'minimum_ready') {
    throw new Error('最低限のセットアップ完了後にaccessを変更してください');
  }
  const webChatAccess = access as SetupWebChatAccess;
  await new SetupStore(layout.configFile).save({ ...config, webChatAccess });
  try {
    await writeOnboardingState(layout, {
      ...onboarding,
      schemaVersion: 1,
      webChatAccess,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    await new SetupStore(layout.configFile).save(config);
    throw error;
  }
  return `Web Chat accessを${webChatAccess}に変更しました。serviceをrestartし、xangi doctorで確認してください。`;
}

export function launcherCommand(path: string): string {
  return path.endsWith('.js')
    ? `${shellQuote(process.execPath)} ${shellQuote(path)}`
    : shellQuote(path);
}
