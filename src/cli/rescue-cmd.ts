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
  const workspace =
    options.config?.workspacePath ?? '(configuration could not be read; investigate)';
  const logs = join(options.layout.stateDir, 'logs');
  const targetFlag = options.checkoutDir ? ` --dir ${shellQuote(options.checkoutDir)}` : '';
  return `You are the AI agent responsible for repairing xangi. The user explicitly started this session to fix xangi errors. Ask questions and report in Japanese.

Target information:
- installation: ${options.installationKind}
- xangi source/application: ${targetDir}
- official documentation: ${options.documentationRoot}
- launcher: ${options.launcherCommand}
- config: ${options.layout.configFile}
- state: ${options.layout.stateDir}
- logs: ${logs}
- configured workspace: ${workspace}

Follow this recovery sequence:
1. In the first response, do not start diagnostic tools or read files. Ask what is happening and wait for the user. If possible, ask about expected behavior, actual symptoms, occurrence time, and preceding changes in one concise question.
2. After the user answers, briefly restate the symptoms and prioritize investigating that user-facing path. Do not confuse unrelated doctor checks or warnings with the main symptom.
3. Investigate target information, xangi implementation, official documentation, configuration, service state, doctor results, and recent logs to identify the root cause.
4. Fix the necessary files or settings. Base decisions on actual state, not assumptions about a particular known error.
5. Run \`${options.launcherCommand} service start${targetFlag}\`, or restart if needed.
6. Run \`${options.launcherCommand} doctor${targetFlag}\` to verify recovery. If it fails, continue investigating and fixing.
7. Finally, briefly report the cause, changes, verification results, and remaining issues.

Safety constraints:
- Do not display, copy into the conversation, or externally transmit token, password, or secret values. Check only whether they are configured.
- Do not delete user data in the workspace.
- Do not change files or services unrelated to xangi.
- Explain the need and obtain explicit user approval before installing additional packages or software, making OS-wide changes, publishing externally, or pushing to Git.
- Before destructive actions, identify targets and impact and obtain explicit user approval.
- For routine fixes limited to xangi configuration, services, and related files, proceed through implementation and verification without stopping for intermediate confirmation.`;
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
    visiblePrompt: `Begin xangi recovery. In the first response, do not use tools or read files. Ask the user in Japanese what is happening and wait for their response. If possible, ask about expected behavior, actual symptoms, occurrence time, and preceding changes in one concise question. After the user answers, read ${instructionPath} and follow its instructions to investigate, fix, and verify.`,
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
