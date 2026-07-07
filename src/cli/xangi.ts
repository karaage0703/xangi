#!/usr/bin/env node
/**
 * xangi — user-facing terminal client.
 *
 * This CLI talks to xangi's public Web Chat / Even Terminal compatible API.
 * Keep it separate from xangi-cmd, which is an internal management/tool CLI.
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { serviceCmd } from './service-cmd.js';

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
}

const DEFAULT_URL = 'http://127.0.0.1:18888';

function loadEnvFiles(): void {
  if (process.env.XANGI_SKIP_ENV_FILE === 'true') return;

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
  xangi sessions [--url URL] [--token TOKEN] [--limit N]
  xangi send [--session ID] [--detach] "message"
  git diff | xangi send -
  xangi chat [--session ID]
  xangi status --session ID
  xangi service <start|stop|restart|status> [--name NAME] [--dir DIR]

Options:
  --url URL       xangi Web Chat URL (default: ${DEFAULT_URL})
  --token TOKEN   API token. Env: XANGI_TOKEN or XANGI_EVEN_TERMINAL_TOKEN
  --provider P    Compatibility label: claude or codex (default: codex)
  --session ID    Web session ID to attach to
  --detach, -d    Return after sending the prompt
  --timeout MS    Wait timeout for send (default: 600000)
  --json          Print raw JSON for sessions/status
  --name NAME     Service process name for xangi service
  --dir DIR       Target another xangi checkout for xangi service

Config:
  ~/.config/xangi/config.json may contain url, token, provider, sessionId.

Note:
  For service operations, prefer running ./bin/xangi from the target clone
  or using named symlinks such as xangi-dev / xangi-prod.
  xangi is the human/operator CLI. xangi-cmd remains the internal platform/tool CLI.`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[2] || 'help';
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const booleanFlags = new Set(['json', 'wait', 'detach']);

  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-d') {
      flags.detach = true;
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
    DEFAULT_URL;
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
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  let after = 0;
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
    await waitForResponse(config, result.sessionId, timeoutMs);
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
  loadEnvFiles();
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.command === 'help' || parsed.command === '--help') {
    printHelp();
    return;
  }

  if (parsed.command === 'service') {
    console.log(await serviceCmd(parsed.positionals[0] || 'help', parsed.flags));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
