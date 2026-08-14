/**
 * Pet からのテキスト送信用 HTTP エンドポイント。
 *
 * web-chat の HTTP サーバに相乗りする形で `POST /api/pet/inbox` をハンドルする。
 * 同じ実装で `POST /api/device/inbox` / `POST /api/terminal/inbox` も受ける。
 * xangi-pet (Tauri デスクトップアバター) のクリック → 入力欄から送られたテキストを
 * 既存の web セッション (or 新規) に投入し、応答は既存の
 * `GET /api/events/stream` (SSE broadcast) 経由で pet 側に届く。
 *
 * 設計:
 * - 送信先 = 「自 instance の xangi」固定。inter-instance ルーティングは将来検討。
 * - 応答は同期で返さない (202 Accepted)。pet 側は既存 events SSE を購読して
 *   turn.started / message.delta / turn.complete を受け取る (broadcast 設計の核を維持)。
 * - 既存 web セッションに追記する形でテキストを流すので、web-chat の `/inter-chat`
 *   ビューアにも履歴が残る。pet 入力と Web UI の入力は同じ会話文脈に混ざる。
 * - body に `appSessionId` を渡せば特定セッションへ追記。未指定なら最新の web
 *   セッションを再利用、無ければ新規作成。
 *
 * 認証:
 * - `XANGI_PET_INBOX_TOKEN` 設定済み: `Authorization: Bearer <token>` 必須。
 * - 未設定: 「同一マシン (loopback) + プライベートネットワーク (RFC1918 LAN +
 *   Tailscale CGNAT 100.64.0.0/10 + IPv6 ULA / link-local)」からの
 *   リクエストのみ許可。グローバル IP からは 403。
 *   → 自宅 LAN / Tailscale で運用してれば設定ゼロで pet からテキスト送れる。
 *   → xangi をグローバル IP で公開する人だけ token 設定が必要。
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { AgentRunner } from './agent-runner.js';
import type { Config } from './config.js';
import {
  WEB_CHAT_CONTEXT_PREFIX,
  createWebSession,
  ensureSession,
  getSession,
  getSessionEntry,
  listAllSessions,
  setSession,
  setProviderSessionId,
  incrementMessageCount,
  updateSessionTitle,
} from './sessions.js';
import { threadIdFor, turnIdFor, getEventsConfig } from './events-emitter.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import { flowFromHostPlatform } from './inter-instance-chat/index.js';
import {
  appendReplySuggestionInstruction,
  stripReplySuggestionMarkup,
} from './reply-suggestions.js';
import { loadReplySuggestionsEnabled } from './settings.js';
import { truncateSessionTitle } from './session-title.js';

const MAX_TEXT_LENGTH = 8000;
const MAX_BODY_BYTES = 64 * 1024;
const INBOX_PATHS = new Set(['/api/pet/inbox', '/api/device/inbox', '/api/terminal/inbox']);

/** 同一セッションへの並行送信を抑止する (web-chat 側とは独立の Set)。 */
const busy = new Set<string>();

export function isPetInboxEnabled(): boolean {
  return process.env.XANGI_PET_INBOX_ENABLED !== 'false';
}

function isInboxEnabled(path: string): boolean {
  if (path !== '/api/pet/inbox' && process.env.XANGI_DEVICE_INBOX_ENABLED !== undefined) {
    return process.env.XANGI_DEVICE_INBOX_ENABLED !== 'false';
  }
  return isPetInboxEnabled();
}

function getToken(path: string): { token: string | null; envName: string } {
  const envName = path === '/api/pet/inbox' ? 'XANGI_PET_INBOX_TOKEN' : 'XANGI_DEVICE_INBOX_TOKEN';
  const fallback = path === '/api/pet/inbox' ? '' : process.env.XANGI_PET_INBOX_TOKEN || '';
  const tk = (process.env[envName] || fallback).trim();
  return { token: tk || null, envName: tk ? envName : 'XANGI_PET_INBOX_TOKEN' };
}

function sourceLabel(path: string, source: unknown): string {
  const raw = typeof source === 'string' ? source.trim() : '';
  const normalized = raw ? raw.slice(0, 40) : '';
  if (path === '/api/pet/inbox') return 'Pet';
  if (path === '/api/terminal/inbox') return normalized ? `Terminal:${normalized}` : 'Terminal';
  return normalized ? `Device:${normalized}` : 'Device';
}

export function isInboxPath(path: string): boolean {
  return INBOX_PATHS.has(path);
}

/**
 * 「token 無しでも受け付けて良い IP か」の判定。
 *
 * 通すレンジ:
 * - Loopback (127.0.0.0/8 / ::1)
 * - RFC1918 (10/8, 172.16/12, 192.168/16)
 * - CGNAT 100.64.0.0/10 (Tailscale が tailnet IP に使う範囲)
 * - IPv6 link-local (fe80::/10) + ULA (fc00::/7)
 *
 * 弾くレンジ: 上記以外のグローバル IPv4 / IPv6。Cloudflare Tunnel 等で
 * xangi をパブリックに出してる人は `XANGI_PET_INBOX_TOKEN` を設定する。
 */
export function isLocalOrPrivate(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) は IPv4 として扱う
  const raw = remoteAddress.replace(/^::ffff:/, '');
  if (raw === 'localhost') return true;
  // IPv4 dotted quad
  const v4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false;
    // Loopback 127/8
    if (a === 127) return true;
    // RFC1918
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // CGNAT 100.64.0.0/10 — Tailscale tailnet addresses live here
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6 (case-insensitive)
  const v6 = raw.toLowerCase();
  if (v6 === '::1') return true;
  // link-local fe80::/10
  if (
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb')
  ) {
    return true;
  }
  // ULA fc00::/7
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
  return false;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      buf += chunk.toString('utf-8');
      if (buf.length > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error(`Body too large (max ${MAX_BODY_BYTES} bytes)`));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(buf ? (JSON.parse(buf) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function webContextKey(appSessionId: string): string {
  return `${WEB_CHAT_CONTEXT_PREFIX}${appSessionId}`;
}

/**
 * 戻り値:
 *   true  — このハンドラがレスポンスを返した
 *   false — このリクエストは pet-inbox 担当外 (素通しする)
 */
export async function handlePetInboxRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agentRunner: AgentRunner,
  replySuggestions: Config['web'] = {
    replySuggestions: false,
    replySuggestionCount: 3,
  }
): Promise<boolean> {
  const url = (req.url || '/').split('?')[0];
  if (req.method !== 'POST' || !isInboxPath(url)) return false;

  if (!isInboxEnabled(url)) {
    jsonResponse(res, 503, {
      error: 'inbox is disabled',
      hint:
        url === '/api/pet/inbox'
          ? 'Set XANGI_PET_INBOX_ENABLED=true (default) to enable'
          : 'Set XANGI_DEVICE_INBOX_ENABLED=true (default) to enable',
    });
    return true;
  }

  // 認証ガード: token 設定時は Bearer 必須、未設定時は loopback のみ許可
  const { token, envName } = getToken(url);
  if (token) {
    const authHeader = (req.headers.authorization || '').trim();
    if (authHeader !== `Bearer ${token}`) {
      jsonResponse(res, 401, {
        error: 'Unauthorized',
        hint: `Provide Authorization: Bearer <${envName}>`,
      });
      return true;
    }
  } else if (!isLocalOrPrivate(req.socket.remoteAddress)) {
    jsonResponse(res, 403, {
      error: 'Forbidden',
      hint:
        'Public IP requests require XANGI_PET_INBOX_TOKEN to be set. ' +
        'Loopback, LAN (RFC1918) and Tailscale (CGNAT 100.64/10) are allowed by default.',
    });
    return true;
  }

  // body parse
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    jsonResponse(res, 400, { error: e instanceof Error ? e.message : 'Invalid request body' });
    return true;
  }

  const text = String(body.text ?? '').trim();
  if (!text) {
    jsonResponse(res, 400, { error: 'text is required' });
    return true;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    jsonResponse(res, 400, { error: `text too long (max ${MAX_TEXT_LENGTH} chars)` });
    return true;
  }
  const label = sourceLabel(url, body.source);

  // appSessionId 解決
  // - 指定あり: 既存 web セッションへ追記
  // - 未指定: 最新の web セッションを再利用、無ければ新規作成
  let appSessionId = String(body.appSessionId ?? '').trim();
  if (!appSessionId) {
    const latestWeb = listAllSessions().find((s) => s.platform === 'web');
    appSessionId = latestWeb?.id || createWebSession({ title: `${label} inbox` });
  }
  const entry = getSessionEntry(appSessionId);
  if (!entry) {
    jsonResponse(res, 404, { error: `Session ${appSessionId} not found` });
    return true;
  }
  if (entry.platform !== 'web') {
    jsonResponse(res, 409, {
      error: `Session ${appSessionId} is not a web session (platform: ${entry.platform})`,
    });
    return true;
  }
  if (busy.has(appSessionId)) {
    jsonResponse(res, 409, { error: 'Session is busy' });
    return true;
  }

  const ctxKey = webContextKey(appSessionId);
  ensureSession(ctxKey, { platform: 'web' });
  const sessionId = getSession(ctxKey);

  const threadId = threadIdFor('web', appSessionId);
  const turnIdPrefix = url === '/api/pet/inbox' ? 'pet' : 'device';
  const turnId = turnIdFor('web', `${turnIdPrefix}-${Date.now()}`);
  const threadLabel = entry.title || `${label} inbox`;
  const eventCtx = {
    threadId,
    turnId,
    threadLabel,
    platform: 'web' as const,
    userText: text,
    eventTextSanitizer: stripReplySuggestionMarkup,
  };

  let prompt = `[プラットフォーム: Web (${label})]\n${text}`;
  const replySuggestionsEnabled = loadReplySuggestionsEnabled(replySuggestions.replySuggestions);
  if (replySuggestionsEnabled) {
    prompt = appendReplySuggestionInstruction(prompt, replySuggestions.replySuggestionCount);
  }

  // 202 を即返す。応答は events SSE 経由で pet 側に届く。
  const { instanceId } = getEventsConfig();
  jsonResponse(res, 202, {
    accepted: true,
    instance_id: instanceId,
    thread_id: threadId,
    turn_id: turnId,
    session_id: appSessionId,
    events_url: `/api/events/stream?thread_id=${encodeURIComponent(threadId)}`,
  });

  busy.add(appSessionId);
  console.log(`[inbox:${label}] Message (session ${appSessionId}): ${text.slice(0, 100)}`);
  flowFromHostPlatform(text, 'user');

  void (async () => {
    try {
      await runWithBubbleEvents(
        agentRunner,
        prompt,
        eventCtx,
        {
          onComplete: (completedResult) => {
            setProviderSessionId(appSessionId, completedResult.sessionId);
            setSession(ctxKey, completedResult.sessionId);
            incrementMessageCount(appSessionId);
            if (!entry.title) {
              updateSessionTitle(appSessionId, truncateSessionTitle(text));
            }
            flowFromHostPlatform(stripReplySuggestionMarkup(completedResult.result), 'agent');
          },
        },
        {
          sessionId,
          channelId: ctxKey,
          appSessionId,
        }
      );
    } catch (err) {
      console.error('[pet-inbox] agent run failed:', err);
    } finally {
      busy.delete(appSessionId);
    }
  })();

  return true;
}

/** テスト用: busy セットをクリア。 */
export function _resetPetInboxStateForTest(): void {
  busy.clear();
}
