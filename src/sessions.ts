import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

/**
 * セッション管理（appSessionId方式）
 *
 * - appSessionId: xangi独自のセッションID。/new時やチャット開始時にxangi側で即確定
 * - providerSessionId: Claude Code等のbackendが返すsessionId。応答後に後付け保存
 *
 * sessions.json の構造:
 * {
 *   "activeByContext": { "<contextKey>": "<appSessionId>" },
 *   "sessions": { "<appSessionId>": SessionEntry }
 * }
 *
 * ログファイル: logs/sessions/<appSessionId>.jsonl
 */

export type SessionScope = 'interactive' | 'scheduler';

export interface AgentInfo {
  backend: string; // 'claude-code' | 'codex' | 'gemini' | 'local-llm'
  providerSessionId?: string;
}

export interface SessionEntry {
  id: string; // appSessionId
  title: string;
  platform: string; // 'discord' | 'slack' | 'web'
  contextKey: string; // channelId or 'web-chat'
  scope: SessionScope;
  bootId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  agent?: AgentInfo;
  archived: boolean;
}

interface SessionsFile {
  activeByContext: Record<string, string>;
  sessions: Record<string, SessionEntry>;
}

let sessionsPath: string | null = null;
let data: SessionsFile = { activeByContext: {}, sessions: {} };
let currentBootId: string = randomUUID();

/**
 * sessions.json のパスを初期化
 */
export function initSessions(dataDir: string): void {
  sessionsPath = join(dataDir, 'sessions.json');
  currentBootId = randomUUID();
  loadSessionsFromFile();
  purgeSchedulerSessions();
}

export function getBootId(): string {
  return currentBootId;
}

export function getSessionsPath(): string {
  if (!sessionsPath) {
    throw new Error('Sessions not initialized. Call initSessions(dataDir) first.');
  }
  return sessionsPath;
}

/**
 * ファイルからセッションを読み込む（旧フォーマットとの後方互換あり）
 */
function loadSessionsFromFile(): void {
  const path = getSessionsPath();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);

      // 新フォーマット検出
      if (parsed.activeByContext && parsed.sessions) {
        data = parsed as SessionsFile;
      } else {
        // 旧フォーマット: { channelId: SessionEntry | string } → 移行
        data = { activeByContext: {}, sessions: {} };
        for (const [key, value] of Object.entries(parsed)) {
          const entry =
            typeof value === 'string'
              ? {
                  sessionId: value,
                  scope: 'interactive' as const,
                  bootId: '',
                  updatedAt: new Date().toISOString(),
                }
              : (value as {
                  sessionId: string;
                  scope?: string;
                  bootId?: string;
                  updatedAt?: string;
                  title?: string;
                  platform?: string;
                  createdAt?: string;
                });

          const appId = generateAppSessionId();
          data.sessions[appId] = {
            id: appId,
            title: (entry as { title?: string }).title || '',
            platform: (entry as { platform?: string }).platform || 'discord',
            contextKey: key,
            scope: (entry.scope as SessionScope) || 'interactive',
            bootId: entry.bootId || '',
            createdAt:
              (entry as { createdAt?: string }).createdAt ||
              entry.updatedAt ||
              new Date().toISOString(),
            updatedAt: entry.updatedAt || new Date().toISOString(),
            messageCount: 0,
            agent: entry.sessionId
              ? { backend: 'claude-code', providerSessionId: entry.sessionId }
              : undefined,
            archived: false,
          };
          data.activeByContext[key] = appId;
        }
        console.log(`[xangi] Migrated ${Object.keys(data.sessions).length} sessions to new format`);
      }
      console.log(`[xangi] Loaded ${Object.keys(data.sessions).length} sessions from ${path}`);
    }
  } catch (err) {
    console.error('[xangi] Failed to load sessions:', err);
    data = { activeByContext: {}, sessions: {} };
  }
}

function saveSessionsToFile(): void {
  const path = getSessionsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('[xangi] Failed to save sessions:', err);
  }
}

function purgeSchedulerSessions(): void {
  let purged = 0;
  for (const [id, entry] of Object.entries(data.sessions)) {
    if (entry.scope === 'scheduler') {
      delete data.sessions[id];
      // activeByContextからも消す
      for (const [ctx, activeId] of Object.entries(data.activeByContext)) {
        if (activeId === id) {
          delete data.activeByContext[ctx];
        }
      }
      purged++;
    }
  }
  if (purged > 0) {
    console.log(`[xangi] Purged ${purged} stale scheduler session(s)`);
    saveSessionsToFile();
  }
}

/**
 * appSessionIdを生成（ULID風の時刻ソート可能なID）
 */
function generateAppSessionId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${ts}_${rand}`;
}

// ─── Public API ───

/**
 * contextKey(channelId等)からアクティブなappSessionIdを取得
 */
export function getActiveSessionId(contextKey: string): string | undefined {
  return data.activeByContext[contextKey];
}

/**
 * appSessionIdからセッション情報を取得
 */
export function getSessionEntry(appSessionId: string): SessionEntry | undefined {
  return data.sessions[appSessionId];
}

/**
 * contextKeyからアクティブセッションのproviderSessionIdを取得（--resume用）
 */
export function getProviderSessionId(contextKey: string): string | undefined {
  const appId = data.activeByContext[contextKey];
  if (!appId) return undefined;
  return data.sessions[appId]?.agent?.providerSessionId;
}

/**
 * 後方互換: getSession(channelId) → providerSessionId
 */
export function getSession(channelId: string): string | undefined {
  return getProviderSessionId(channelId);
}

/**
 * 新しいセッションを作成してアクティブにする
 */
export function createSession(
  contextKey: string,
  opts: {
    platform?: string;
    scope?: SessionScope;
    title?: string;
    backend?: string;
  } = {}
): string {
  const appId = generateAppSessionId();
  const now = new Date().toISOString();

  data.sessions[appId] = {
    id: appId,
    title: opts.title || '',
    platform: opts.platform || 'discord',
    contextKey,
    scope: opts.scope || 'interactive',
    bootId: currentBootId,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    agent: opts.backend ? { backend: opts.backend } : undefined,
    archived: false,
  };
  data.activeByContext[contextKey] = appId;
  saveSessionsToFile();
  return appId;
}

/**
 * セッションにproviderSessionIdを後付け保存
 */
export function setProviderSessionId(
  appSessionId: string,
  providerSessionId: string,
  backend?: string
): void {
  const entry = data.sessions[appSessionId];
  if (!entry) return;
  entry.agent = {
    backend: backend || entry.agent?.backend || 'claude-code',
    providerSessionId,
  };
  entry.updatedAt = new Date().toISOString();
  saveSessionsToFile();
}

/**
 * 後方互換: setSession(channelId, providerSessionId, scope)
 * アクティブセッションが無ければ新規作成、あれば更新
 */
export function setSession(
  channelId: string,
  providerSessionId: string,
  scope: SessionScope = 'interactive'
): void {
  let appId = data.activeByContext[channelId];
  if (!appId || !data.sessions[appId]) {
    appId = createSession(channelId, { scope });
  }
  setProviderSessionId(appId, providerSessionId);
}

/**
 * セッションのタイトルを更新
 */
export function updateSessionTitle(appSessionId: string, title: string): void {
  const entry = data.sessions[appSessionId];
  if (!entry) return;
  entry.title = title;
  entry.updatedAt = new Date().toISOString();
  saveSessionsToFile();
}

/**
 * セッションのメッセージ数をインクリメント
 */
export function incrementMessageCount(appSessionId: string): void {
  const entry = data.sessions[appSessionId];
  if (!entry) return;
  entry.messageCount++;
  entry.updatedAt = new Date().toISOString();
  saveSessionsToFile();
}

/**
 * セッションをアーカイブ
 */
export function archiveSession(appSessionId: string): void {
  const entry = data.sessions[appSessionId];
  if (!entry) return;
  entry.archived = true;
  // activeByContextから外す
  for (const [ctx, id] of Object.entries(data.activeByContext)) {
    if (id === appSessionId) {
      delete data.activeByContext[ctx];
    }
  }
  saveSessionsToFile();
}

/**
 * 既存セッションを指定contextKeyのアクティブにする（resume用）
 */
export function activateSession(contextKey: string, appSessionId: string): void {
  data.activeByContext[contextKey] = appSessionId;
  const entry = data.sessions[appSessionId];
  if (entry) {
    entry.archived = false;
    entry.updatedAt = new Date().toISOString();
  }
  saveSessionsToFile();
}

/**
 * セッションを完全削除（sessions.jsonから消す）
 */
export function removeSession(appSessionId: string): void {
  delete data.sessions[appSessionId];
  for (const [ctx, id] of Object.entries(data.activeByContext)) {
    if (id === appSessionId) {
      delete data.activeByContext[ctx];
    }
  }
  saveSessionsToFile();
}

/**
 * セッションを削除（/newで使う）
 */
export function deleteSession(channelId: string): boolean {
  const appId = data.activeByContext[channelId];
  if (appId) {
    delete data.activeByContext[channelId];
    saveSessionsToFile();
    return true;
  }
  return false;
}

/**
 * アクティブなappSessionIdを取得。無ければ新規作成
 */
export function ensureSession(
  contextKey: string,
  opts?: { platform?: string; scope?: SessionScope; backend?: string }
): string {
  const existing = data.activeByContext[contextKey];
  if (existing && data.sessions[existing]) {
    return existing;
  }
  return createSession(contextKey, opts);
}

/**
 * 全セッション一覧（サイドバー用）
 */
export function listAllSessions(): SessionEntry[] {
  return Object.values(data.sessions)
    .filter((s) => !s.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * セッション数を取得
 */
export function getSessionCount(): number {
  return Object.keys(data.sessions).length;
}

/**
 * 全セッションをクリア（テスト用）
 */
export function clearSessions(): void {
  data = { activeByContext: {}, sessions: {} };
  sessionsPath = null;
}
