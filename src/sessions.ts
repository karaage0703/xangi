import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { sanitizeSessionTitle } from './session-title.js';

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
export type SessionLifecycle = 'open' | 'closed';
export type SessionCloseReason = 'new' | 'leave' | 'monitor' | 'web' | 'archive' | 'other';
export type ProviderSessionMode = 'stateful' | 'stateless';

export interface AgentInfo {
  backend: string; // AgentBackend (kept as string for persisted backward compatibility)
  model?: string;
  effort?: string;
  providerSessionId?: string;
  /** Whether the backend keeps provider-side context that can be resumed. */
  sessionMode?: ProviderSessionMode;
}

export interface SessionContextUsage {
  usedTokens: number;
  contextWindow: number;
  updatedAt: string;
  source: 'codex-app-server' | 'claude-result' | 'antigravity-statusline' | 'copilot-sdk';
}

export interface SessionTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  updatedAt: string;
}

export interface SessionEstimatedCost {
  value: number;
  updatedAt: string;
  source: 'antigravity-statusline';
}

export type SessionProgressStatus = 'pending' | 'in_progress' | 'completed';

export interface SessionProgressStep {
  step: string;
  status: SessionProgressStatus;
}

export interface SessionProgressCard {
  revision: number;
  updatedAt: string;
  plan: SessionProgressStep[];
  note?: string;
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
  /** 会話を通常継続するか。未設定の既存データはactiveByContextから安全に導出する。 */
  lifecycle?: SessionLifecycle;
  closedAt?: string;
  closeReason?: SessionCloseReason;
  /** Webへ引き継いだ元セッション。最初の発話で履歴を注入した後に消費する。 */
  resumedFromSessionId?: string;
  /** Webへ引き継いだ会話のうち、Discord/Slack上の起点セッション。 */
  externalSourceSessionId?: string;
  /** 自走モード（auto-talk）。true のとき、agent がランダム間隔で発話を続ける */
  autoTalk?: boolean;
  /** セッション作成時に選択されたworkspace ID。 */
  workspaceId?: string;
  /** セッション作成時のcanonical path snapshot。resume時に再解決しない。 */
  workspacePath?: string;
  /** Web UI上の論理Project。workspaceやディレクトリとは独立している。 */
  projectId?: string;
  /** 最後に完了したturn時点のprovider context使用量。 */
  contextUsage?: SessionContextUsage;
  /** このxangiセッション内で完了したturnの累積token使用量。 */
  tokenUsage?: SessionTokenUsage;
  /** Providerが報告したセッションの推定利用料。金額・通貨はxangi側で推定しない。 */
  estimatedCost?: SessionEstimatedCost;
  /** Agent-maintained, durable at-a-glance progress for this session. */
  progressCard?: SessionProgressCard;
}

interface SessionsFile {
  activeByContext: Record<string, string>;
  sessions: Record<string, SessionEntry>;
}

interface SessionSnapshotOptions {
  workspaceId?: string;
  workspacePath?: string;
  projectId?: string;
}

let sessionsPath: string | null = null;
let data: SessionsFile = { activeByContext: {}, sessions: {} };
let currentBootId: string = randomUUID();
const sessionChangeListeners = new Set<() => void>();

function notifySessionChanges(): void {
  for (const listener of sessionChangeListeners) {
    try {
      listener();
    } catch {
      // Persistence must not fail because a disconnected UI listener threw.
    }
  }
}

/**
 * sessions.json のパスを初期化
 */
export function initSessions(dataDir: string): void {
  sessionsPath = join(dataDir, 'sessions.json');
  currentBootId = randomUUID();
  loadSessionsFromFile();
  purgeSchedulerSessions();
  pruneOldSessions(getRetentionDays());
}

/**
 * 起動時のセッション保持日数を環境変数から取得。
 * 未設定なら 0（剪定しない）。`XANGI_SESSION_RETENTION_DAYS=90` のように
 * 日数を指定したときだけ起動時に剪定する。
 * sessions.json は 1 エントリ数百バイト程度なので、デフォルトでは全履歴を残す。
 */
function getRetentionDays(): number {
  const raw = process.env.XANGI_SESSION_RETENTION_DAYS;
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
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
      let repairedTitles = 0;
      for (const entry of Object.values(data.sessions)) {
        const sanitized = sanitizeSessionTitle(entry.title || '');
        if (sanitized !== entry.title) {
          entry.title = sanitized;
          repairedTitles++;
        }
      }
      if (repairedTitles > 0) {
        saveSessionsToFile();
        console.log(`[xangi] Repaired ${repairedTitles} session title(s) with invalid Unicode`);
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
  let repaired = 0;
  for (const [id, entry] of Object.entries(data.sessions)) {
    if (entry.scope === 'scheduler') {
      for (const [ctx, activeId] of Object.entries(data.activeByContext)) {
        if (activeId === id) {
          delete data.activeByContext[ctx];
        }
      }
      if (id.startsWith('scheduler-run-')) {
        if (entry.lifecycle !== 'closed') {
          entry.lifecycle = 'closed';
          entry.closedAt = entry.updatedAt;
          entry.closeReason = 'other';
          repaired++;
        }
      } else {
        delete data.sessions[id];
        purged++;
      }
    }
  }
  if (purged > 0 || repaired > 0) {
    console.log(
      `[xangi] Purged ${purged} legacy scheduler session(s), closed ${repaired} interrupted run(s)`
    );
    saveSessionsToFile();
  }
}

/**
 * `updatedAt` が `maxAgeDays` より古いセッションを sessions.json から削除する。
 * メッセージ本体（`logs/sessions/<id>.jsonl`）は触らない — 必要なら別途ローテすること。
 *
 * `maxAgeDays = 0` のとき剪定をスキップ。
 * テスト容易性のため `now` を引数で差し替え可能。
 */
export function pruneOldSessions(maxAgeDays: number, now: number = Date.now()): number {
  if (maxAgeDays <= 0) return 0;
  const cutoff = now - maxAgeDays * 86_400_000;
  let pruned = 0;
  for (const [id, entry] of Object.entries(data.sessions)) {
    const t = Date.parse(entry.updatedAt);
    if (Number.isNaN(t) || t >= cutoff) continue;
    delete data.sessions[id];
    for (const [ctx, activeId] of Object.entries(data.activeByContext)) {
      if (activeId === id) {
        delete data.activeByContext[ctx];
      }
    }
    pruned++;
  }
  if (pruned > 0) {
    console.log(
      `[xangi] Pruned ${pruned} session(s) older than ${maxAgeDays} day(s) from sessions.json`
    );
    saveSessionsToFile();
  }
  return pruned;
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
 * Web セッション用の contextKey プレフィックス
 *
 * 各 Web セッションは `web-chat:<appSessionId>` を contextKey として持つことで、
 * ランナー / providerSession / activeByContext がセッション単位で独立する。
 */
export const WEB_CHAT_CONTEXT_PREFIX = 'web-chat:';

/** WebのcontextKeyまたは生appSessionIdを、生appSessionIdへ正規化する。 */
export function webAppSessionId(channelId: string): string {
  return channelId.startsWith(WEB_CHAT_CONTEXT_PREFIX)
    ? channelId.slice(WEB_CHAT_CONTEXT_PREFIX.length)
    : channelId;
}

/**
 * Web 用のセッションを作成する。contextKey は `web-chat:<appSessionId>` で自動生成。
 * 同時に複数の Web セッションを保持・操作できる。
 */
export function createWebSession(
  opts: {
    title?: string;
    backend?: string;
    resumedFromSessionId?: string;
  } & SessionSnapshotOptions = {}
): string {
  const appId = generateAppSessionId();
  const ctxKey = `${WEB_CHAT_CONTEXT_PREFIX}${appId}`;
  const now = new Date().toISOString();

  const resumedFrom = opts.resumedFromSessionId
    ? data.sessions[opts.resumedFromSessionId]
    : undefined;
  const externalSourceSessionId = resumedFrom
    ? resumedFrom.platform === 'discord' || resumedFrom.platform === 'slack'
      ? resumedFrom.id
      : resumedFrom.externalSourceSessionId
    : undefined;
  data.sessions[appId] = {
    id: appId,
    title: sanitizeSessionTitle(opts.title || ''),
    platform: 'web',
    contextKey: ctxKey,
    scope: 'interactive',
    bootId: currentBootId,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    agent: opts.backend ? { backend: opts.backend } : undefined,
    archived: false,
    lifecycle: 'open',
    resumedFromSessionId: opts.resumedFromSessionId,
    externalSourceSessionId,
    workspaceId: opts.workspaceId ?? resumedFrom?.workspaceId,
    workspacePath: opts.workspacePath ?? resumedFrom?.workspacePath,
    projectId: opts.projectId ?? resumedFrom?.projectId,
  };
  data.activeByContext[ctxKey] = appId;
  saveSessionsToFile();
  return appId;
}

/**
 * Web resume 元を消費済みにする。履歴は最初の発話にだけ注入する。
 */
export function clearResumedFromSessionId(appSessionId: string): void {
  const entry = data.sessions[appSessionId];
  if (!entry?.resumedFromSessionId) return;
  delete entry.resumedFromSessionId;
  saveSessionsToFile();
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
  } & SessionSnapshotOptions = {}
): string {
  const appId = generateAppSessionId();
  const now = new Date().toISOString();

  data.sessions[appId] = {
    id: appId,
    title: sanitizeSessionTitle(opts.title || ''),
    platform: opts.platform || 'discord',
    contextKey,
    scope: opts.scope || 'interactive',
    bootId: currentBootId,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    agent: opts.backend ? { backend: opts.backend } : undefined,
    archived: false,
    lifecycle: 'open',
    workspaceId: opts.workspaceId,
    workspacePath: opts.workspacePath,
    projectId: opts.projectId,
  };
  data.activeByContext[contextKey] = appId;
  saveSessionsToFile();
  return appId;
}

/** activeByContextを変更せず、1回のスケジュール実行を独立Sessionとして登録する。 */
export function createSchedulerSession(
  appId: string,
  contextKey: string,
  opts: { platform: string; title: string } & SessionSnapshotOptions
): string {
  const now = new Date().toISOString();
  data.sessions[appId] = {
    id: appId,
    title: sanitizeSessionTitle(opts.title),
    platform: opts.platform,
    contextKey,
    scope: 'scheduler',
    bootId: currentBootId,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    archived: false,
    lifecycle: 'open',
    workspaceId: opts.workspaceId,
    workspacePath: opts.workspacePath,
  };
  saveSessionsToFile();
  notifySessionChanges();
  return appId;
}

/**
 * セッションにproviderSessionIdを後付け保存
 */
export function setProviderSessionId(
  appSessionId: string,
  providerSessionId: string,
  backend?: string,
  model?: string,
  effort?: string,
  sessionMode?: ProviderSessionMode
): void {
  const entry = data.sessions[appSessionId];
  if (!entry) return;
  entry.agent = {
    backend: backend || entry.agent?.backend || 'claude-code',
    model: model ?? entry.agent?.model,
    effort: effort ?? entry.agent?.effort,
    providerSessionId,
    sessionMode: sessionMode ?? entry.agent?.sessionMode,
  };
  entry.updatedAt = new Date().toISOString();
  saveSessionsToFile();
}

/** Persist backend continuation semantics before a request starts, including failed requests. */
export function setProviderSessionMode(
  appSessionId: string,
  backend: string,
  sessionMode: ProviderSessionMode
): void {
  const entry = data.sessions[appSessionId];
  if (!entry) return;
  if (entry.agent?.backend === backend && entry.agent.sessionMode === sessionMode) return;
  entry.agent = {
    ...entry.agent,
    backend,
    sessionMode,
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
  entry.title = sanitizeSessionTitle(title);
  entry.updatedAt = new Date().toISOString();
  saveSessionsToFile();
}

/** Webセッションの所属Projectを変更する。undefinedでProjectなしへ戻す。 */
export function updateSessionProject(appSessionId: string, projectId?: string): boolean {
  const entry = data.sessions[appSessionId];
  if (!entry || entry.platform !== 'web') return false;
  entry.projectId = projectId;
  entry.updatedAt = new Date().toISOString();
  saveSessionsToFile();
  return true;
}

export function updateSessionContextUsage(
  appSessionId: string,
  usage: Omit<SessionContextUsage, 'updatedAt'>
): boolean {
  const entry = data.sessions[appSessionId];
  if (!entry || usage.usedTokens < 0 || usage.contextWindow <= 0) return false;
  entry.contextUsage = { ...usage, updatedAt: new Date().toISOString() };
  saveSessionsToFile();
  notifySessionChanges();
  return true;
}

export function addSessionTokenUsage(
  appSessionId: string,
  usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }
): boolean {
  const entry = data.sessions[appSessionId];
  if (!entry) return false;
  const values = [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens];
  if (values.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) {
    return false;
  }
  const previous = entry.tokenUsage;
  entry.tokenUsage = {
    inputTokens: (previous?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
    cachedInputTokens: (previous?.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
    outputTokens: (previous?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    updatedAt: new Date().toISOString(),
  };
  saveSessionsToFile();
  notifySessionChanges();
  return true;
}

export function updateSessionEstimatedCost(
  appSessionId: string,
  cost: Omit<SessionEstimatedCost, 'updatedAt'>
): boolean {
  const entry = data.sessions[appSessionId];
  if (!entry || !Number.isFinite(cost.value) || cost.value < 0) return false;
  entry.estimatedCost = { ...cost, updatedAt: new Date().toISOString() };
  saveSessionsToFile();
  notifySessionChanges();
  return true;
}

export function replaceSessionProgressCard(
  appSessionId: string,
  input: { plan?: SessionProgressStep[]; note?: string; clear?: boolean }
): SessionProgressCard | undefined {
  const entry = data.sessions[appSessionId];
  if (!entry) return undefined;

  if (input.clear) {
    delete entry.progressCard;
    entry.updatedAt = new Date().toISOString();
    saveSessionsToFile();
    notifySessionChanges();
    return undefined;
  }

  const now = new Date().toISOString();
  entry.progressCard = {
    revision: (entry.progressCard?.revision ?? 0) + 1,
    updatedAt: now,
    plan: input.plan ?? [],
    ...(input.note ? { note: input.note } : {}),
  };
  entry.updatedAt = now;
  saveSessionsToFile();
  notifySessionChanges();
  return entry.progressCard;
}

export function updateSessionContextUsageByProviderSession(
  backend: string,
  providerSessionId: string,
  usage: Omit<SessionContextUsage, 'updatedAt'>
): boolean {
  const entry = findLatestSessionByProviderSession(backend, providerSessionId);
  return entry ? updateSessionContextUsage(entry.id, usage) : false;
}

function findLatestSessionByProviderSession(
  backend: string,
  providerSessionId: string
): SessionEntry | undefined {
  return Object.values(data.sessions).reduce<SessionEntry | undefined>((latest, candidate) => {
    if (
      candidate.agent?.backend !== backend ||
      candidate.agent.providerSessionId !== providerSessionId
    ) {
      return latest;
    }
    return !latest || candidate.updatedAt >= latest.updatedAt ? candidate : latest;
  }, undefined);
}

export function updateSessionEstimatedCostByProviderSession(
  backend: string,
  providerSessionId: string,
  cost: Omit<SessionEstimatedCost, 'updatedAt'>
): boolean {
  const entry = findLatestSessionByProviderSession(backend, providerSessionId);
  return entry ? updateSessionEstimatedCost(entry.id, cost) : false;
}

export function subscribeSessionChanges(listener: () => void): () => void {
  sessionChangeListeners.add(listener);
  return () => sessionChangeListeners.delete(listener);
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
  entry.lifecycle = 'closed';
  entry.closedAt = new Date().toISOString();
  entry.closeReason = 'archive';
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
    entry.lifecycle = 'open';
    delete entry.closedAt;
    delete entry.closeReason;
    entry.updatedAt = new Date().toISOString();
  }
  saveSessionsToFile();
}

/**
 * Sessionの会話ライフサイクルを返す。
 * 既存データにはlifecycleがないため、安全側でclosedとして扱う。
 * 実際に次の入力を受けた時点でensureSessionが明示的にopenへ移行する。
 */
export function getSessionLifecycle(appSessionId: string): SessionLifecycle {
  const entry = data.sessions[appSessionId];
  if (!entry) return 'closed';
  if (entry.lifecycle) return entry.lifecycle;
  return 'closed';
}

/** Sessionを終了済みにし、次回投稿のrouting pointerから外す。履歴は削除しない。 */
export function closeSession(appSessionId: string, reason: SessionCloseReason = 'other'): boolean {
  const entry = data.sessions[appSessionId];
  if (!entry) return false;
  const now = new Date().toISOString();
  entry.lifecycle = 'closed';
  entry.closedAt = now;
  entry.closeReason = reason;
  entry.autoTalk = false;
  entry.updatedAt = now;
  for (const [ctx, id] of Object.entries(data.activeByContext)) {
    if (id === appSessionId) delete data.activeByContext[ctx];
  }
  saveSessionsToFile();
  notifySessionChanges();
  return true;
}

/** contextの現在Sessionを終了する。 */
export function closeActiveSession(
  contextKey: string,
  reason: SessionCloseReason = 'other'
): boolean {
  const appSessionId = data.activeByContext[contextKey];
  return appSessionId ? closeSession(appSessionId, reason) : false;
}

/**
 * セッションの autoTalk フラグを設定
 */
export function setAutoTalk(appSessionId: string, enabled: boolean): boolean {
  const entry = data.sessions[appSessionId];
  if (!entry) return false;
  entry.autoTalk = enabled;
  entry.updatedAt = new Date().toISOString();
  saveSessionsToFile();
  return true;
}

/**
 * autoTalk=true の全セッション一覧
 */
export function listAutoTalkSessions(): SessionEntry[] {
  return Object.values(data.sessions).filter((s) => !s.archived && s.autoTalk === true);
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
  opts?: { platform?: string; scope?: SessionScope; backend?: string } & SessionSnapshotOptions
): string {
  const existing = data.activeByContext[contextKey];
  if (existing && data.sessions[existing]) {
    const entry = data.sessions[existing];
    if (entry.lifecycle !== 'open') {
      entry.lifecycle = 'open';
      delete entry.closedAt;
      delete entry.closeReason;
      entry.updatedAt = new Date().toISOString();
      saveSessionsToFile();
    }
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

/**
 * セッションがアイドル状態（一定時間経過）になったか判定する
 */
export function hasSessionGoneIdle(
  lastActivityIso: string | undefined,
  idleMs: number,
  now: number = Date.now()
): boolean {
  if (!lastActivityIso || idleMs <= 0) return false;
  const last = Date.parse(lastActivityIso);
  if (!Number.isFinite(last)) return false;
  return now - last >= idleMs;
}
