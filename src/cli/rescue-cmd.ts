import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { AppLayout } from '../installer/types.js';
import {
  authenticationGuide,
  buildGuidedLaunchArgs,
  detectGuidedBackends,
  type DetectedBackend,
  type DetectBackendsOptions,
  missingBackendGuide,
  selectGuidedBackend,
  SetupPrerequisiteError,
} from '../setup/guided-onboarding.js';
import { parseSetupConfig, type SetupConfig } from '../setup/schema.js';

export interface RescueCommandOptions extends DetectBackendsOptions {
  layout: AppLayout;
  homeDir: string;
  launcherCommand: string;
  documentationRoot: string;
  installationKind: 'checkout' | 'managed';
  checkoutDir?: string;
  selectBackend?: (backends: DetectedBackend[]) => Promise<DetectedBackend>;
  launch?: (backend: DetectedBackend, prompt: string, cwd: string) => Promise<number>;
}

async function readSetupConfig(path: string): Promise<SetupConfig | undefined> {
  try {
    return parseSetupConfig(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

async function resolveRescueCwd(candidates: Array<string | undefined>): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.R_OK | constants.W_OK);
      return candidate;
    } catch {
      // A broken configured workspace is itself something rescue must be able to repair.
    }
  }
  throw new Error('AIエージェントを起動できる復旧作業directoryが見つかりません');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildRescuePrompt(options: {
  launcherCommand: string;
  documentationRoot: string;
  installationKind: 'checkout' | 'managed';
  layout: AppLayout;
  checkoutDir?: string;
  config?: SetupConfig;
}): string {
  const targetDir = options.checkoutDir ?? options.documentationRoot;
  const workspace = options.config?.workspacePath ?? '(設定を読み取れないため調査してください)';
  const logs = join(options.layout.stateDir, 'logs');
  const targetFlag = options.checkoutDir ? ` --dir ${shellQuote(options.checkoutDir)}` : '';
  return `あなたはxangiの復旧担当AIエージェントです。利用者はxangiのエラーを直すために、このセッションを明示的に起動しました。質問と報告は日本語で行ってください。

対象情報:
- installation: ${options.installationKind}
- xangi source/application: ${targetDir}
- official documentation: ${options.documentationRoot}
- launcher: ${options.launcherCommand}
- config: ${options.layout.configFile}
- state: ${options.layout.stateDir}
- logs: ${logs}
- configured workspace: ${workspace}

次の順で自律的に復旧してください:
1. 対象情報、xangiの実装、公式document、設定、service状態、doctor結果、直近ログを調査して真因を特定する。
2. 必要なファイルや設定を修正する。個別の既知エラーだけを前提にせず、実際の状態を根拠に判断する。
3. \`${options.launcherCommand} service start${targetFlag}\`または必要ならrestartを実行する。
4. \`${options.launcherCommand} doctor${targetFlag}\`を実行し、復旧したことを確認する。失敗した場合は調査と修正を続ける。
5. 最後に原因、変更内容、検証結果、残課題を短く報告する。

安全上の制約:
- token、password、secretの値を表示・会話へ転記・外部送信しない。設定の有無だけを扱う。
- workspace内の利用者データを削除しない。
- xangiと無関係なファイルやserviceを変更しない。
- packageやsoftwareの追加install、OS全体への変更、外部公開、Git pushは必要性を説明して利用者の明示承認を得る。
- 破壊的操作は対象と影響を示して利用者の明示承認を得る。
- xangiの設定・service・関連ファイルに限定した通常の修正は、途中確認で止まらず実行して検証まで進める。`;
}

export async function prepareRescueLaunch(initialPrompt: string): Promise<{
  visiblePrompt: string;
  instructionPath: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'xangi-rescue-'));
  await chmod(directory, 0o700);
  const instructionPath = join(directory, 'instructions.md');
  await writeFile(instructionPath, initialPrompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(instructionPath, 0o600);
  return {
    visiblePrompt: `xangiの復旧を始めます。最初に ${instructionPath} を読み、その指示に従って調査・修正・検証してください。`,
    instructionPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function launchRescueBackend(
  backend: DetectedBackend,
  initialPrompt: string,
  cwd: string
): Promise<number> {
  const prepared = await prepareRescueLaunch(initialPrompt);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(
        backend.executable,
        buildGuidedLaunchArgs(backend, prepared.visiblePrompt),
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

export async function rescueCmd(options: RescueCommandOptions): Promise<string> {
  const config = await readSetupConfig(options.layout.configFile);
  const configuredBin = config?.backendExecutable ? dirname(config.backendExecutable) : undefined;
  const pathEnv = [configuredBin, options.pathEnv ?? process.env.PATH]
    .filter((value): value is string => Boolean(value))
    .join(delimiter);
  const backends = await detectGuidedBackends({ ...options, homeDir: options.homeDir, pathEnv });
  if (backends.length === 0) {
    throw new SetupPrerequisiteError(
      `${missingBackendGuide().replaceAll('xangi setup', 'xangi rescue')}\n復旧にはxangi本体とは独立したAIエージェントCLIが必要です。`
    );
  }
  const readyBackends = backends.filter((backend) => backend.authenticated !== false);
  const unauthenticated = backends.filter((backend) => backend.authenticated === false);
  if (readyBackends.length === 0) {
    throw new SetupPrerequisiteError(
      authenticationGuide(unauthenticated).replaceAll('xangi setup', 'xangi rescue')
    );
  }
  if (unauthenticated.length > 0) {
    console.log(
      authenticationGuide(unauthenticated, { blocking: false }).replaceAll(
        'xangi setup',
        'xangi rescue'
      )
    );
  }
  const configured = readyBackends.find((backend) => backend.id === config?.backend);
  const backend =
    configured ?? (await (options.selectBackend ?? selectGuidedBackend)(readyBackends));
  const cwd = await resolveRescueCwd([
    config?.workspacePath,
    options.checkoutDir,
    options.documentationRoot,
    options.homeDir,
  ]);
  const prompt = buildRescuePrompt({ ...options, config });
  const code = await (options.launch ?? launchRescueBackend)(backend, prompt, cwd);
  if (code !== 0) throw new Error(`${backend.label}のrescueが終了コード${code}で終了しました`);
  return `${backend.label}によるxangi rescueが終了しました。最終結果を上のAIセッションで確認してください。`;
}
