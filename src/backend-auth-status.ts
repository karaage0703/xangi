import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CopilotClient } from '@github/copilot-sdk';
import {
  detectGuidedBackends,
  GUIDED_BACKENDS,
  type DetectedBackend,
} from './setup/guided-onboarding.js';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const updatingBackends = new Set<string>();

export type BackendAuthenticationState =
  'logged-in' | 'api-key' | 'not-authenticated' | 'unknown' | 'not-installed';

export interface BackendAuthenticationStatus {
  id: string;
  label: string;
  installed: boolean;
  version?: string;
  state: BackendAuthenticationState;
  apiKeyConfigured: boolean;
  loginSupported: boolean;
  updateSupported: boolean;
}

interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

interface BackendAuthStatusDependencies {
  detectedBackends?: readonly DetectedBackend[];
  detectBackends?: typeof detectGuidedBackends;
  runCommand?: (command: string, args: readonly string[]) => Promise<CommandResult>;
  probeCopilot?: () => Promise<BackendAuthenticationState>;
}

export interface BackendToolUpdateResult {
  id: string;
  label: string;
  previousVersion?: string;
  version?: string;
  message: string;
}

interface BackendToolUpdateDependencies {
  detectedBackends?: readonly DetectedBackend[];
  detectBackends?: typeof detectGuidedBackends;
  runUpdate?: (command: string, args: readonly string[]) => Promise<CommandResult>;
  readVersion?: (command: string) => Promise<string | undefined>;
}

const AUTH_PROBES: Record<string, readonly string[]> = {
  codex: ['login', 'status'],
  opencode: ['auth', 'list'],
  'claude-code': ['auth', 'status'],
  cursor: ['status'],
  grok: ['models'],
  antigravity: ['models'],
};

const UPDATE_COMMANDS: Record<string, readonly string[]> = {
  codex: ['update'],
  opencode: ['upgrade'],
  'claude-code': ['update'],
  cursor: ['update'],
  grok: ['update'],
  antigravity: ['update'],
  'github-copilot': ['update', 'stable'],
};

const API_KEY_ENV: Record<string, readonly string[]> = {
  'claude-code': ['ANTHROPIC_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
  grok: ['XAI_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
};

const AUTHENTICATION_ERROR =
  /auth|login|log in|sign in|credential|token|unauthori[sz]ed|forbidden|認証|ログイン/i;
const EMPTY_OPENCODE_AUTH = /(?:no|0)\s+(?:auth|credential|provider)|not configured|未設定/i;

async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    return { exitCode: 0, output: `${result.stdout}\n${result.stderr}`.trim(), timedOut: false };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : null,
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`.trim(),
      timedOut: failure.killed === true || failure.code === 'ETIMEDOUT',
    };
  }
}

async function runUpdate(command: string, args: readonly string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      encoding: 'utf8',
      timeout: UPDATE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, output: `${result.stdout}\n${result.stderr}`.trim(), timedOut: false };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : null,
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`.trim(),
      timedOut: failure.killed === true || failure.code === 'ETIMEDOUT',
    };
  }
}

async function readVersion(command: string): Promise<string | undefined> {
  const result = await runCommand(command, ['--version']);
  if (result.exitCode !== 0) return undefined;
  return result.output
    .split('\n')
    .find((line) => line.trim())
    ?.trim();
}

function commandProbeState(backendId: string, result: CommandResult): BackendAuthenticationState {
  if (result.timedOut) return 'unknown';
  if (result.exitCode === 0) {
    if (backendId === 'opencode' && (!result.output || EMPTY_OPENCODE_AUTH.test(result.output))) {
      return 'not-authenticated';
    }
    return 'logged-in';
  }
  if (['codex', 'claude-code', 'cursor'].includes(backendId)) return 'not-authenticated';
  return AUTHENTICATION_ERROR.test(result.output) ? 'not-authenticated' : 'unknown';
}

async function probeCopilot(): Promise<BackendAuthenticationState> {
  const client = new CopilotClient();
  try {
    await client.start();
    const quota = await client.rpc.account.getQuota({});
    return quota ? 'logged-in' : 'unknown';
  } catch (error) {
    return AUTHENTICATION_ERROR.test(error instanceof Error ? error.message : String(error))
      ? 'not-authenticated'
      : 'unknown';
  } finally {
    await client.stop().catch(() => undefined);
  }
}

export async function backendAuthenticationSnapshot(
  configuredSecrets: ReadonlySet<string>,
  dependencies: BackendAuthStatusDependencies = {}
): Promise<BackendAuthenticationStatus[]> {
  const detected =
    dependencies.detectedBackends ??
    (await (dependencies.detectBackends ?? detectGuidedBackends)({ authStatus: () => true }));
  const installed = new Map(detected.map((backend) => [backend.id, backend]));
  const commandRunner = dependencies.runCommand ?? runCommand;
  const copilotProbe = dependencies.probeCopilot ?? probeCopilot;

  return Promise.all(
    GUIDED_BACKENDS.map(async (backend): Promise<BackendAuthenticationStatus> => {
      const detectedBackend = installed.get(backend.id);
      const apiKeyConfigured = (API_KEY_ENV[backend.id] ?? []).some((key) =>
        configuredSecrets.has(key)
      );
      let state: BackendAuthenticationState = 'not-installed';

      if (detectedBackend) {
        if (backend.id === 'github-copilot') {
          state = await copilotProbe();
        } else {
          const args = AUTH_PROBES[backend.id];
          state = args
            ? commandProbeState(backend.id, await commandRunner(detectedBackend.executable, args))
            : 'unknown';
        }
        if (state !== 'logged-in' && apiKeyConfigured) state = 'api-key';
      }

      return {
        id: backend.id,
        label: backend.label,
        installed: Boolean(detectedBackend),
        version: detectedBackend?.version,
        state,
        apiKeyConfigured,
        loginSupported: true,
        updateSupported: Boolean(UPDATE_COMMANDS[backend.id]),
      };
    })
  );
}

export async function updateBackendTool(
  id: string,
  dependencies: BackendToolUpdateDependencies = {}
): Promise<BackendToolUpdateResult> {
  const backend = GUIDED_BACKENDS.find((candidate) => candidate.id === id);
  const updateArgs = UPDATE_COMMANDS[id];
  if (!backend || !updateArgs) throw new Error('更新できないAIサービスです');

  const detected =
    dependencies.detectedBackends ??
    (await (dependencies.detectBackends ?? detectGuidedBackends)({ authStatus: () => true }));
  const installed = detected.find((candidate) => candidate.id === id);
  if (!installed) throw new Error(`${backend.label}のCLIが見つかりません`);
  if (updatingBackends.has(id)) throw new Error(`${backend.label}は更新中です`);

  updatingBackends.add(id);
  try {
    const result = await (dependencies.runUpdate ?? runUpdate)(installed.executable, updateArgs);
    if (result.timedOut) throw new Error(`${backend.label}の更新が5分以内に完了しませんでした`);
    if (result.exitCode !== 0) throw new Error(`${backend.label}の更新に失敗しました`);

    const version = await (dependencies.readVersion ?? readVersion)(installed.executable);
    return {
      id,
      label: backend.label,
      previousVersion: installed.version,
      version,
      message: `${backend.label}を更新しました。新しい実行から${version || '更新後のバージョン'}を使用します。`,
    };
  } finally {
    updatingBackends.delete(id);
  }
}
