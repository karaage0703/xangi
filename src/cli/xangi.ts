#!/usr/bin/env node
import { ensureManagedEnv } from '../installer/managed-env.js';
import { loadRuntimeEnvFile } from '../env-file.js';
import { resolveWebChatPort } from '../web-endpoint-config.js';
/**
 * xangi — user-facing terminal client.
 *
 * This CLI talks to xangi's public Web Chat / Even Terminal compatible API.
 * `xangi tool` is the canonical management/tool namespace; xangi-cmd is its compatibility shim.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { arch, homedir, platform } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { serviceCmd } from './service-cmd.js';
import { doctorCmd } from './doctor-cmd.js';
import {
  applyGuidedSetup,
  completeGuidedSetup,
  detectGuidedBackends,
  guidedSetupCmd,
  launcherCommand,
  readOnboardingStatus,
  updateGuidedSetupAccess,
  writeOnboardingState,
} from '../setup/guided-onboarding.js';
import { installCmd } from './install-cmd.js';
import { uninstallCmd } from './uninstall-cmd.js';
import { updateCmd } from './update-cmd.js';
import { settingsCmd } from './settings-cmd.js';
import { resolveAppLayout } from '../installer/layout.js';
import { installConfiguredWorkspaceTemplate } from '../installer/workspace-template.js';
import { runToolCommand } from './tool-command.js';
import { extensionCmd } from './extension-cmd.js';
import { configureOpenCodeSetup } from '../setup/opencode-config.js';
import { workerCmd } from './worker-cmd.js';
import { rescueCmd } from './rescue-cmd.js';

type ProviderLabel = 'claude' | 'codex';

interface CliConfig {
  url: string;
  token?: string;
  provider: ProviderLabel;
  sessionId?: string;
}

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

interface TerminalMessage {
  id?: number;
  type?: string;
  text?: string;
  message?: string;
  success?: boolean;
}

interface SendResult {
  ok?: boolean;
  sessionId: string;
  provider: ProviderLabel;
  after?: number;
}

const DEFAULT_URL = 'http://127.0.0.1:18888';
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function configuredWebChatPort(): number {
  return resolveWebChatPort().port;
}

function loadEnvFiles(): void {
  if (process.env.XANGI_SKIP_ENV_FILE === 'true') return;

  if (process.env.XANGI_INSTALLATION_KIND === 'managed') {
    const layout = resolveAppLayout({
      platform: platform(),
      arch: arch(),
      homeDir: homedir(),
      xdgDataHome: process.env.XDG_DATA_HOME,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      xdgStateHome: process.env.XDG_STATE_HOME,
    });
    const path = ensureManagedEnv(layout.configFile);
    process.env.XANGI_ENV_PATH = path;
    loadRuntimeEnvFile({ quiet: true });
    return;
  }
  const candidates: string[] = [];
  if (process.env.XANGI_ENV_PATH) candidates.push(process.env.XANGI_ENV_PATH);
  if (process.env.XANGI_DIR) candidates.push(join(process.env.XANGI_DIR, '.env'));
  candidates.push(join(process.cwd(), '.env'));

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  candidates.push(join(moduleDir, '..', '..', '.env'));

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
    return;
  }
}

function printHelp(): void {
  console.log(`xangi — terminal client for xangi sessions

Usage:
  xangi --version
  xangi sessions [--url URL] [--token TOKEN] [--limit N]
  xangi send [--session ID] [--detach] "message"
  git diff | xangi send -
  xangi chat [--session ID]
  xangi status --session ID
  xangi doctor [--dir XANGI_CHECKOUT] [--url WEB_CHAT_URL]
  xangi rescue [--dir XANGI_CHECKOUT]
  xangi setup
  xangi setup --apply --backend BACKEND --workspace PATH --workspace-mode MODE --web-chat-access ACCESS
  xangi setup --complete
  xangi setup --access <local|tailscale|lan>
  xangi install [--manifest URL] [--public-key PATH]
  xangi uninstall [--purge --yes]
  xangi update [--managed] [--manifest URL] [--public-key PATH] [--allow-downgrade]
  xangi settings
  xangi extension <link|unlink|list|start|stop|restart|status|doctor|update> [ID|MANIFEST]
  xangi extension <start|stop|restart> --all
  xangi worker install --pair CODE [--workspace PATH]
  xangi worker <run|start|stop|restart|status|uninstall>
  xangi workspace <list|create|set-path|delete>  作業場所の一覧・登録
  xangi team <create|delete|list|show|run|status|wait|logs|close>  Teamの確認・依頼・結果取得
  xangi agent <create|update|list|delete|run|status|wait|logs|close> [--agent ID --task TEXT] [--id RUN_ID]
  xangi tool <operation> [--key value ...]
  xangi service <start|stop|restart|status> [--name NAME] [--dir DIR]
  xangi service autostart <enable|disable> [--name NAME] [--dir DIR]

Options:
  --help, -h      Show help without running the requested action
  --version, -V   Print the installed release or checkout version
  --url URL       xangi Web Chat URL (default: ${DEFAULT_URL})
  --token TOKEN   API token. Env: XANGI_TOKEN or XANGI_EVEN_TERMINAL_TOKEN
  --provider P    Compatibility label: claude or codex (default: codex)
  --session ID    Web session ID to attach to
  --detach, -d    Return after sending the prompt
  --timeout MS    Wait timeout for send (default: 600000)
  --json          Print raw JSON for sessions/status
  --name NAME     Service process name for xangi service
  --dir DIR       Target another xangi checkout for xangi service
  --manifest URL  Signed release manifest URL
  --public-key P  Ed25519 release public key path
  --allow-downgrade  Explicitly permit installing an older release
  --purge         Also remove settings, tokens, and state; never removes the workspace
  --yes           Confirm the destructive data removal requested by --purge
  --managed       From a source checkout, update the signed managed installation instead
  --apply         Persist choices made during AI-guided setup
  --complete      Mark the minimum BOOTSTRAP onboarding complete
  --access A      Change Web Chat access after minimum setup is complete
  --workspace P   Absolute workspace path for setup --apply
  --workspace-mode M  existing, template, or blank
  --web-chat-access A  local, tailscale, or lan (default: local)

Config:
  ~/.config/xangi/config.json may contain url, token, provider, sessionId.

Note:
  For service operations, prefer running ./bin/xangi from the target clone
  or using named symlinks such as xangi-dev / xangi-prod.
  xangi tool is the canonical agent/tool-server CLI.
  xangi-cmd remains available as a compatibility shim.`);
}

function printUpdateHelp(): void {
  console.log(`Usage:
  xangi update
  xangi update --managed [--manifest URL] [--public-key PATH] [--allow-downgrade]

Managed update:
  Downloads and verifies the signed release, then activates it for the next service start.

Options:
  --managed          From a source checkout, update the signed managed installation instead
  --manifest URL     Signed release manifest URL
  --public-key PATH  Ed25519 release public key path
  --allow-downgrade  Explicitly permit installing an older release

The service is not restarted automatically. Run \`xangi service restart\` when ready.`);
}

function printVersion(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const checkoutRoot = join(moduleDir, '..', '..');

  if (process.env.XANGI_INSTALLATION_KIND === 'managed') {
    const currentPlatform = platform();
    if (currentPlatform !== 'darwin' && currentPlatform !== 'linux') {
      throw new Error(`Unsupported managed installation platform: ${currentPlatform}`);
    }
    const layout = resolveAppLayout({
      platform: currentPlatform,
      arch: arch(),
      homeDir: homedir(),
      xdgDataHome: process.env.XDG_DATA_HOME,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      xdgStateHome: process.env.XDG_STATE_HOME,
    });
    const appRoot = process.env.XANGI_APP_ROOT || layout.appRoot;
    const version = basename(realpathSync(join(appRoot, 'current')));
    if (!RELEASE_VERSION.test(version)) {
      throw new Error(`Managed installation has an invalid version path: ${version}`);
    }
    console.log(`xangi ${version}`);
    return;
  }

  const described = spawnSync(
    'git',
    ['-C', checkoutRoot, 'describe', '--tags', '--always', '--dirty'],
    {
      encoding: 'utf8',
      timeout: 5_000,
    }
  );
  const version = described.status === 0 ? described.stdout.trim().replace(/^v(?=\d)/, '') : '';
  if (!version) {
    throw new Error('Unable to determine the xangi checkout version');
  }
  console.log(`xangi ${version}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[2] || 'help';
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const booleanFlags = new Set([
    'json',
    'wait',
    'detach',
    'allow-downgrade',
    'purge',
    'yes',
    'apply',
    'complete',
    'help',
    'all',
  ]);

  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-d') {
      flags.detach = true;
      continue;
    }
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, flags, positionals };
}

function readConfigFile(): Partial<CliConfig> {
  const configPath = process.env.XANGI_CONFIG || join(homedir(), '.config', 'xangi', 'config.json');
  if (!existsSync(configPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<CliConfig>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    throw new Error(
      `Failed to read config ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

function normalizeProvider(value: string | undefined): ProviderLabel {
  return value === 'claude' ? 'claude' : 'codex';
}

function loadConfig(flags: Record<string, string | boolean>): CliConfig {
  const fileConfig = readConfigFile();
  const url =
    stringFlag(flags, 'url') ||
    process.env.XANGI_URL ||
    process.env.XANGI_CLI_URL ||
    fileConfig.url ||
    `http://127.0.0.1:${configuredWebChatPort()}`;
  const token =
    stringFlag(flags, 'token') ||
    process.env.XANGI_TOKEN ||
    process.env.XANGI_EVEN_TERMINAL_TOKEN ||
    fileConfig.token;
  const provider = normalizeProvider(
    stringFlag(flags, 'provider') || process.env.XANGI_PROVIDER || fileConfig.provider
  );
  const sessionId =
    stringFlag(flags, 'session') || process.env.XANGI_SESSION || fileConfig.sessionId;
  return { url: url.replace(/\/+$/, ''), token, provider, sessionId };
}

async function requestJson<T>(config: CliConfig, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  if (config.token) headers.set('Authorization', `Bearer ${config.token}`);

  const res = await fetch(`${config.url}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text || `HTTP ${res.status}` };
  }

  if (!res.ok) {
    const error =
      body && typeof body === 'object' && 'error' in body
        ? String(body.error)
        : `HTTP ${res.status}`;
    throw new Error(error);
  }
  return body as T;
}

function messageText(msg: TerminalMessage): string {
  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.message === 'string') return msg.message;
  return '';
}

function shouldPrintMessage(msg: TerminalMessage): boolean {
  return msg.type === 'result' || msg.type === 'error' || msg.type === 'notification';
}

async function listSessions(
  config: CliConfig,
  flags: Record<string, string | boolean>
): Promise<void> {
  const limit = Number(stringFlag(flags, 'limit') || '20');
  const params = new URLSearchParams({ provider: config.provider, limit: String(limit) });
  const body = await requestJson<{ sessions?: Array<Record<string, unknown>> }>(
    config,
    `/api/sessions?${params}`
  );
  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const sessions = body.sessions || [];
  if (sessions.length === 0) {
    console.log('No sessions.');
    return;
  }
  for (const session of sessions) {
    const id = String(session.id || '');
    const title = String(session.title || id);
    const status = String(session.status || '-');
    const updatedAt = String(session.updatedAt || session.timestamp || '-');
    const lastMessage = session.lastMessage ? ` — ${String(session.lastMessage)}` : '';
    console.log(`${id}\t${status}\t${updatedAt}\t${title}${lastMessage}`);
  }
}

async function status(config: CliConfig, flags: Record<string, string | boolean>): Promise<void> {
  const sessionId = stringFlag(flags, 'session') || config.sessionId;
  if (!sessionId) throw new Error('status requires --session ID');
  const params = new URLSearchParams({ provider: config.provider, sessionId });
  const body = await requestJson<Record<string, unknown>>(config, `/api/status?${params}`);
  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  console.log(`${body.sessionId}\t${body.state}\tprovider=${body.provider}`);
}

async function fetchMessages(
  config: CliConfig,
  sessionId: string,
  after: number
): Promise<{ messages: TerminalMessage[]; state?: string }> {
  const params = new URLSearchParams({
    provider: config.provider,
    sessionId,
    after: String(after),
  });
  return requestJson<{ messages: TerminalMessage[]; state?: string }>(
    config,
    `/api/messages?${params}`
  );
}

async function waitForResponse(
  config: CliConfig,
  sessionId: string,
  timeoutMs: number,
  initialAfter = 0
): Promise<void> {
  const startedAt = Date.now();
  let after = initialAfter;
  let printed = false;

  while (Date.now() - startedAt < timeoutMs) {
    const body = await fetchMessages(config, sessionId, after);
    for (const msg of body.messages || []) {
      if (typeof msg.id === 'number') after = Math.max(after, msg.id);
      if (!shouldPrintMessage(msg)) continue;
      const text = messageText(msg);
      if (text) {
        console.log(text);
        printed = true;
      }
      if (msg.type === 'error') return;
    }
    if (body.state === 'idle' && printed) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for response from session ${sessionId}`);
}

async function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      text += chunk;
    });
    input.on('end', () => resolve(text));
    input.on('error', reject);
  });
}

async function send(
  config: CliConfig,
  flags: Record<string, string | boolean>,
  positionals: string[]
): Promise<string> {
  let text = positionals.join(' ').trim();
  if ((positionals.length === 1 && positionals[0] === '-') || (!text && !input.isTTY)) {
    text = (await readStdinText()).trim();
  }
  if (!text) throw new Error('send requires a message');

  const sessionId = stringFlag(flags, 'session') || config.sessionId;
  const result = await requestJson<SendResult>(config, '/api/prompt', {
    method: 'POST',
    body: JSON.stringify({
      text,
      provider: config.provider,
      ...(sessionId ? { sessionId } : {}),
    }),
  });

  console.error(`session: ${result.sessionId}`);
  const shouldWait = boolFlag(flags, 'wait') || !boolFlag(flags, 'detach');
  if (shouldWait) {
    const timeoutMs = Number(stringFlag(flags, 'timeout') || '600000');
    await waitForResponse(config, result.sessionId, timeoutMs, result.after ?? 0);
  }
  return result.sessionId;
}

async function chat(config: CliConfig, flags: Record<string, string | boolean>): Promise<void> {
  let sessionId = stringFlag(flags, 'session') || config.sessionId;
  const rl = readline.createInterface({ input, output });
  console.error(`xangi chat connected to ${config.url}`);
  if (sessionId) console.error(`session: ${sessionId}`);
  console.error('Type /exit to quit.');

  try {
    while (true) {
      const line = (await rl.question('> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      sessionId = await send({ ...config, sessionId }, { ...flags, wait: true }, [line]);
    }
  } finally {
    rl.close();
  }
}

export async function run(argv = process.argv): Promise<void> {
  // Help must take precedence over actions and environment initialization (which
  // can create managed configuration files even before a command is dispatched).
  const command = argv[2];
  const helpRequested = argv.slice(3).some((arg) => arg === '--help' || arg === '-h');
  if (!command || ['help', '--help', '-h'].includes(command) || helpRequested) {
    switch (command) {
      case 'tool':
        console.log(await runToolCommand(argv.slice(3)));
        break;
      case 'agent':
      case 'team':
      case 'workspace':
        console.log(await runToolCommand(['help', command]));
        break;
      case 'extension':
        console.log(await extensionCmd('help', [], { help: true }));
        break;
      case 'service':
        console.log(await serviceCmd('help', {}));
        break;
      case 'worker':
        console.log(await workerCmd('help', {}));
        break;
      case 'update':
        printUpdateHelp();
        break;
      case 'settings':
        console.log(
          'Usage: xangi settings\n\nOpen the settings GUI in your browser.\n\n  --help, -h  Show this help without opening the GUI'
        );
        break;
      default:
        printHelp();
    }
    return;
  }
  // Service commands select their target before loading application settings.
  // Loading the caller's .env here can even redirect the PM2 supervisor or mode.
  if (argv[2] === 'service') {
    const parsed = parseArgs(argv);
    if (!parsed.flags.dir && process.env.XANGI_INSTALLATION_KIND === 'managed') loadEnvFiles();
    console.log(
      await serviceCmd(parsed.positionals[0] || 'help', parsed.flags, {}, parsed.positionals[1])
    );
    return;
  }
  loadEnvFiles();
  if (argv[2] === '--version' || argv[2] === '-V' || argv[2] === 'version') {
    printVersion();
    return;
  }
  if (argv[2] === 'agent' || argv[2] === 'team' || argv[2] === 'workspace') {
    const command = argv[2];
    const action = argv[3] || 'list';
    if (['help', '--help', '-h'].includes(action)) {
      console.log(await runToolCommand(['help', command]));
    } else {
      const args = argv.slice(4);
      if (
        ['run', 'delete', 'show', 'set-path', 'update'].includes(action) &&
        args[0] &&
        !args[0].startsWith('--')
      )
        args.unshift(
          command === 'team' ? '--team' : command === 'workspace' ? '--workspace' : '--agent'
        );
      console.log(await runToolCommand([command, '--action', action, ...args]));
    }
    return;
  }
  if (argv[2] === 'tool') {
    if (['workspace', 'agent', 'team'].includes(argv[3])) {
      throw new Error(`Use xangi ${argv[3]} <action> instead. See xangi ${argv[3]} --help.`);
    }
    console.log(await runToolCommand(argv.slice(3)));
    return;
  }
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.command === 'help' || parsed.command === '--help') {
    printHelp();
    return;
  }

  if (parsed.command === 'extension') {
    console.log(
      await extensionCmd(parsed.positionals[0] || 'list', parsed.positionals.slice(1), parsed.flags)
    );
    return;
  }

  if (parsed.command === 'worker') {
    console.log(await workerCmd(parsed.positionals[0] || 'help', parsed.flags));
    return;
  }

  if (parsed.command === 'doctor') {
    const baseUrl = stringFlag(parsed.flags, 'url');
    console.log(
      await doctorCmd({
        checkoutDir: stringFlag(parsed.flags, 'dir'),
        ...(baseUrl
          ? {
              healthUrl: new URL('/health', `${baseUrl.replace(/\/+$/, '')}/`).href,
              runtimeInfoUrl: new URL('/api/sessions', `${baseUrl.replace(/\/+$/, '')}/`).href,
            }
          : {}),
      })
    );
    return;
  }

  if (parsed.command === 'rescue') {
    const currentPlatform = platform();
    if (currentPlatform !== 'darwin' && currentPlatform !== 'linux') {
      throw new Error(
        `xangi rescueはmacOSとLinux/WSL2に対応しています（検出: ${currentPlatform}）`
      );
    }
    const layout = resolveAppLayout({
      platform: currentPlatform,
      arch: arch(),
      homeDir: homedir(),
      xdgDataHome: process.env.XDG_DATA_HOME,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      xdgStateHome: process.env.XDG_STATE_HOME,
    });
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const checkoutDir = stringFlag(parsed.flags, 'dir');
    const managedLauncher = join(layout.appRoot, 'bin', 'xangi');
    const checkoutLauncher = join(moduleDir, '..', '..', 'bin', 'xangi');
    const managedInstallation = !checkoutDir && existsSync(managedLauncher);
    const selectedLauncher = managedInstallation ? managedLauncher : checkoutLauncher;
    const documentationRoot = managedInstallation
      ? join(layout.appRoot, 'current')
      : join(moduleDir, '..', '..');
    console.log(
      await rescueCmd({
        layout,
        homeDir: homedir(),
        launcherCommand: launcherCommand(selectedLauncher),
        documentationRoot,
        installationKind: managedInstallation ? 'managed' : 'checkout',
        checkoutDir,
      })
    );
    return;
  }

  if (parsed.command === 'setup') {
    const currentPlatform = platform();
    if (currentPlatform !== 'darwin' && currentPlatform !== 'linux') {
      throw new Error(
        `xangi setup previewはmacOSとLinux/WSL2に対応しています（検出: ${currentPlatform}）`
      );
    }
    const layout = resolveAppLayout({
      platform: currentPlatform,
      arch: arch(),
      homeDir: homedir(),
      xdgDataHome: process.env.XDG_DATA_HOME,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      xdgStateHome: process.env.XDG_STATE_HOME,
    });
    if (parsed.flags.apply) {
      const backend = typeof parsed.flags.backend === 'string' ? parsed.flags.backend : '';
      const workspacePath =
        typeof parsed.flags.workspace === 'string' ? parsed.flags.workspace : '';
      const workspaceMode =
        typeof parsed.flags['workspace-mode'] === 'string' ? parsed.flags['workspace-mode'] : '';
      const webChatAccess =
        typeof parsed.flags['web-chat-access'] === 'string'
          ? parsed.flags['web-chat-access']
          : 'local';
      const onboarding = await readOnboardingStatus(layout);
      const backendExecutable =
        onboarding.backend === backend ? onboarding.backendExecutable : undefined;
      console.log(
        await applyGuidedSetup(
          {
            backend,
            backendExecutable,
            model: onboarding.backend === backend ? onboarding.model : undefined,
            opencodeConfigPath:
              onboarding.backend === backend ? onboarding.opencodeConfigPath : undefined,
            workspacePath,
            workspaceMode,
            webChatAccess,
          },
          {
            layout,
            initializeTemplate: (selectedLayout) =>
              installConfiguredWorkspaceTemplate(selectedLayout, { reapplyIfEmpty: true }),
            backendAvailable: async (selected, executable) =>
              executable
                ? (await detectGuidedBackends({ pathEnv: dirname(executable) })).some(
                    (candidate) => candidate.id === selected && candidate.executable === executable
                  )
                : (await detectGuidedBackends()).some((candidate) => candidate.id === selected),
          }
        )
      );
      return;
    }
    if (parsed.flags.complete) {
      console.log(await completeGuidedSetup(layout));
      return;
    }
    if (parsed.flags.access !== undefined) {
      if (typeof parsed.flags.access !== 'string') {
        throw new Error('--accessにはlocal、tailscale、lanのいずれかを指定してください');
      }
      console.log(await updateGuidedSetupAccess(layout, parsed.flags.access));
      return;
    }
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const managedLauncher = join(layout.appRoot, 'bin', 'xangi');
    const checkoutLauncher = join(moduleDir, '..', '..', 'bin', 'xangi');
    const managedInstallation = existsSync(managedLauncher);
    const selectedLauncher = managedInstallation ? managedLauncher : checkoutLauncher;
    const documentationRoot = managedInstallation
      ? join(layout.appRoot, 'current')
      : join(moduleDir, '..', '..');
    console.log(
      await guidedSetupCmd({
        launcherCommand: launcherCommand(selectedLauncher),
        documentationRoot,
        installationKind: managedInstallation ? 'managed' : 'checkout',
        webChatPort: configuredWebChatPort(),
        onSelected: async (backend) => {
          const opencode =
            backend.id === 'opencode' ? await configureOpenCodeSetup({ layout }) : {};
          if (opencode.configPath) process.env.OPENCODE_CONFIG = opencode.configPath;
          if (opencode.model) process.env.AGENT_MODEL = opencode.model;
          await writeOnboardingState(layout, {
            schemaVersion: 1,
            phase: 'preflight',
            backend: backend.id,
            backendExecutable: backend.executable,
            ...opencode,
            updatedAt: new Date().toISOString(),
          });
        },
      })
    );
    return;
  }

  if (parsed.command === 'install') {
    console.log(await installCmd(parsed.flags));
    return;
  }

  if (parsed.command === 'uninstall') {
    console.log(await uninstallCmd(parsed.flags));
    return;
  }

  if (parsed.command === 'update') {
    console.log(await updateCmd(parsed.flags));
    return;
  }

  if (parsed.command === 'settings') {
    console.log(await settingsCmd());
    return;
  }

  const config = loadConfig(parsed.flags);
  switch (parsed.command) {
    case 'sessions':
      await listSessions(config, parsed.flags);
      return;
    case 'send':
      await send(config, parsed.flags, parsed.positionals);
      return;
    case 'chat':
      await chat(config, parsed.flags);
      return;
    case 'status':
      await status(config, parsed.flags);
      return;
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}
