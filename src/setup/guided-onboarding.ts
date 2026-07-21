import { spawn, spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import readline from 'node:readline/promises';
import type { SetupBackend } from './schema.js';
import { parseSetupConfig } from './schema.js';
import { verifyBackendExecutable } from './backend-executable.js';
import { SetupStore } from './store.js';
import type { AppLayout } from '../installer/types.js';

export interface OnboardingStatus {
  phase: 'preflight' | 'bootstrap_in_progress' | 'minimum_ready';
  backend?: string;
  backendExecutable?: string;
  workspacePath?: string;
  workspaceMode?: string;
  webChatAccess?: string;
  notionSyncEnabled?: boolean;
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
  canExecute?: (path: string) => Promise<boolean>;
  version?: (command: string) => string | undefined;
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
  const directories = (options.pathEnv ?? process.env.PATH ?? '').split(delimiter).filter(Boolean);
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
    ((command: string) => {
      const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5_000 });
      if (result.status !== 0) return undefined;
      return (
        String(result.stdout || result.stderr || '')
          .trim()
          .split('\n')[0] || undefined
      );
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
      const detectedVersion = version(executable);
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

export function aiToolSetupGuide(tool = 'codex'): string {
  return `bash <(curl -fsSL ${AI_TOOL_SETUP_URL}) ${tool}`;
}

export function missingBackendGuide(): string {
  return [
    '対応しているAIエージェントCLIがPATH上に見つかりませんでした。',
    'xangiとは独立したAIコーディングツール用スクリプトで、いずれかをセットアップしてください:',
    aiToolSetupGuide(),
    '利用可能な引数: codex / claude-code / cursor / grok / antigravity',
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

async function defaultSelectBackend(backends: DetectedBackend[]): Promise<DetectedBackend> {
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
      : '- 既知の場所には見つかりませんでした';
  const templateChoice = `GitHubのkaraage0703/ai-assistant-workspaceから選択時点のmain最新commitをGitなしで取得する推奨テンプレートを、既定path ${join(options.homeDir, 'ai-assistant-workspace')} へ作成する方法`;
  const workspaceFlow =
    options.workspaceCandidates.length > 0
      ? `1. 検出したworkspaceのいずれかを使うか、日本語で確認してください。home directoryを再帰的に検索しないでください。利用者が候補を選ばない場合は、${templateChoice}、空の新規workspace、別の絶対pathにある既存workspaceの順に案内してください。`
      : `1. 「既知のworkspaceは見つかりませんでした」と日本語で伝えてください。最初に、${templateChoice}。代替として、空の新規workspace、別の絶対pathにある既存workspaceも選べると案内してください。`;
  const readmePath = join(options.documentationRoot, 'README.md');
  const usagePath = join(options.documentationRoot, 'docs', 'usage.md');
  const discordSetupPath = join(options.documentationRoot, 'docs', 'discord-setup.md');
  const startCommand =
    options.installationKind === 'managed'
      ? `${options.launcherCommand} install`
      : `${options.launcherCommand} service start`;
  const startupFlow = `10. 終了前に${readmePath}の起動手順を読み、xangiを今起動するか確認してください。起動する場合は\`${startCommand}\`を実行してください。次に、OSへのログインまたはOS起動時にもxangiを自動起動するかを別の質問として明示的に確認してください。利用者が明確に希望した場合だけ\`${options.launcherCommand} service autostart enable\`を実行し、希望しない場合や回答が曖昧な場合は自動起動を登録しないでください。後から解除するcommandは\`${options.launcherCommand} service autostart disable\`だと案内してください。その後\`${options.launcherCommand} doctor\`を実行し、doctorのservice、health、runtime-workspaceが正常になり、実際のworkspaceが設定値と一致したことを確認してからだけ「セットアップ完了」と伝えてください。今は起動しない場合は、起動commandとdoctorで確認する必要があることを日本語で案内してください。PM2など必要softwareが無い場合は勝手にinstallせず、公式手順を説明して許可を得てください。`;
  return `あなたはxangiの初回セットアップを案内します。利用者への質問、説明、確認、要約はすべて日本語にしてください。短い質問を一度に一つだけ行い、回答を決めつけないでください。

ルールベースの事前確認で${options.backend.label}が選択されました。設定内容の検証と保存はあなたではなくxangiが行います。

ルールベースで検出したworkspace:
${candidates}

必須の進行順:
${workspaceFlow}
2. Web Chatをどこから使うか、次の3択を一問だけで確認してください。回答を決めつけないでください:
   - この端末のみ（既定・推奨）: 127.0.0.1
   - Tailscale経由: Web Chatはloopbackのまま、Tailscale Serveでtailnet内だけへ転送する
   - LAN内の他端末: 0.0.0.0。Web Chat自体には認証がなく、同じLANの到達可能な端末からアクセスできると事前に警告する
3. 利用者がworkspaceの絶対path・方式・Web Chatのアクセス範囲を選んだら、placeholderを置き換えて次のコマンドだけを実行してください:
   ${options.launcherCommand} setup --apply --backend ${options.backend.id} --workspace <ABSOLUTE_PATH> --workspace-mode <existing|template|blank> --web-chat-access <local|tailscale|lan>
4. Web Chatの公開経路を安全に揃えてください。Tailscaleを選んだ場合は、\`tailscale status\`で利用可能と確認し、\`tailscale serve status --json\`でTCP ${webChatPort}が別の転送先に使われていないことを確認してから次を実行してください。設定後はTCP ${webChatPort}から127.0.0.1:${webChatPort}への転送を確認し、Funnelは使わないでください。localまたはlanを選んだ場合は、tailscale commandが利用できる時だけServe statusを確認し、同じxangi向け転送が残っている場合だけ\`tailscale serve --tcp=${webChatPort} off\`でそのportを解除してください。Tailscale未導入はlocal/lanのエラーにしません。別の転送先や他のServe/Funnel設定は変更しないでください。失敗したら別方式へ勝手に切り替えず、エラーを説明してください:
   tailscale serve --bg --tcp=${webChatPort} tcp://127.0.0.1:${webChatPort}
5. 選んだworkspaceへ移動してください。BOOTSTRAP.mdがあれば読み、その指示に従ってください。空の新規workspaceではxangiが安全なBOOTSTRAP.mdを作成します。
6. 最初は名前、AIの人格、重要なルールなど最低限だけを設定してください。
7. 最低限のセットアップが終わり、BOOTSTRAP.mdの指示に従って同ファイルが削除されたら次を実行してください:
   ${options.launcherCommand} setup --complete
8. その後、すぐxangiを使い始めるか、追加設定を続けるか日本語で確認してください。
9. Discord、Notion同期、他のchat platform、schedule、skillなどxangi自体の設定では、workspace内にxangiのオンボーディング手順を探してはいけません。workspaceはAIの人格、BOOTSTRAP、利用者データのための場所です。必ずxangi本体に同梱された次の公式documentを必要な範囲だけ読んでから、一問ずつ案内してください:
   - README: ${readmePath}
   - CLIと設定のusage: ${usagePath}
   - Discord設定: ${discordSetupPath}
   利用者が明示的に選ばない限りNotion同期はOFFのままにしてください。
   secretやtokenをAIとの会話へ貼り付けるよう求めたり、read・printf・echoなどのshell commandを組み立てて保存させたりしないでください。Discord、Slack、LINE、Telegram、Notionのtoken設定が必要な場合は、利用者自身がTerminalで\`${options.launcherCommand} settings\`を実行し、ローカルの専用設定画面へ入力すると案内してください。Notion同期では同じ画面で親ページIDまたはURLも入力し、その後に\`${options.launcherCommand} notion-sync enable\`を実行します。workspace全体を自動検出するため、個別Markdownの相対path、同期方向、YAML manifestを質問してはいけません。
${startupFlow}

任意のsoftwareを勝手にインストールしたり、署名されていないworkspace templateを取得したり、secretを表示したり、利用者の明示的な選択なしに外部連携を有効化したりしないでください。`;
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
    visiblePrompt: `xangiのセットアップを始めます。最初に ${instructionPath} を読み、その指示に従って日本語で一問ずつ案内してください。`,
    instructionPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function defaultLaunchGuidedBackend(
  selected: DetectedBackend,
  initialPrompt: string,
  cwd: string
): Promise<number> {
  const prepared = await prepareOnboardingLaunch(initialPrompt);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(selected.executable, [prepared.visiblePrompt], {
        cwd,
        env: process.env,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
  } finally {
    await prepared.cleanup();
  }
}

export async function guidedSetupCmd(options: GuidedSetupOptions): Promise<string> {
  const backends = await detectGuidedBackends(options);
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
  const backend = await (options.selectBackend ?? defaultSelectBackend)(readyBackends);
  if (!readyBackends.some((candidate) => candidate.id === backend.id)) {
    throw new Error('選択したAIエージェントは事前確認で検出されていません');
  }
  await options.onSelected?.(backend);
  const homeDir = options.homeDir ?? homedir();
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
  return `${backend.label}によるAIガイド付きセットアップが終了しました。\`xangi doctor\`で結果を確認してください。`;
}

export type WorkspaceMode = 'existing' | 'template' | 'blank';

export interface ApplySetupOptions {
  backend: string;
  backendExecutable?: string;
  workspacePath: string;
  workspaceMode: string;
  notionSyncEnabled?: boolean;
  webChatEnabled?: boolean;
  webChatAccess?: string;
}

export interface ApplySetupDependencies {
  layout: AppLayout;
  initializeTemplate?: (layout: AppLayout) => Promise<unknown>;
  backendAvailable?: (backend: SetupBackend, executable?: string) => Promise<boolean>;
}

const BLANK_BOOTSTRAP = `# BOOTSTRAP.md

新しい個人AIアシスタント用workspaceをセットアップします。

すべて日本語で一度に一つずつ質問し、最低限必要なファイルを作成してください:

1. 利用者の名前と希望する呼び方を聞く。
2. AIアシスタントの名前と振る舞い方を聞く。
3. 重要な禁止事項と、実行前に確認が必要な操作を聞く。
4. 合意した人格、ルール、workspaceの約束をAGENTS.mdへ記録する。
5. 情報を分かりやすく分離できる場合だけUSER.mdとCHARACTER.mdを作る。
6. すぐ使い始めるか、追加の外部連携設定を続けるか確認する。

最低限のセットアップが完了した後だけ、このファイルを削除してください。
`;

export async function writeOnboardingState(
  layout: AppLayout,
  value: Record<string, unknown>
): Promise<void> {
  const path = join(layout.configDir, 'onboarding.json');
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
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
      workspacePath: typeof value.workspacePath === 'string' ? value.workspacePath : undefined,
      workspaceMode: typeof value.workspaceMode === 'string' ? value.workspaceMode : undefined,
      webChatAccess: typeof value.webChatAccess === 'string' ? value.webChatAccess : undefined,
      notionSyncEnabled:
        typeof value.notionSyncEnabled === 'boolean' ? value.notionSyncEnabled : undefined,
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
      workspacePath: options.workspacePath,
      webChatEnabled: options.webChatEnabled ?? true,
      webChatAccess: options.webChatAccess ?? 'local',
      notionSyncEnabled: options.notionSyncEnabled ?? false,
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
    workspacePath: setup.workspacePath,
    webChatAccess: setup.webChatAccess,
    notionSyncEnabled: setup.notionSyncEnabled,
    updatedAt: new Date().toISOString(),
  });
  return '最低限のセットアップが完了しました。Discord、Notion、schedule、skillは後から設定できます。';
}

export function launcherCommand(path: string): string {
  return path.endsWith('.js')
    ? `${shellQuote(process.execPath)} ${shellQuote(path)}`
    : shellQuote(path);
}
