import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppTopbar } from './AppTopbar';
import { ConfirmDialog } from './ConfirmDialog';
import { sessionPath } from './sessionPermalink';

export interface MonitorActivityHistory {
  state: string;
  summary: string;
  at: number;
}

export interface MonitorActivity {
  state: string;
  summary: string;
  active: boolean;
  toolLines?: string[];
  history?: MonitorActivityHistory[];
  startedAt?: number;
  updatedAt?: number;
  elapsedSec?: number;
  threadLabel?: string;
}

interface MonitorBackend {
  backend: string;
  model?: string;
  effort?: string;
}

interface MonitorOrigin {
  channelId?: string;
  channelName?: string;
  threadId?: string;
  threadName?: string;
}

interface MonitorContextUsage {
  usedTokens: number;
  contextWindow: number;
  updatedAt: string;
}

interface MonitorEstimatedCost {
  value: number;
  updatedAt: string;
}

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt?: number;
  windowDurationMins?: number;
}

interface UsageGroup {
  id: string;
  label: string;
  planType?: string;
  windows: UsageWindow[];
}

interface UsageProvider {
  id: string;
  label: string;
  groups: UsageGroup[];
}

export interface MonitorSession {
  id: string;
  title?: string;
  platform?: string;
  contextKey?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  isActive?: boolean;
  isCurrent?: boolean;
  lifecycle?: 'open' | 'closed';
  sessionMode?: 'stateful' | 'stateless';
  closedAt?: string;
  closeReason?: string;
  activity?: MonitorActivity;
  backend?: MonitorBackend;
  origin?: MonitorOrigin;
  contextUsage?: MonitorContextUsage;
  estimatedCost?: MonitorEstimatedCost;
}

export interface MonitorSessionsResponse {
  sessions?: MonitorSession[];
  meta?: {
    limit?: number;
    total?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
    processCwd?: string;
    workdir?: string;
  };
}

interface AccountUsageResponse {
  providers?: UsageProvider[];
  updatedAt?: string;
  stale?: boolean;
}

interface MonitorActivityEvent {
  type: 'turn.started' | 'turn.complete' | 'turn.aborted' | 'agent.error';
  thread_id: string;
  thread_label?: string;
  platform?: string;
  user_text?: string;
  text?: string;
  message?: string;
  ts: number;
}

type MonitorFilter = 'chat' | 'web' | 'all';
export type MonitorLane = 'running' | 'waiting' | 'completed';

const PAGE_SIZE = 200;
const RECENT_MS = 24 * 60 * 60 * 1000;
const USAGE_VISIBILITY_KEY = 'xangi.monitor.hidden-usage-providers';

const FILTERS: Array<{ value: MonitorFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'chat', label: 'Chat' },
  { value: 'web', label: 'Web' },
];

const LANES: Array<{ value: MonitorLane; label: string; description: string }> = [
  { value: 'running', label: '実行中', description: '返答・tool実行中' },
  { value: 'waiting', label: '入力待ち', description: '次の入力を待機・継続可能' },
  { value: 'completed', label: '完了', description: '24時間以内に完了・再開可能' },
];

export function usagePacePercent(
  window: Pick<UsageWindow, 'resetsAt' | 'windowDurationMins'>,
  now = Date.now()
): number | undefined {
  if (!window.resetsAt || !window.windowDurationMins || window.windowDurationMins <= 0) {
    return undefined;
  }
  const durationMs = window.windowDurationMins * 60_000;
  const startMs = window.resetsAt * 1000 - durationMs;
  return Math.min(100, Math.max(0, ((now - startMs) / durationMs) * 100));
}

export function formatEstimatedCost(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

export function usageGroupPresentation(group: Pick<UsageGroup, 'id' | 'label' | 'planType'>): {
  title: string;
  description: string;
} {
  const plan = group.planType ? ` · ${group.planType}` : '';
  if (group.id === 'codex') {
    return { title: 'Codex共通枠', description: `${group.label}${plan}` };
  }
  return { title: group.label, description: group.planType || '' };
}

export function visibleUsageGroups(groups: UsageGroup[]): UsageGroup[] {
  return groups.filter((group) => group.id !== 'codex_bengalfox');
}

export function displayUsageProviders(providers: UsageProvider[]): UsageProvider[] {
  return providers
    .map((provider) => ({
      ...provider,
      groups: visibleUsageGroups(provider.groups),
    }))
    .filter((provider) => provider.groups.length > 0);
}

function isRunning(session: MonitorSession): boolean {
  return session.isActive === true;
}

export function isMonitorVisible(session: MonitorSession): boolean {
  return isRunning(session) || session.sessionMode !== 'stateless';
}

function isChatPlatform(session: MonitorSession): boolean {
  return session.platform === 'discord' || session.platform === 'slack';
}

function isRecent(session: MonitorSession, now = Date.now()): boolean {
  const updatedAt = Date.parse(session.updatedAt || session.createdAt || '');
  return Number.isFinite(updatedAt) && now - updatedAt < RECENT_MS;
}

function matchesFilter(session: MonitorSession, filter: MonitorFilter): boolean {
  if (filter === 'chat') return isChatPlatform(session);
  if (filter === 'web') return session.platform === 'web';
  return true;
}

export function monitorLane(session: MonitorSession): MonitorLane {
  if (session.lifecycle !== 'open') return 'completed';
  if (isRunning(session)) return 'running';
  return 'waiting';
}

function platformLabel(platform?: string): string {
  if (platform === 'discord') return 'D';
  if (platform === 'slack') return 'S';
  if (platform === 'web') return 'W';
  return (platform || '?').slice(0, 1);
}

function platformName(platform?: string): string {
  if (platform === 'discord') return 'Discord';
  if (platform === 'slack') return 'Slack';
  if (platform === 'web') return 'Web';
  return platform || 'Unknown';
}

function stateLabel(session: MonitorSession): string {
  if (monitorLane(session) === 'completed') return '完了';
  if (!isRunning(session)) {
    if (session.activity?.state === 'error') return 'エラー';
    if (session.activity?.state === 'aborted') return '中断';
    return '入力待ち';
  }
  if (session.activity?.state === 'tool') return 'tool実行中';
  if (session.activity?.state === 'streaming') return '応答中';
  if (session.activity?.state === 'thinking') return '考え中';
  return session.activity?.state || '実行中';
}

function stateDescription(session: MonitorSession): string {
  if (monitorLane(session) === 'completed') return '履歴から再開・分岐できる';
  if (isRunning(session)) return '今このターンが動いている';
  if (monitorLane(session) === 'waiting') return 'このセッションで会話を継続できる';
  return 'このセッションで会話を継続できる';
}

function sessionLine(session: MonitorSession): string {
  return (
    session.activity?.summary ||
    (monitorLane(session) === 'completed' ? '完了: 現在の処理なし' : '次の入力を待っています')
  );
}

export function conversationLabel(session: MonitorSession): string {
  if (session.platform === 'web') return 'Web Chat';
  const channelName = session.origin?.channelName || session.activity?.threadLabel;
  const channel = channelName ? `#${channelName.replace(/^#/, '')}` : session.origin?.channelId;
  return `${platformName(session.platform)} · ${channel || '-'}`;
}

function shortId(id?: string): string {
  const raw = String(id || '');
  if (raw.length <= 12) return raw;
  return `${raw.slice(0, 8)}...${raw.slice(-4)}`;
}

function formatAge(value?: string, now = Date.now()): string {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(time?: number): string {
  return Number.isFinite(time) ? new Date(time as number).toLocaleTimeString() : '--';
}

export function activityFromEvent(
  session: MonitorSession,
  event: MonitorActivityEvent
): MonitorSession {
  const active = event.type === 'turn.started';
  const state =
    event.type === 'turn.started'
      ? 'thinking'
      : event.type === 'turn.complete'
        ? 'complete'
        : event.type === 'turn.aborted'
          ? 'aborted'
          : 'error';
  const summary =
    event.type === 'turn.started'
      ? event.user_text
        ? `考え中: ${event.user_text.slice(0, 80)}`
        : '考え中'
      : event.type === 'turn.complete'
        ? '完了'
        : event.type === 'turn.aborted'
          ? '中断'
          : event.message || 'エラー';
  const at = event.ts * 1000;
  const history = [...(session.activity?.history || []), { state, summary, at }].slice(-12);
  const startedAt = active ? at : session.activity?.startedAt;
  const elapsedSec =
    active || !Number.isFinite(startedAt)
      ? 0
      : Math.max(0, Math.floor((at - (startedAt as number)) / 1000));

  return {
    ...session,
    ...(active
      ? {
          lifecycle: 'open' as const,
          closedAt: undefined,
          closeReason: undefined,
        }
      : {}),
    isActive: active,
    updatedAt: new Date(at).toISOString(),
    activity: {
      ...session.activity,
      state,
      summary,
      active,
      history,
      startedAt,
      updatedAt: at,
      elapsedSec,
    },
  };
}

export function applyActivitySnapshot(
  session: MonitorSession,
  activity: MonitorActivity
): MonitorSession {
  return {
    ...session,
    ...(activity.active
      ? {
          lifecycle: 'open' as const,
          closedAt: undefined,
          closeReason: undefined,
        }
      : {}),
    isActive: activity.active,
    updatedAt: new Date(activity.updatedAt || Date.now()).toISOString(),
    activity,
  };
}

function eventMatchesSession(event: MonitorActivityEvent, session: MonitorSession): boolean {
  const separator = event.thread_id.indexOf(':');
  if (separator < 0) return false;
  const platform = event.thread_id.slice(0, separator);
  const context = event.thread_id.slice(separator + 1);
  return (
    session.platform === platform &&
    (platform === 'web' ? session.id === context : session.contextKey === context)
  );
}

export function revealMonitorDetail(
  element: Pick<HTMLElement, 'getBoundingClientRect' | 'scrollIntoView'>,
  prefersReducedMotion: boolean,
  viewportHeight: number
): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.top >= 0 && rect.bottom <= viewportHeight) return false;
  element.scrollIntoView({
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
    block: 'start',
  });
  return true;
}

export function Monitor() {
  const [sessions, setSessions] = useState<MonitorSession[]>([]);
  const [filter, setFilter] = useState<MonitorFilter>('all');
  const [selectedId, setSelectedId] = useState('');
  const [online, setOnline] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [clock, setClock] = useState(Date.now());
  const [source, setSource] = useState('source --');
  const [closingId, setClosingId] = useState('');
  const [sessionToClose, setSessionToClose] = useState<MonitorSession | null>(null);
  const [actionError, setActionError] = useState('');
  const [accountUsage, setAccountUsage] = useState<AccountUsageResponse>();
  const [hiddenUsageProviders, setHiddenUsageProviders] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(USAGE_VISIBILITY_KEY) || '[]') as string[];
    } catch {
      return [];
    }
  });
  const sessionsRef = useRef<MonitorSession[]>([]);
  const loadSequenceRef = useRef(0);
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!selectedId) return;
    const frame = window.requestAnimationFrame(() => {
      const detail = detailRef.current;
      if (!detail) return;
      revealMonitorDetail(
        detail,
        window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        window.innerHeight
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/usage', { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as AccountUsageResponse;
        if (!cancelled) setAccountUsage(data);
      } catch {
        // Session monitoring remains useful when a provider usage probe is unavailable.
      }
    };
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const applySnapshot = useCallback((data: MonitorSessionsResponse) => {
    const nextSessions = (data.sessions || []).filter(isMonitorVisible);
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    setSelectedId((current) =>
      current && nextSessions.some((session) => session.id === current) ? current : ''
    );
    if (data.meta) {
      setSource(`process ${data.meta.processCwd || '-'} / data ${data.meta.workdir || '-'}`);
    }
    setUpdatedAt(Date.now());
    setOnline(true);
  }, []);

  const loadSessions = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    const loadLifecycle = async (lifecycle: 'open' | 'closed') => {
      const collected: MonitorSession[] = [];
      let offset = 0;
      while (true) {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
          lifecycle,
        });
        if (lifecycle === 'closed') {
          params.set('updatedSince', new Date(Date.now() - RECENT_MS).toISOString());
        }
        const response = await fetch(`/api/sessions?${params}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as MonitorSessionsResponse;
        collected.push(...(data.sessions || []));
        if (!data.meta?.hasMore) return { sessions: collected, meta: data.meta };
        offset = data.meta.nextOffset ?? collected.length;
      }
    };
    const [open, closed] = await Promise.all([loadLifecycle('open'), loadLifecycle('closed')]);
    if (sequence === loadSequenceRef.current) {
      applySnapshot({
        sessions: [...open.sessions, ...closed.sessions],
        meta: {
          ...open.meta,
          total: open.sessions.length + closed.sessions.length,
          limit: open.sessions.length + closed.sessions.length,
        },
      });
    }
  }, [applySnapshot]);

  const closeSelectedSession = useCallback(async () => {
    const session = sessionToClose;
    if (!session || closingId) return;
    setClosingId(session.id);
    setActionError('');
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/close`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadSessions();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSessionToClose(null);
      setClosingId('');
    }
  }, [closingId, loadSessions, sessionToClose]);

  const hasRunningSession = sessions.some(isRunning);
  useEffect(() => {
    const interval = window.setInterval(
      () => setClock(Date.now()),
      hasRunningSession ? 1000 : 60_000
    );
    return () => window.clearInterval(interval);
  }, [hasRunningSession]);

  useEffect(() => {
    loadSessions().catch(() => setOnline(false));

    const eventSource = new EventSource('/api/sessions/stream');
    eventSource.onopen = () => setOnline(true);
    eventSource.onerror = () => setOnline(false);
    eventSource.addEventListener('sessions', (rawEvent) => {
      try {
        JSON.parse((rawEvent as MessageEvent<string>).data);
        void loadSessions().catch(() => setOnline(false));
      } catch {
        setOnline(false);
      }
    });
    eventSource.addEventListener('activity', (rawEvent) => {
      try {
        const event = JSON.parse((rawEvent as MessageEvent<string>).data) as MonitorActivityEvent;
        const matched = sessionsRef.current.some((session) => eventMatchesSession(event, session));
        if (matched) {
          const updatedSessions = sessionsRef.current
            .map((session) =>
              eventMatchesSession(event, session) ? activityFromEvent(session, event) : session
            )
            .filter(isMonitorVisible);
          sessionsRef.current = updatedSessions;
          setSessions(updatedSessions);
        }
        setUpdatedAt(Date.now());
        setOnline(true);
        if (!matched || event.type !== 'turn.started') {
          loadSessions().catch(() => setOnline(false));
        }
      } catch {
        setOnline(false);
      }
    });
    eventSource.addEventListener('activity_snapshot', (rawEvent) => {
      try {
        const data = JSON.parse((rawEvent as MessageEvent<string>).data) as {
          threadId: string;
          activity: MonitorActivity;
        };
        const separator = data.threadId.indexOf(':');
        const platform = data.threadId.slice(0, separator);
        const context = data.threadId.slice(separator + 1);
        let matched = false;
        const updatedSessions = sessionsRef.current
          .map((session) => {
            const isMatch =
              session.platform === platform &&
              (platform === 'web' ? session.id === context : session.contextKey === context);
            if (isMatch) matched = true;
            return isMatch ? applyActivitySnapshot(session, data.activity) : session;
          })
          .filter(isMonitorVisible);
        sessionsRef.current = updatedSessions;
        setSessions(updatedSessions);
        setUpdatedAt(Date.now());
        setOnline(true);
        if (!matched || !data.activity.active) {
          void loadSessions().catch(() => setOnline(false));
        }
      } catch {
        setOnline(false);
      }
    });

    return () => eventSource.close();
  }, [applySnapshot, loadSessions]);

  const filteredSessions = useMemo(
    () => sessions.filter((session) => matchesFilter(session, filter)),
    [filter, sessions]
  );

  const visibleSessions = useMemo(
    () =>
      [...filteredSessions]
        .sort(
          (a, b) =>
            Number(isRunning(b)) - Number(isRunning(a)) ||
            String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
        )
        .filter((session) => monitorLane(session) !== 'completed' || isRecent(session, clock)),
    [clock, filteredSessions]
  );

  const sessionsByLane = useMemo(
    () =>
      Object.fromEntries(
        LANES.map((lane) => [
          lane.value,
          visibleSessions.filter((session) => monitorLane(session) === lane.value),
        ])
      ) as Record<MonitorLane, MonitorSession[]>,
    [visibleSessions]
  );

  const selected = sessions.find((session) => session.id === selectedId);
  const runningCount = sessionsByLane.running.length;
  const waitingCount = sessionsByLane.waiting.length;
  const completedCount = sessionsByLane.completed.length;
  const usageProviders = displayUsageProviders(accountUsage?.providers || []);
  const visibleUsageProviders = usageProviders.filter(
    (provider) => !hiddenUsageProviders.includes(provider.id)
  );
  const setProviderHidden = (providerId: string, hidden: boolean) => {
    setHiddenUsageProviders((current) => {
      const next = hidden
        ? [...new Set([...current, providerId])]
        : current.filter((id) => id !== providerId);
      localStorage.setItem(USAGE_VISIBILITY_KEY, JSON.stringify(next));
      return next;
    });
  };

  return (
    <main className="monitor-page">
      <AppTopbar current="monitor" />
      <header className="monitor-header">
        <div className="monitor-header-primary">
          <h1>Monitor</h1>
        </div>
        <div className="monitor-header-meta">
          <span className="monitor-pill monitor-updated">
            {updatedAt ? new Date(updatedAt).toLocaleTimeString() : '--'}
          </span>
          <span className={`monitor-pill monitor-status ${online ? 'online' : 'offline'}`}>
            {online
              ? `online ${visibleSessions.length}/${filteredSessions.length} shown`
              : 'offline'}
          </span>
          <span className="monitor-pill monitor-source">{source}</span>
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {online ? 'Monitor online' : 'Monitor offline'}
        </span>
      </header>

      <nav className="monitor-toolbar" aria-label="filters">
        <span className="monitor-toolbar-label">表示</span>
        {FILTERS.map((item) => (
          <button
            type="button"
            className={`monitor-filter ${filter === item.value ? 'active' : ''}`}
            aria-pressed={filter === item.value}
            data-filter={item.value}
            key={item.value}
            onClick={() => setFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <section className="monitor-content">
        {usageProviders.length > 0 && (
          <section className="monitor-usage" aria-label="AI利用量">
            <header className="monitor-usage-header">
              <div>
                <h2>AI利用量</h2>
                <p>アカウント枠は60秒ごと、コンテキストはturn完了時に更新</p>
              </div>
              {hiddenUsageProviders
                .filter((providerId) =>
                  usageProviders.some((provider) => provider.id === providerId)
                )
                .map((providerId) => (
                  <button
                    key={providerId}
                    type="button"
                    onClick={() => setProviderHidden(providerId, false)}
                  >
                    {usageProviders.find((provider) => provider.id === providerId)?.label ||
                      providerId}
                    を表示
                  </button>
                ))}
            </header>
            <div className="monitor-usage-providers">
              {visibleUsageProviders.map((provider) => (
                <details className="monitor-usage-provider" open key={provider.id}>
                  <summary>
                    <strong>{provider.label}</strong>
                    <span>{accountUsage?.stale ? '前回値' : '最新'}</span>
                  </summary>
                  <button
                    className="monitor-usage-hide"
                    type="button"
                    onClick={() => setProviderHidden(provider.id, true)}
                  >
                    非表示
                  </button>
                  {provider.groups.map((group) => {
                    const presentation = usageGroupPresentation(group);
                    return (
                      <section className="monitor-usage-group" key={group.id}>
                        <h3>{presentation.title}</h3>
                        {presentation.description && <p>{presentation.description}</p>}
                        {group.windows.map((window) => {
                          const pace = usagePacePercent(window, clock);
                          return (
                            <div
                              className="monitor-usage-window"
                              key={`${group.id}-${window.label}`}
                            >
                              <div>
                                <span>{window.label}</span>
                                <strong>
                                  {Math.round(window.usedPercent)}%
                                  {pace !== undefined && (
                                    <span className="monitor-usage-pace">
                                      {' '}
                                      / 目安 {Math.round(pace)}%
                                    </span>
                                  )}
                                </strong>
                              </div>
                              <div
                                className="monitor-usage-chart"
                                role="progressbar"
                                aria-label={`${window.label}の使用率 ${Math.round(window.usedPercent)}%${pace === undefined ? '' : `、時間経過の目安 ${Math.round(pace)}%`}`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(window.usedPercent)}
                              >
                                <span
                                  className="monitor-usage-actual"
                                  style={{
                                    width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
                                  }}
                                />
                                {pace !== undefined && (
                                  <span
                                    className="monitor-usage-target"
                                    style={{ left: `${pace}%` }}
                                    title={`時間経過の目安 ${Math.round(pace)}%`}
                                  />
                                )}
                              </div>
                              {window.resetsAt && (
                                <small>
                                  {new Date(window.resetsAt * 1000).toLocaleString()} リセット
                                </small>
                              )}
                            </div>
                          );
                        })}
                      </section>
                    );
                  })}
                </details>
              ))}
            </div>
          </section>
        )}

        <section className="monitor-summary" aria-label="summary">
          <div className="monitor-metric">
            <div className="monitor-metric-value">{runningCount}</div>
            <div className="monitor-metric-label">実行中</div>
          </div>
          <div className="monitor-metric">
            <div className="monitor-metric-value">{waitingCount}</div>
            <div className="monitor-metric-label">入力待ち</div>
          </div>
          <div className="monitor-metric">
            <div className="monitor-metric-value">{completedCount}</div>
            <div className="monitor-metric-label">完了（24時間）</div>
          </div>
        </section>

        <section className="monitor-legend" aria-label="legend">
          <span>状態に応じてカードを自動分類</span>
          <span>内部イベント保存: logs/monitor-activity</span>
          <span>カードをタップして詳細を表示</span>
        </section>

        {actionError && (
          <p className="monitor-action-error" role="alert">
            完了への変更に失敗しました: {actionError}
          </p>
        )}

        {selected && (
          <section className="monitor-detail-region" aria-label="selected session" ref={detailRef}>
            <article className="monitor-detail">
              <div className="monitor-detail-head">
                <div className="monitor-detail-heading">
                  <h2 className="monitor-detail-title">{selected.title || selected.id}</h2>
                  <p className="monitor-detail-subtitle">
                    {stateLabel(selected)} - {stateDescription(selected)}
                  </p>
                </div>
                <div className="monitor-detail-actions">
                  <a className="monitor-detail-open" href={sessionPath(selected.id)}>
                    会話を開く
                  </a>
                  {monitorLane(selected) !== 'completed' && (
                    <button
                      type="button"
                      className="monitor-detail-session-close"
                      disabled={closingId === selected.id}
                      onClick={() => setSessionToClose(selected)}
                    >
                      {closingId === selected.id ? '変更中…' : '完了にする'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="monitor-detail-close"
                    onClick={() => setSelectedId('')}
                  >
                    詳細を閉じる
                  </button>
                </div>
              </div>

              <dl className="monitor-detail-grid">
                {[
                  ['state', '状態', stateLabel(selected)],
                  ['destination', '会話先', conversationLabel(selected)],
                  ['updated', '更新', formatAge(selected.updatedAt || selected.createdAt, clock)],
                  ['turns', '完了ターン数', String(selected.messageCount || 0)],
                  [
                    'context',
                    'コンテキスト',
                    selected.contextUsage
                      ? `${selected.contextUsage.usedTokens.toLocaleString()} / ${selected.contextUsage.contextWindow.toLocaleString()} (${Math.round((selected.contextUsage.usedTokens / selected.contextUsage.contextWindow) * 100)}%)`
                      : '未取得',
                  ],
                  ...(typeof selected.estimatedCost?.value === 'number'
                    ? [
                        [
                          'estimated-cost',
                          '推定利用料',
                          formatEstimatedCost(selected.estimatedCost.value),
                        ],
                      ]
                    : []),
                ].map(([key, label, value]) => (
                  <div className={`monitor-detail-kv monitor-detail-kv-${key}`} key={key}>
                    <dt>{label}</dt>
                    <dd className="monitor-detail-value">{value}</dd>
                  </div>
                ))}
              </dl>

              <section className="monitor-runtime" aria-label="実行設定">
                <h3>このセッションの実行設定</h3>
                <dl>
                  <div>
                    <dt>バックエンド</dt>
                    <dd>{selected.backend?.backend || '-'}</dd>
                  </div>
                  <div>
                    <dt>モデル</dt>
                    <dd>{selected.backend ? selected.backend.model || 'デフォルト' : '-'}</dd>
                  </div>
                  <div>
                    <dt>effort</dt>
                    <dd>{selected.backend?.effort || '-'}</dd>
                  </div>
                </dl>
              </section>

              <details className="monitor-technical-details">
                <summary>内部ID</summary>
                <dl>
                  {[
                    ['conversation key', selected.contextKey || '-'],
                    ['channel ID', selected.origin?.channelId || '-'],
                    ['thread ID', selected.origin?.threadId || '-'],
                    ['session ID', selected.id],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd className="mono">{value}</dd>
                    </div>
                  ))}
                </dl>
              </details>

              <div className="monitor-events">
                {selected.activity?.history?.length ? (
                  selected.activity.history.slice(-8).map((event, index) => (
                    <div className="monitor-event" key={`${event.at}-${index}`}>
                      <time>{formatTime(event.at)}</time>
                      <span>{event.summary}</span>
                    </div>
                  ))
                ) : (
                  <div className="monitor-event">
                    <span>状態</span>
                    <span>{sessionLine(selected)}</span>
                  </div>
                )}
              </div>
            </article>
          </section>
        )}

        <section className="monitor-board" aria-label="sessions">
          {LANES.map((lane) => {
            const laneSessions = sessionsByLane[lane.value];
            const column = (
              <section
                className={`monitor-column monitor-column-${lane.value}`}
                aria-labelledby={`monitor-column-${lane.value}`}
                key={lane.value}
              >
                <header className="monitor-column-header">
                  <div className="monitor-column-title-row">
                    <span className={`monitor-column-dot ${lane.value}`} aria-hidden="true" />
                    <h2 id={`monitor-column-${lane.value}`}>{lane.label}</h2>
                    <span className="monitor-column-count">{laneSessions.length}</span>
                  </div>
                  <p>{lane.description}</p>
                </header>
                <div className="monitor-column-list">
                  {laneSessions.length === 0 ? (
                    <div className="monitor-column-empty">該当するセッションはありません</div>
                  ) : (
                    laneSessions.map((session) => {
                      const running = isRunning(session);
                      const activityState = session.activity?.state;
                      const hasError = activityState === 'error';
                      const wasAborted = activityState === 'aborted';
                      const selectedRow = session.id === selectedId;
                      const elapsed =
                        session.activity?.active && Number.isFinite(session.activity.startedAt)
                          ? ` ${Math.max(
                              0,
                              Math.floor((clock - (session.activity.startedAt as number)) / 1000)
                            )}s`
                          : session.activity?.active && Number.isFinite(session.activity.elapsedSec)
                            ? ` ${session.activity.elapsedSec}s`
                            : '';

                      return (
                        <article
                          className={[
                            'monitor-session-row',
                            'monitor-session-card',
                            running ? 'running' : '',
                            hasError ? 'error' : '',
                            wasAborted ? 'aborted' : '',
                            selectedRow ? 'selected' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          key={session.id}
                        >
                          <button
                            type="button"
                            className="monitor-session-open"
                            aria-label={`${session.title || session.id}の詳細を表示`}
                            aria-expanded={selectedRow}
                            onClick={() => setSelectedId(session.id)}
                          >
                            <span
                              className={[
                                'monitor-state-dot',
                                hasError
                                  ? 'error'
                                  : wasAborted
                                    ? 'aborted'
                                    : running
                                      ? 'running'
                                      : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              aria-hidden="true"
                            />

                            <span className="monitor-session-body">
                              <strong className="monitor-session-title">
                                {session.title || session.id}
                              </strong>
                              <span className="monitor-session-meta">
                                {platformLabel(session.platform)} #{shortId(session.id)}
                                {session.contextKey
                                  ? ` / ${shortId(session.contextKey)}`
                                  : ''} / {formatAge(session.updatedAt || session.createdAt, clock)}
                              </span>
                              <span className="monitor-session-activity">
                                {sessionLine(session)}
                              </span>
                              {!!session.activity?.toolLines?.length && (
                                <span className="monitor-tool-lines">
                                  {session.activity.toolLines.slice(-3).map((line, index) => (
                                    <code className="monitor-tool-line" key={`${line}-${index}`}>
                                      {line}
                                    </code>
                                  ))}
                                </span>
                              )}
                            </span>

                            <span className="monitor-session-right">
                              <span className="monitor-platform">
                                {platformLabel(session.platform)}
                              </span>
                              <span className="monitor-session-state">
                                {stateLabel(session)}
                                {elapsed}
                              </span>
                              <time>
                                {formatAge(session.updatedAt || session.createdAt, clock)}
                              </time>
                            </span>
                          </button>
                        </article>
                      );
                    })
                  )}
                </div>
              </section>
            );
            return column;
          })}
        </section>
      </section>
      <ConfirmDialog
        open={Boolean(sessionToClose)}
        title="セッションを完了"
        description={
          <>
            「{sessionToClose?.title || 'このセッション'}
            」を完了にします。会話履歴は残り、履歴から再開・分岐できます。
          </>
        }
        confirmLabel="完了にする"
        busyLabel="変更中…"
        busy={Boolean(closingId)}
        onCancel={() => {
          if (!closingId) setSessionToClose(null);
        }}
        onConfirm={() => void closeSelectedSession()}
      />
    </main>
  );
}
