import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { arch, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { resolveAppLayout } from '../installer/layout.js';
import { isWsl } from '../installer/platform/linux.js';
import { SecretStore } from '../setup/secret-store.js';

interface SecretField {
  name: string;
  label: string;
  group: string;
  type?: 'password' | 'text';
}

export const SECRET_FIELDS: readonly SecretField[] = [
  { name: 'DISCORD_TOKEN', label: 'Botトークン', group: 'Discord' },
  {
    name: 'DISCORD_ALLOWED_USER',
    label: '許可ユーザーID（カンマ区切り、全員許可は *）',
    group: 'Discord',
    type: 'text',
  },
  { name: 'SLACK_BOT_TOKEN', label: 'Botトークン (xoxb-…)', group: 'Slack' },
  { name: 'SLACK_APP_TOKEN', label: 'Appトークン (xapp-…)', group: 'Slack' },
  {
    name: 'SLACK_ALLOWED_USER',
    label: '許可ユーザーID（カンマ区切り、全員許可は *）',
    group: 'Slack',
    type: 'text',
  },
  { name: 'LINE_CHANNEL_ACCESS_TOKEN', label: 'Channel access token', group: 'LINE' },
  { name: 'LINE_CHANNEL_SECRET', label: 'Channel secret', group: 'LINE' },
  {
    name: 'LINE_ALLOWED_USER',
    label: '許可ユーザーID（カンマ区切り、全員許可は *）',
    group: 'LINE',
    type: 'text',
  },
  { name: 'TELEGRAM_BOT_TOKEN', label: 'Botトークン', group: 'Telegram' },
  { name: 'TELEGRAM_WEBHOOK_SECRET_TOKEN', label: 'Webhook secret（任意）', group: 'Telegram' },
  {
    name: 'TELEGRAM_ALLOWED_USER',
    label: '許可ユーザーID（カンマ区切り、全員許可は *）',
    group: 'Telegram',
    type: 'text',
  },
];

export interface SecretSettingsServer {
  url: string;
  completion: Promise<number>;
  close(): Promise<void>;
}

export interface StartSecretSettingsOptions {
  store: SecretStore;
  timeoutMs?: number;
}

export interface SettingsCommandDependencies {
  store?: SecretStore;
  openBrowser?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export async function settingsCmd(dependencies: SettingsCommandDependencies = {}): Promise<string> {
  const store = dependencies.store ?? defaultSecretStore();
  const session = await startSecretSettingsServer({ store, timeoutMs: dependencies.timeoutMs });
  try {
    await (dependencies.openBrowser ?? openBrowser)(session.url);
    console.log('ローカルの接続設定画面を開きました。保存するとこの画面は終了します。');
    const saved = await session.completion;
    return saved === 0
      ? '変更せずに接続設定を終了しました'
      : `${saved}件の設定を安全な専用領域へ保存しました。xangiの再起動後に反映されます`;
  } catch (error) {
    await session.close();
    throw error;
  }
}

export async function startSecretSettingsServer(
  options: StartSecretSettingsOptions
): Promise<SecretSettingsServer> {
  const accessToken = randomBytes(32).toString('base64url');
  const configured = new Set(Object.keys(await options.store.all()));
  let resolveCompletion!: (saved: number) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<number>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  let settled = false;
  let origin = '';

  const finish = (saved: number): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveCompletion(saved);
    setTimeout(() => server.close(), 25).unref();
  };

  const server: Server = createServer(async (request, response) => {
    try {
      applySecurityHeaders(response);
      const url = new URL(request.url ?? '/', origin);
      if (
        request.headers.host !== origin.slice('http://'.length) ||
        url.pathname !== '/settings' ||
        !sameToken(url.searchParams.get('token'), accessToken)
      ) {
        response.writeHead(404).end('Not found');
        return;
      }
      if (request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(renderSettingsPage(configured, accessToken));
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const body = new URLSearchParams(await readBody(request));
      const updates: Record<string, string> = {};
      for (const field of SECRET_FIELDS) {
        const value = body.get(field.name)?.trim();
        if (value) updates[field.name] = validateSettingValue(field.name, value);
      }
      await options.store.setMany(updates);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(renderSavedPage(Object.keys(updates).length));
      finish(Object.keys(updates).length);
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('設定画面を開始できませんでした');
  origin = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(
    () => {
      if (settled) return;
      settled = true;
      server.close();
      rejectCompletion(new Error('トークン設定画面がタイムアウトしました'));
    },
    options.timeoutMs ?? 10 * 60 * 1000
  );

  return {
    url: `${origin}/settings?token=${accessToken}`,
    completion,
    close: () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolveCompletion(0);
      }
      return new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

function defaultSecretStore(): SecretStore {
  const layout = resolveAppLayout({
    platform: platform(),
    arch: arch(),
    homeDir: homedir(),
    xdgDataHome: process.env.XDG_DATA_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgStateHome: process.env.XDG_STATE_HOME,
  });
  return new SecretStore(join(layout.configDir, 'secrets.json'));
}

async function openBrowser(url: string): Promise<void> {
  const currentPlatform = platform();
  if (currentPlatform === 'darwin') return runBrowserCommand('open', [url]);
  if (currentPlatform !== 'linux') throw new Error('設定画面はmacOSとLinux/WSL2に対応しています');
  if (!isWsl()) return runBrowserCommand('xdg-open', [url]);
  const wslview = spawnSync('wslview', ['--version'], { encoding: 'utf8' });
  if (wslview.status === 0) return runBrowserCommand('wslview', [url]);
  return runBrowserCommand('cmd.exe', ['/c', 'start', '', url]);
}

function runBrowserCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if ((result.status ?? 1) !== 0) {
    throw new Error(String(result.stderr || result.stdout || `${command} failed`).trim());
  }
}

function applySecurityHeaders(response: import('node:http').ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array);
    size += value.length;
    if (size > 64 * 1024) throw new Error('入力が大きすぎます');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sameToken(received: string | null, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function renderSettingsPage(configured: Set<string>, accessToken: string): string {
  let lastGroup = '';
  const fields = SECRET_FIELDS.map((field) => {
    const heading = field.group === lastGroup ? '' : `<h2>${escapeHtml(field.group)}</h2>`;
    lastGroup = field.group;
    const state = configured.has(field.name)
      ? '<span class="set">設定済み</span>'
      : '<span>未設定</span>';
    return `${heading}<label>${escapeHtml(field.label)} ${state}<input type="${field.type ?? 'password'}" name="${field.name}" autocomplete="off" spellcheck="false" placeholder="空欄なら変更しません"></label>`;
  }).join('');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>xangi 接続設定</title><style>${styles()}</style><main><h1>xangi 接続設定</h1><p>このPC内だけで開いている一時画面です。保存済みの値は表示しません。</p><form method="post" action="/settings?token=${accessToken}" autocomplete="off">${fields}<button type="submit">安全に保存</button></form></main></html>`;
}

function renderSavedPage(count: number): string {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>保存完了</title><style>${styles()}</style><main><h1>保存しました</h1><p>${count}件の接続設定を保存しました。このタブは閉じて構いません。</p></main></html>`;
}

function validateSettingValue(name: string, value: string): string {
  const allowedUserPatterns: Partial<Record<string, RegExp>> = {
    DISCORD_ALLOWED_USER: /^\d{1,20}$/,
    SLACK_ALLOWED_USER: /^[UW][A-Z0-9]+$/,
    LINE_ALLOWED_USER: /^U[0-9a-f]{32}$/i,
    TELEGRAM_ALLOWED_USER: /^\d{1,20}$/,
  };
  const pattern = allowedUserPatterns[name];
  if (!pattern) return value;
  const users = value.split(',').map((user) => user.trim());
  if (users.length === 1 && users[0] === '*') return '*';
  if (users.some((user) => !pattern.test(user))) {
    throw new Error(`${name}の値が正しくありません`);
  }
  return users.join(',');
}

function styles(): string {
  return `:root{font-family:system-ui,sans-serif;color:#172033;background:#f5f7fb}main{max-width:640px;margin:32px auto;padding:24px;background:white;border-radius:16px;box-shadow:0 8px 30px #17203318}h1{margin-top:0}h2{font-size:1.1rem;margin:28px 0 8px;border-bottom:1px solid #dde3ee;padding-bottom:6px}label{display:block;margin:12px 0;color:#34405a}input{box-sizing:border-box;width:100%;margin-top:6px;padding:11px;border:1px solid #b9c3d5;border-radius:8px;font:inherit}.set{color:#087a55;font-size:.85rem}button{margin-top:24px;width:100%;padding:12px;border:0;border-radius:9px;background:#3157d5;color:white;font:inherit;font-weight:700}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
