/**
 * Even Terminal compatibility API.
 *
 * @evenrealities/even-terminal exposes a small HTTP API under /api:
 * sessions / info / prompt / events / messages / status plus response hooks.
 * This module implements the same surface on xangi Web Chat so the Even app's
 * terminal mode can connect to xangi without spawning claude/codex directly.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { AgentRunner } from './agent-runner.js';
import type { AgentBackend } from './config.js';
import type { LocalLlmMode } from './backend-resolver.js';
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
import { threadIdFor, turnIdFor, subscribeEvents } from './events-emitter.js';
import type { PublishedEvent } from './events-emitter.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import { flowFromHostPlatform } from './inter-instance-chat/index.js';
import { isLocalOrPrivate } from './pet-inbox-server.js';
import { readSessionMessages } from './transcript-logger.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_SESSION = 500;
const MAX_TERMINAL_TEXT_CHARS = Number(process.env.XANGI_EVEN_TERMINAL_MAX_CHARS) || 400;
const SUPPORTED_PROVIDERS = new Set(['claude', 'codex']);
const SUPPORTED_BACKENDS = new Set<AgentBackend>([
  'claude-code',
  'codex',
  'cursor',
  'grok',
  'local-llm',
]);
const SUPPORTED_LOCAL_LLM_MODES = new Set<LocalLlmMode>(['agent', 'lite', 'chat']);

function readEvenTerminalBackend(): AgentBackend | undefined {
  const value = process.env.XANGI_EVEN_TERMINAL_BACKEND?.trim();
  if (!value) return undefined;
  if (SUPPORTED_BACKENDS.has(value as AgentBackend)) return value as AgentBackend;
  console.warn(`[even-terminal] Ignoring invalid XANGI_EVEN_TERMINAL_BACKEND=${value}`);
  return undefined;
}

function readEvenTerminalLocalLlmMode(): LocalLlmMode | undefined {
  const value = process.env.XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE?.trim();
  if (!value) return undefined;
  if (SUPPORTED_LOCAL_LLM_MODES.has(value as LocalLlmMode)) return value as LocalLlmMode;
  console.warn(`[even-terminal] Ignoring invalid XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE=${value}`);
  return undefined;
}

interface BufferedMessage {
  id: number;
  [key: string]: unknown;
}

interface TerminalSessionState {
  messages: BufferedMessage[];
  clients: Set<ServerResponse>;
  nextId: number;
  status: 'idle' | 'busy' | 'awaiting';
  provider: 'claude' | 'codex';
}

const sessions = new Map<string, TerminalSessionState>();
const busy = new Set<string>();

function terminalLog(message: string): void {
  console.log(`[even-terminal] ${message}`);
}

function requestSummary(req: IncomingMessage, parsedUrl: URL): string {
  const provider = parsedUrl.searchParams.get('provider') || '-';
  const sessionId = parsedUrl.searchParams.get('sessionId') || '-';
  return `${req.method || 'GET'} ${parsedUrl.pathname} provider=${provider} session=${sessionId}`;
}

function webContextKey(appSessionId: string): string {
  return `${WEB_CHAT_CONTEXT_PREFIX}${appSessionId}`;
}

function getDefaultProviderLabel(): 'claude' | 'codex' {
  return process.env.AGENT_BACKEND === 'claude-code' ? 'claude' : 'codex';
}

function normalizeProvider(value: unknown): 'claude' | 'codex' {
  const raw = String(value || '').trim();
  if (SUPPORTED_PROVIDERS.has(raw)) return raw as 'claude' | 'codex';
  return getDefaultProviderLabel();
}

function getTerminalSession(sessionId: string): TerminalSessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      messages: [],
      clients: new Set(),
      nextId: 1,
      status: 'idle',
      provider: getDefaultProviderLabel(),
    };
    sessions.set(sessionId, s);
  }
  return s;
}

async function waitForTerminalClient(sessionId: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (getTerminalSession(sessionId).clients.size > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return getTerminalSession(sessionId).clients.size > 0;
}

async function waitForTerminalAssistantHistory(
  sessionId: string,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (hasAssistantHistory(getCombinedTerminalHistory(sessionId))) return;
    if (getTerminalSession(sessionId).status === 'idle') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function pushMessage(sessionId: string, msg: Record<string, unknown>): number {
  const s = getTerminalSession(sessionId);
  const id = s.nextId++;
  const entry: BufferedMessage = { id, ...msg };
  s.messages.push(entry);
  if (s.messages.length > MAX_MESSAGES_PER_SESSION) s.messages.shift();
  const data = JSON.stringify(msg);
  for (const client of s.clients) {
    try {
      client.write(`id: ${id}\ndata: ${data}\n\n`);
    } catch {
      s.clients.delete(client);
    }
  }
  return id;
}

function setStatus(
  sessionId: string,
  status: TerminalSessionState['status'],
  provider?: 'claude' | 'codex'
): void {
  const s = getTerminalSession(sessionId);
  s.status = status;
  if (provider) s.provider = provider;
  pushMessage(sessionId, { type: 'status', state: status, sessionId, provider: s.provider });
}

function cleanTerminalText(text: string, maxChars = MAX_TERMINAL_TEXT_CHARS): string {
  let t = text || '';
  t = t.replace(/```[\w-]*\n?/g, '');
  t = t.replace(/`/g, '');
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, '・');
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/__(.+?)__/g, '$1');
  t = t.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/\n{2,}/g, ' / ');
  t = t.replace(/\n/g, ' ');
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  if (maxChars > 0 && t.length > maxChars) {
    return `${t.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return t;
}

function cleanTerminalDelta(text: string): string {
  return cleanTerminalText(text, 0);
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = (
    process.env.XANGI_EVEN_TERMINAL_TOKEN ||
    process.env.XANGI_DEVICE_INBOX_TOKEN ||
    process.env.XANGI_PET_INBOX_TOKEN ||
    ''
  ).trim();

  if (!token) return isLocalOrPrivate(req.socket.remoteAddress);

  const authHeader = (req.headers.authorization || '').trim();
  const queryToken = new URL(req.url || '/', 'http://xangi.local').searchParams.get('token') || '';
  return authHeader === `Bearer ${token}` || queryToken === token;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
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

function eventToTerminalMessage(event: PublishedEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'turn.started':
      return event.user_text ? { type: 'user_prompt', text: event.user_text } : null;
    case 'message.delta': {
      const text = cleanTerminalDelta(event.text);
      return text ? { type: 'text_delta', text } : null;
    }
    case 'turn.complete':
      return { type: 'result', success: true, text: cleanTerminalText(event.text || '') };
    case 'turn.aborted':
      return { type: 'result', success: false, text: 'Turn aborted' };
    case 'agent.error':
      return { type: 'error', message: event.message };
    case 'timeout.started':
      return { type: 'notification', message: 'xangi timeout timer started' };
    case 'timeout.extended':
      return { type: 'notification', message: 'xangi timeout extended' };
    case 'timeout.cleared':
      return null;
    default:
      return null;
  }
}

function transcriptContentToText(content: string | Record<string, unknown>): string {
  if (typeof content === 'string') return cleanTerminalText(stripTerminalPromptPrefix(content));
  const result = content.result;
  if (typeof result === 'string') return cleanTerminalText(result);
  return cleanTerminalText(JSON.stringify(content));
}

function stripTerminalPromptPrefix(text: string): string {
  const marker = '[プラットフォーム: Web (Even Terminal)]';
  const idx = text.indexOf(marker);
  if (idx === -1) return text;
  return text.slice(idx + marker.length).replace(/^\s+/, '');
}

function getTerminalHistory(sessionId: string): Array<{ role: string; text: string }> {
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  return readSessionMessages(workdir, sessionId)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role,
      text: transcriptContentToText(m.content),
    }))
    .filter((m) => m.text.trim().length > 0);
}

function historyToMessages(
  history: Array<{ role: string; text: string }>
): Array<{ id: number; role: string; text: string }> {
  return history.map((m, idx) => ({
    id: idx + 1,
    role: m.role,
    text: m.text,
  }));
}

function terminalMessagesToHistory(
  messages: BufferedMessage[]
): Array<{ role: string; text: string }> {
  const history: Array<{ role: string; text: string }> = [];
  let assistantDelta = '';

  const flushAssistantDelta = (): void => {
    const text = cleanTerminalText(assistantDelta);
    if (text) history.push({ role: 'assistant', text });
    assistantDelta = '';
  };

  for (const msg of messages) {
    if (msg.type === 'user_prompt' && typeof msg.text === 'string') {
      flushAssistantDelta();
      history.push({ role: 'user', text: cleanTerminalText(msg.text) });
      continue;
    }
    if (msg.type === 'text_delta' && typeof msg.text === 'string') {
      assistantDelta += msg.text;
      continue;
    }
    if (msg.type === 'result' && typeof msg.text === 'string') {
      assistantDelta = '';
      const text = cleanTerminalText(msg.text);
      if (text) history.push({ role: 'assistant', text });
    }
  }
  flushAssistantDelta();
  return history;
}

function hasAssistantHistory(history: Array<{ role: string; text: string }>): boolean {
  return history.some((m) => m.role === 'assistant' && m.text.trim().length > 0);
}

function isEvenTerminalPlaceholderTitle(title: string | undefined): boolean {
  return !title || title === 'Even Terminal' || title === 'Even Terminal New Session';
}

function getCombinedTerminalHistory(sessionId: string): Array<{ role: string; text: string }> {
  const persisted = getTerminalHistory(sessionId);
  const live = terminalMessagesToHistory(getTerminalSession(sessionId).messages);
  return live.length > persisted.length ? live : persisted;
}

function summarizeTerminalHistory(
  sessionId: string,
  liveStatus: TerminalSessionState['status']
): {
  status: TerminalSessionState['status'];
  messageCount: number;
  lastMessage?: string;
  lastRole?: string;
} {
  const history = getCombinedTerminalHistory(sessionId);
  const last = history[history.length - 1];
  return {
    status: hasAssistantHistory(history) ? 'idle' : liveStatus,
    messageCount: history.length,
    lastMessage: last ? last.text.slice(0, 200) : undefined,
    lastRole: last?.role,
  };
}

async function handlePrompt(
  req: IncomingMessage,
  res: ServerResponse,
  agentRunner: AgentRunner
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    jsonResponse(res, 400, { error: e instanceof Error ? e.message : 'Invalid request body' });
    return;
  }

  const text = String(body.text || '').trim();
  if (!text) {
    jsonResponse(res, 400, { error: "Missing 'text' field" });
    return;
  }

  const provider = normalizeProvider(body.provider);
  const requestedAppSessionId = String(body.sessionId || '').trim();
  let appSessionId = requestedAppSessionId;
  const createdNewSession = !appSessionId;
  if (!appSessionId) {
    appSessionId = createWebSession({ title: 'Even Terminal' });
  }

  const entry = getSessionEntry(appSessionId);
  if (!entry) {
    jsonResponse(res, 404, { error: `Session ${appSessionId} not found` });
    return;
  }
  if (entry.platform !== 'web') {
    jsonResponse(res, 409, {
      error: `Session ${appSessionId} is not a web session (platform: ${entry.platform})`,
    });
    return;
  }
  if (busy.has(appSessionId)) {
    jsonResponse(res, 409, { error: 'Session is busy' });
    return;
  }

  const ctxKey = webContextKey(appSessionId);
  ensureSession(ctxKey, { platform: 'web' });
  const sessionId = getSession(ctxKey);
  const threadId = threadIdFor('web', appSessionId);
  const turnId = turnIdFor('web', `even-terminal-${Date.now()}`);
  const terminalState = getTerminalSession(appSessionId);
  terminalState.provider = provider;
  terminalState.status = 'awaiting';
  const startsReservedEmptySession =
    Boolean(requestedAppSessionId) &&
    entry.title === 'Even Terminal New Session' &&
    entry.messageCount === 0 &&
    getTerminalHistory(appSessionId).length === 0 &&
    terminalMessagesToHistory(terminalState.messages).length === 0;

  terminalLog(
    `prompt accepted session=${appSessionId} provider=${provider} textChars=${text.length}`
  );

  let unsubscribe = (): void => undefined;
  let startedTurn = false;
  const startTurn = (): void => {
    if (startedTurn) return;
    startedTurn = true;
    busy.add(appSessionId);
    setStatus(appSessionId, 'busy', provider);
    flowFromHostPlatform(text, 'user');
    unsubscribe = subscribeEvents((event) => {
      if (event.thread_id !== threadId) return;
      const msg = eventToTerminalMessage(event);
      if (msg) pushMessage(appSessionId, msg);
    });
  };

  if (startsReservedEmptySession) startTurn();

  jsonResponse(res, 202, { ok: true, sessionId: appSessionId, provider });

  if (createdNewSession) {
    const connected = await waitForTerminalClient(appSessionId, 2500);
    terminalLog(
      `prompt new-session event-client-ready session=${appSessionId} connected=${connected}`
    );
  }

  startTurn();

  const runPromise = (async () => {
    try {
      const result = await runWithBubbleEvents(
        agentRunner,
        `[プラットフォーム: Web (Even Terminal)]\n${text}`,
        {
          threadId,
          turnId,
          threadLabel: entry.title || 'Even Terminal',
          platform: 'web',
          userText: text,
        },
        {
          onComplete: (completedResult) => {
            setProviderSessionId(appSessionId, completedResult.sessionId);
            setSession(ctxKey, completedResult.sessionId);
            incrementMessageCount(appSessionId);
            if (isEvenTerminalPlaceholderTitle(entry.title)) {
              updateSessionTitle(appSessionId, text.slice(0, 50));
            }
            flowFromHostPlatform(completedResult.result, 'agent');
          },
          onError: (err) => {
            pushMessage(appSessionId, { type: 'error', message: err.message });
          },
        },
        {
          sessionId,
          channelId: ctxKey,
          appSessionId,
          defaultBackend: readEvenTerminalBackend(),
          defaultModel: process.env.XANGI_EVEN_TERMINAL_MODEL?.trim() || undefined,
          defaultLocalLlmMode: readEvenTerminalLocalLlmMode(),
        }
      );
      if (!result.result) {
        pushMessage(appSessionId, { type: 'result', success: true, text: '' });
      }
    } catch (err) {
      pushMessage(appSessionId, {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      unsubscribe();
      setStatus(appSessionId, 'idle', provider);
      busy.delete(appSessionId);
    }
  })();
  void runPromise;
}

function handleEvents(req: IncomingMessage, res: ServerResponse, parsedUrl: URL): void {
  const sessionId = parsedUrl.searchParams.get('sessionId') || '';
  if (!sessionId) {
    jsonResponse(res, 400, { error: "Missing 'sessionId' query parameter" });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  const s = getTerminalSession(sessionId);
  const shouldReplay = parsedUrl.searchParams.get('needReplay') === 'true' || s.messages.length > 0;
  terminalLog(
    `events connect session=${sessionId} replay=${shouldReplay} buffered=${s.messages.length} clients=${s.clients.size + 1}`
  );
  if (shouldReplay) {
    for (const entry of s.messages) {
      const { id, ...msg } = entry;
      res.write(`id: ${id}\ndata: ${JSON.stringify(msg)}\n\n`);
    }
  }

  s.clients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(':heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      s.clients.delete(res);
    }
  }, 15_000);
  heartbeat.unref();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    s.clients.delete(res);
    terminalLog(`events disconnect session=${sessionId} clients=${s.clients.size}`);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

function listTerminalSessions(provider: 'claude' | 'codex', limit: number): unknown[] {
  const all = listAllSessions()
    .filter((s) => s.platform === 'web' && s.title !== 'Even Terminal New Session')
    .slice(0, limit)
    .map((s) => {
      const terminal = getTerminalSession(s.id);
      const summary = summarizeTerminalHistory(s.id, terminal.status);
      return {
        id: s.id,
        title: s.title || s.id,
        cwd: process.env.WORKSPACE_PATH || process.cwd(),
        timestamp: s.updatedAt,
        status: summary.status,
        provider,
        messageCount: summary.messageCount,
        lastMessage: summary.lastMessage,
        lastRole: summary.lastRole,
        updatedAt: s.updatedAt,
      };
    });
  return all;
}

export async function handleEvenTerminalRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agentRunner: AgentRunner
): Promise<boolean> {
  const parsedUrl = new URL(req.url || '/', 'http://xangi.local');
  const path = parsedUrl.pathname;
  if (!path.startsWith('/api/')) return false;
  const historyMatch = path.match(/^\/api\/sessions\/([^/]+)\/history$/);

  // xangi Web Chat already owns GET/POST /api/sessions. Even Terminal calls the
  // same path with its token/provider context, so only claim that route when the
  // request looks like an Even Terminal client.
  if (
    path === '/api/sessions' &&
    !parsedUrl.searchParams.has('token') &&
    !parsedUrl.searchParams.has('provider') &&
    !req.headers.authorization
  ) {
    return false;
  }

  if (
    ![
      '/api/sessions',
      '/api/info',
      '/api/update-check',
      '/api/prompt',
      '/api/events',
      '/api/messages',
      '/api/status',
      '/api/permission-response',
      '/api/question-response',
      '/api/interrupt',
    ].includes(path) &&
    !historyMatch
  ) {
    return false;
  }

  if (!isAuthorized(req)) {
    terminalLog(`401 ${requestSummary(req, parsedUrl)}`);
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return true;
  }

  const provider = normalizeProvider(parsedUrl.searchParams.get('provider'));
  terminalLog(requestSummary(req, parsedUrl));

  if (path === '/api/sessions' && req.method === 'GET') {
    const limit = Number(parsedUrl.searchParams.get('limit')) || 10;
    const responseSessions = listTerminalSessions(provider, limit);
    terminalLog(`sessions response count=${responseSessions.length} provider=${provider}`);
    jsonResponse(res, 200, { sessions: responseSessions });
    return true;
  }

  if (path === '/api/info' && req.method === 'GET') {
    jsonResponse(res, 200, {
      account: {},
      model:
        process.env.AGENT_MODEL ||
        process.env.LOCAL_LLM_MODEL ||
        process.env.AGENT_BACKEND ||
        'xangi',
      version: process.env.npm_package_version || 'xangi',
      provider,
    });
    return true;
  }

  if (path === '/api/update-check' && req.method === 'GET') {
    jsonResponse(res, 200, {
      currentVersion: process.env.npm_package_version || 'xangi',
      newestVersion: null,
      updateAvailable: false,
    });
    return true;
  }

  if (historyMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(historyMatch[1]);
    const limit = Math.min(Number(parsedUrl.searchParams.get('limit')) || 10, 50);
    const s = getTerminalSession(sessionId);
    if (s.status !== 'idle' && !hasAssistantHistory(getCombinedTerminalHistory(sessionId))) {
      await waitForTerminalAssistantHistory(sessionId, 8000);
    }
    const history = getCombinedTerminalHistory(sessionId).slice(-limit);
    terminalLog(`history response session=${sessionId} count=${history.length} state=${s.status}`);
    jsonResponse(res, 200, { history });
    return true;
  }

  if (path === '/api/prompt' && req.method === 'POST') {
    await handlePrompt(req, res, agentRunner);
    return true;
  }

  if (path === '/api/events' && req.method === 'GET') {
    handleEvents(req, res, parsedUrl);
    return true;
  }

  if (path === '/api/messages' && req.method === 'GET') {
    const sessionId = parsedUrl.searchParams.get('sessionId') || '';
    if (!sessionId) {
      jsonResponse(res, 400, { error: "Missing 'sessionId'" });
      return true;
    }
    const after = Number(parsedUrl.searchParams.get('after')) || 0;
    const s = getTerminalSession(sessionId);
    let messages: Array<Record<string, unknown>> = s.messages.filter((m) => m.id > after);
    if (messages.length === 0 && after === 0) {
      messages = historyToMessages(getCombinedTerminalHistory(sessionId));
    }
    terminalLog(
      `messages response session=${sessionId} after=${after} count=${messages.length} state=${s.status}`
    );
    jsonResponse(res, 200, {
      messages,
      state: s.status,
      sessionId,
      provider,
    });
    return true;
  }

  if (path === '/api/status' && req.method === 'GET') {
    const sessionId = parsedUrl.searchParams.get('sessionId') || '';
    if (!sessionId) {
      jsonResponse(res, 400, { error: "Missing 'sessionId'" });
      return true;
    }
    const s = getTerminalSession(sessionId);
    terminalLog(`status response session=${sessionId} state=${s.status}`);
    jsonResponse(res, 200, { state: s.status, sessionId, provider });
    return true;
  }

  if (
    ['/api/permission-response', '/api/question-response', '/api/interrupt'].includes(path) &&
    req.method === 'POST'
  ) {
    jsonResponse(res, 200, { ok: true, ignored: true });
    return true;
  }

  return false;
}

/** テスト用: module-global state をクリア。 */
export function _resetEvenTerminalStateForTest(): void {
  sessions.clear();
  busy.clear();
}
