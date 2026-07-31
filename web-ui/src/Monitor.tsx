import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppTopbar } from './AppTopbar';

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
  activity?: MonitorActivity;
}

export interface MonitorSessionsResponse {
  sessions?: MonitorSession[];
  meta?: {
    limit?: number;
    total?: number;
    processCwd?: string;
    workdir?: string;
  };
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

type MonitorFilter = 'watch' | 'running' | 'recent' | 'chat' | 'web' | 'all';

const MAX_ROWS = 150;
const WATCH_ROWS = 30;
const RECENT_MS = 24 * 60 * 60 * 1000;

const FILTERS: Array<{ value: MonitorFilter; label: string }> = [
  { value: 'watch', label: '監視中' },
  { value: 'running', label: '実行中' },
  { value: 'recent', label: '最近' },
  { value: 'chat', label: 'Chat' },
  { value: 'web', label: 'Web' },
  { value: 'all', label: 'All' },
];

function isRunning(session: MonitorSession): boolean {
  return session.isActive === true;
}

function isChatPlatform(session: MonitorSession): boolean {
  return session.platform === 'discord' || session.platform === 'slack';
}

function isRecent(session: MonitorSession, now = Date.now()): boolean {
  const updatedAt = Date.parse(session.updatedAt || session.createdAt || '');
  return Number.isFinite(updatedAt) && now - updatedAt < RECENT_MS;
}

function isWatchTarget(session: MonitorSession, now = Date.now()): boolean {
  return isRunning(session) || isRecent(session, now);
}

function matchesFilter(session: MonitorSession, filter: MonitorFilter, now = Date.now()): boolean {
  if (filter === 'watch') return isWatchTarget(session, now);
  if (filter === 'running') return isRunning(session);
  if (filter === 'recent') return isRecent(session, now);
  if (filter === 'chat') return isChatPlatform(session);
  if (filter === 'web') return session.platform === 'web';
  return true;
}

function platformLabel(platform?: string): string {
  if (platform === 'discord') return 'D';
  if (platform === 'slack') return 'S';
  if (platform === 'web') return 'W';
  return (platform || '?').slice(0, 1);
}

function stateLabel(session: MonitorSession): string {
  if (!isRunning(session)) return '履歴';
  if (session.activity?.state === 'tool') return 'tool実行中';
  if (session.activity?.state === 'streaming') return '応答中';
  if (session.activity?.state === 'thinking') return '考え中';
  return session.activity?.state || '実行中';
}

function stateDescription(session: MonitorSession): string {
  return isRunning(session) ? '今このターンが動いている' : '過去の会話ログ。現在の処理はない';
}

function sessionLine(session: MonitorSession): string {
  return session.activity?.summary || '履歴: 現在の処理なし';
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

function activityFromEvent(session: MonitorSession, event: MonitorActivityEvent): MonitorSession {
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

export function Monitor() {
  const [sessions, setSessions] = useState<MonitorSession[]>([]);
  const [filter, setFilter] = useState<MonitorFilter>('watch');
  const [selectedId, setSelectedId] = useState('');
  const [online, setOnline] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [clock, setClock] = useState(Date.now());
  const [source, setSource] = useState('source --');
  const sessionsRef = useRef<MonitorSession[]>([]);
  const loadSequenceRef = useRef(0);

  const applySnapshot = useCallback((data: MonitorSessionsResponse) => {
    const nextSessions = data.sessions || [];
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
    const response = await fetch(`/api/sessions?limit=${MAX_ROWS}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as MonitorSessionsResponse;
    if (sequence === loadSequenceRef.current) applySnapshot(data);
  }, [applySnapshot]);

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
        const data = JSON.parse((rawEvent as MessageEvent<string>).data) as MonitorSessionsResponse;
        const snapshotCount = data.sessions?.length || 0;
        const total = data.meta?.total;
        if (
          (data.meta?.limit || 0) >= MAX_ROWS ||
          (typeof total === 'number' && total <= snapshotCount)
        ) {
          applySnapshot(data);
        } else {
          void loadSessions().catch(() => setOnline(false));
        }
      } catch {
        setOnline(false);
      }
    });
    eventSource.addEventListener('activity', (rawEvent) => {
      try {
        const event = JSON.parse((rawEvent as MessageEvent<string>).data) as MonitorActivityEvent;
        const matched = sessionsRef.current.some((session) => eventMatchesSession(event, session));
        if (matched) {
          const updatedSessions = sessionsRef.current.map((session) =>
            eventMatchesSession(event, session) ? activityFromEvent(session, event) : session
          );
          sessionsRef.current = updatedSessions;
          setSessions(updatedSessions);
        }
        setUpdatedAt(Date.now());
        setOnline(true);
        if (!matched) loadSessions().catch(() => setOnline(false));
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
        const updatedSessions = sessionsRef.current.map((session) => {
          const isMatch =
            session.platform === platform &&
            (platform === 'web' ? session.id === context : session.contextKey === context);
          if (isMatch) matched = true;
          return isMatch
            ? {
                ...session,
                isActive: data.activity.active,
                updatedAt: new Date(data.activity.updatedAt || Date.now()).toISOString(),
                activity: data.activity,
              }
            : session;
        });
        sessionsRef.current = updatedSessions;
        setSessions(updatedSessions);
        setUpdatedAt(Date.now());
        setOnline(true);
        if (!matched) void loadSessions().catch(() => setOnline(false));
      } catch {
        setOnline(false);
      }
    });

    return () => eventSource.close();
  }, [applySnapshot, loadSessions]);

  const filteredSessions = useMemo(
    () => sessions.filter((session) => matchesFilter(session, filter, clock)),
    [clock, filter, sessions]
  );

  const visibleSessions = useMemo(
    () =>
      [...filteredSessions]
        .sort(
          (a, b) =>
            Number(isRunning(b)) - Number(isRunning(a)) ||
            String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
        )
        .slice(0, filter === 'watch' ? WATCH_ROWS : MAX_ROWS),
    [filter, filteredSessions]
  );

  const selected = sessions.find((session) => session.id === selectedId);
  const runningCount = sessions.filter(isRunning).length;
  const recentCount = sessions.filter((session) => isRecent(session, clock)).length;

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
        <section className="monitor-summary" aria-label="summary">
          <div className="monitor-metric">
            <div className="monitor-metric-value">{runningCount}</div>
            <div className="monitor-metric-label">実行中ターン</div>
          </div>
          <div className="monitor-metric">
            <div className="monitor-metric-value">{recentCount}</div>
            <div className="monitor-metric-label">24時間以内の更新</div>
          </div>
          <div className="monitor-metric">
            <div className="monitor-metric-value">{visibleSessions.length}</div>
            <div className="monitor-metric-label">表示中</div>
          </div>
        </section>

        <section className="monitor-legend" aria-label="legend">
          <span>実行中: 返答・tool実行中</span>
          <span>履歴: 過去ログ</span>
          <span>監視中: 実行中/直近履歴</span>
          <span>内部イベント保存: logs/monitor-activity</span>
          <span>行をタップで詳細</span>
        </section>

        {selected && (
          <section className="monitor-detail-region" aria-label="selected session">
            <article className="monitor-detail">
              <div className="monitor-detail-head">
                <div className="monitor-detail-heading">
                  <h2 className="monitor-detail-title">{selected.title || selected.id}</h2>
                  <p className="monitor-detail-subtitle">
                    {stateLabel(selected)} - {stateDescription(selected)}
                  </p>
                </div>
                <button
                  type="button"
                  className="monitor-detail-close"
                  onClick={() => setSelectedId('')}
                >
                  閉じる
                </button>
              </div>

              <dl className="monitor-detail-grid">
                {[
                  ['状態', stateLabel(selected)],
                  ['platform', selected.platform || '-'],
                  ['updated', formatAge(selected.updatedAt || selected.createdAt, clock)],
                  ['messages', String(selected.messageCount || 0)],
                  ['session id', selected.id],
                  ['context', selected.contextKey || '-'],
                ].map(([label, value]) => (
                  <div className="monitor-detail-kv" key={label}>
                    <dt>{label}</dt>
                    <dd
                      className={
                        label.includes('id') || label === 'context'
                          ? 'monitor-detail-value mono'
                          : 'monitor-detail-value'
                      }
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

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

        <section className="monitor-sessions" aria-label="sessions">
          {visibleSessions.length === 0 ? (
            <div className="monitor-empty">
              {filter === 'watch' ? '実行中または最近のセッションはありません' : 'No sessions'}
            </div>
          ) : (
            visibleSessions.map((session) => {
              const running = isRunning(session);
              const errored = session.activity?.state === 'error';
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
                <button
                  type="button"
                  className={[
                    'monitor-session-row',
                    running ? 'running' : '',
                    errored ? 'error' : '',
                    selectedRow ? 'selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-expanded={selectedRow}
                  key={session.id}
                  onClick={() =>
                    setSelectedId((current) => (current === session.id ? '' : session.id))
                  }
                >
                  <span
                    className={['monitor-state-dot', errored ? 'error' : running ? 'running' : '']
                      .filter(Boolean)
                      .join(' ')}
                    aria-hidden="true"
                  />

                  <span className="monitor-session-body">
                    <strong className="monitor-session-title">{session.title || session.id}</strong>
                    <span className="monitor-session-meta">
                      {platformLabel(session.platform)} #{shortId(session.id)}
                      {session.contextKey ? ` / ${shortId(session.contextKey)}` : ''} /{' '}
                      {formatAge(session.updatedAt || session.createdAt, clock)}
                    </span>
                    <span className="monitor-session-activity">{sessionLine(session)}</span>
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
                    <span className="monitor-platform">{platformLabel(session.platform)}</span>
                    <span className="monitor-session-state">
                      {stateLabel(session)}
                      {elapsed}
                    </span>
                    <time>{formatAge(session.updatedAt || session.createdAt, clock)}</time>
                  </span>
                </button>
              );
            })
          )}
        </section>
      </section>
    </main>
  );
}
