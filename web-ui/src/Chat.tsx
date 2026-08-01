import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { requestJson } from './api';
import { AppTopbar } from './AppTopbar';
import {
  applyPublishedLiveEvent,
  liveThreadId,
  selectLiveTurn,
  syncObservedLiveTurn,
  type LiveActivity,
  type ObservedLiveTurn,
  type PublishedLiveEvent,
} from './liveTurn';
import { MessageContent, copyText } from './MessageContent';
import { shouldShowAutoTalk } from './sessionList';
import { associateToolHistory } from './toolHistory';
import type { RuntimeConfig as Config, ToolHistoryEntry, ToolHistoryResponse } from './types';

const MAX_PANES = 8;
const PANE_STATE_KEY = 'xangi_pane_state_v1';
const PROJECT_STATE_KEY = 'xangi_active_project_v1';
const SIDEBAR_COLLAPSED_KEY = 'xangi_sidebar_collapsed_v1';
const AUTO_TALK_SENTINEL = '[__XANGI_AUTOTALK_INTERNAL__]';

interface Activity extends LiveActivity {
  toolLines?: string[];
  history?: Array<{ state: string; summary: string; at: number }>;
  startedAt?: number;
  updatedAt?: number;
  elapsedSec?: number;
}

interface Session {
  id: string;
  title: string;
  platform: string;
  contextKey: string;
  createdAt?: string;
  updatedAt: string;
  messageCount?: number;
  isActive: boolean;
  autoTalk?: boolean;
  autoTalkActive?: boolean;
  timeoutAt?: number;
  maxTimeoutAt?: number;
  timeoutMs?: number;
  activity?: Activity;
  projectId?: string;
}

interface Project {
  id: string;
  name: string;
  prompt: string;
}

interface ProjectsResponse {
  projects: Project[];
}

interface Usage {
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
}

interface Message {
  id?: string;
  role: string;
  content: string;
  createdAt?: string;
  edited?: boolean;
  usage?: Usage;
  replySuggestions?: string[];
  attachments?: string[];
  platformMessageId?: string;
}

interface SessionDetail {
  id: string;
  title: string;
  platform?: string;
  messages: Message[];
  hasMore?: boolean;
  nextBefore?: number;
  nextCursor?: number | null;
}

interface SessionsResponse {
  sessions: Session[];
  meta?: {
    limit?: number;
    total?: number;
    hasMore?: boolean;
    nextOffset?: number;
    nextCursor?: string | null;
    workdir?: string;
  };
}

interface CommandChoice {
  name: string;
  value: string;
  description?: string;
}

interface CommandOption {
  name: string;
  description: string;
  type: 'subcommand' | 'string';
  required?: boolean;
  choices?: CommandChoice[];
  options?: CommandOption[];
}

interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  options?: CommandOption[];
}

interface PaletteOption {
  name: string;
  description?: string;
  hint?: string;
  usage: string;
}

interface PendingFile {
  name: string;
  path: string;
  localUrl?: string;
}

function formatToolSummary(tool: ToolHistoryEntry): string {
  const summary = tool.summary.replace(/^実行中:\s*/, '');
  const prefix = `${tool.toolName}: `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

interface PaneDescriptor {
  key: string;
  sessionId: string | null;
}

interface TimeoutState {
  timeoutAt?: number;
  maxTimeoutAt?: number;
  timeoutMs?: number;
}

let paneSequence = 0;

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function platformLabel(platform?: string): string {
  if (platform === 'web') return 'Web';
  if (platform === 'discord') return 'Discord';
  if (platform === 'slack') return 'Slack';
  return platform || 'Log';
}

function relativeTime(value?: string): string {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return '今';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  return `${Math.floor(seconds / 86400)}日前`;
}

function dateGroup(value?: string): string {
  if (!value) return '以前';
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今日';
  if (date.toDateString() === yesterday.toDateString()) return '昨日';
  return date.toLocaleDateString('ja-JP');
}

function displayTime(value?: string): string {
  if (!value) return '';
  return new Date(value).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRemaining(timeoutAt?: number): string {
  if (!timeoutAt) return '';
  const seconds = Math.max(0, Math.ceil((timeoutAt - Date.now()) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(
    2,
    '0'
  )}`;
}

function isMobile(): boolean {
  return (
    window.matchMedia?.('(max-width: 768px), (max-height: 500px) and (hover: none)').matches ??
    false
  );
}

function restorePanes(): { panes: PaneDescriptor[]; activeKey: string } {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANE_STATE_KEY) || '{}') as {
      sessions?: Array<string | null>;
      activeIndex?: number;
      ids?: Array<string | null>;
      activeIdx?: number;
    };
    // `ids` / `activeIdx` は旧Web UIが同じstorage keyへ保存していた形式。
    // 初回React表示で既存のペイン配置を失わないよう、その場で移行する。
    const sessions = (parsed.sessions || parsed.ids)?.slice(0, MAX_PANES);
    if (sessions?.length) {
      const panes = sessions.map((sessionId) => ({
        key: `pane-${++paneSequence}`,
        sessionId,
      }));
      const savedActiveIndex = parsed.activeIndex ?? parsed.activeIdx ?? 0;
      return {
        panes,
        activeKey: panes[Math.min(Math.max(0, savedActiveIndex), panes.length - 1)].key,
      };
    }
  } catch {
    // Corrupt storage intentionally falls back to an empty pane.
  }
  const pane = { key: `pane-${++paneSequence}`, sessionId: null };
  return { panes: [pane], activeKey: pane.key };
}

function useCommandPalette(
  value: string,
  commands: CommandDefinition[]
): { title: string; options: PaletteOption[]; emptyText?: string; done?: boolean } {
  return useMemo(() => {
    if (!value.startsWith('/')) return { title: '', options: [], done: true };
    const trailingSpace = /\s$/.test(value);
    const parts = value.trim().split(/\s+/);
    const commandQuery = (parts.shift() || '').replace(/^\//, '').toLowerCase();
    const command = commands.find((candidate) => candidate.name.toLowerCase() === commandQuery);
    if (!command || (parts.length === 0 && !trailingSpace)) {
      return {
        title: 'コマンドを選択',
        options: commands
          .filter(
            (candidate) =>
              !commandQuery ||
              candidate.name.toLowerCase().includes(commandQuery) ||
              candidate.description.toLowerCase().includes(commandQuery)
          )
          .map((candidate) => ({
            name: `/${candidate.name}`,
            description: candidate.description,
            hint: candidate.usage,
            usage: `/${candidate.name} `,
          })),
      };
    }

    let prefix = `/${command.name}`;
    let options = command.options || [];
    const remaining = [...parts];
    while (options.length > 0) {
      const subcommands = options.filter((option) => option.type === 'subcommand');
      if (subcommands.length > 0) {
        const query = remaining[0] || '';
        const selected = subcommands.find(
          (option) => option.name.toLowerCase() === query.toLowerCase()
        );
        if (!selected || (remaining.length === 1 && !trailingSpace)) {
          return {
            title: `${command.name} の操作を選択`,
            options: subcommands
              .filter(
                (option) =>
                  !query ||
                  option.name.toLowerCase().includes(query.toLowerCase()) ||
                  option.description.toLowerCase().includes(query.toLowerCase())
              )
              .map((option) => ({
                name: option.name,
                description: option.description,
                hint: option.name,
                usage: `${prefix} ${option.name} `,
              })),
          };
        }
        prefix += ` ${selected.name}`;
        remaining.shift();
        options = selected.options || [];
        if (options.length === 0) return { title: '', options: [], done: true };
        continue;
      }
      const option = options[0];
      const query = remaining[0] || '';
      if (option.choices?.length) {
        const choice = option.choices.find(
          (candidate) => candidate.value.toLowerCase() === query.toLowerCase()
        );
        if (!choice || (remaining.length === 1 && !trailingSpace)) {
          return {
            title: option.description,
            options: option.choices
              .filter(
                (candidate) =>
                  !query ||
                  candidate.value.toLowerCase().includes(query.toLowerCase()) ||
                  candidate.name.toLowerCase().includes(query.toLowerCase())
              )
              .map((candidate) => ({
                name: candidate.name,
                description: candidate.description || option.description,
                hint: candidate.value,
                usage: `${prefix} ${candidate.value} `,
              })),
          };
        }
        prefix += ` ${choice.value}`;
        remaining.shift();
        options = options.slice(1);
        if (options.length === 0) return { title: '', options: [], done: true };
        continue;
      }
      if (!query) {
        return {
          title: option.description,
          options: [],
          emptyText: option.required
            ? `${option.description}を入力してください`
            : `必要なら${option.description}を入力。省略して送信できます`,
        };
      }
      return { title: '', options: [], done: true };
    }
    return { title: '', options: [], done: true };
  }, [commands, value]);
}

function CommandPalette({
  sessionId,
  value,
  open,
  onChange,
  onClose,
  onExecute,
}: {
  sessionId: string | null;
  value: string;
  open: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onExecute: (input: string) => Promise<void>;
}) {
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const state = useCommandPalette(value, commands);

  const runCommand = useCallback(async () => {
    if (running || !value.trim()) return;
    setRunning(true);
    setError('');
    try {
      await onExecute(value.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }, [onExecute, running, value]);

  useEffect(() => {
    if (!open) return;
    requestJson<{ commands: CommandDefinition[] }>(
      `/api/web-commands${sessionId ? `?appSessionId=${encodeURIComponent(sessionId)}` : ''}`
    )
      .then((data) => setCommands(data.commands))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [open, sessionId]);

  useEffect(() => setActive(0), [state.title, value]);
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown' && state.options.length) {
        event.preventDefault();
        setActive((current) => (current + 1) % state.options.length);
        return;
      }
      if (event.key === 'ArrowUp' && state.options.length) {
        event.preventDefault();
        setActive((current) => (current - 1 + state.options.length) % state.options.length);
        return;
      }
      if ((event.key === 'Tab' || event.key === 'Enter') && state.options[active]) {
        event.preventDefault();
        onChange(state.options[active].usage);
        return;
      }
      if (event.key === 'Enter' && state.done && value.trim().length > 1) {
        event.preventDefault();
        void runCommand();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [active, onChange, onClose, open, runCommand, state.done, state.options, value]);
  if (!open) return null;

  return (
    <div className="command-popover">
      <div
        className="command-palette"
        role="listbox"
        aria-label={state.title || 'コマンド候補'}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'ArrowDown' && state.options.length) {
            setActive((current) => (current + 1) % state.options.length);
          }
          if (event.key === 'ArrowUp' && state.options.length) {
            setActive((current) => (current - 1 + state.options.length) % state.options.length);
          }
        }}
      >
        <p>{state.title || 'コマンドを実行'}</p>
        {state.options.map((option, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            className={index === active ? 'command-option active' : 'command-option'}
            key={`${option.usage}-${index}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => onChange(option.usage)}
          >
            <span>{option.name}</span>
            <small>{option.description}</small>
            <code>{option.hint}</code>
          </button>
        ))}
        {state.options.length === 0 && !state.done && (
          <div className="command-empty">{state.emptyText || '一致する候補がありません'}</div>
        )}
        {state.done && value.trim().length > 1 && (
          <button type="button" className="command-run" disabled={running} onClick={runCommand}>
            {running ? '実行中…' : `${value.trim()} を実行`}
          </button>
        )}
      </div>
      {error && <div className="command-error">{error}</div>}
    </div>
  );
}

function MessageView({
  message,
  tools,
  sessionId,
  mutable,
  suggestionsEnabled,
  onReload,
  onSuggestion,
}: {
  message: Message;
  tools: ToolHistoryEntry[];
  sessionId: string;
  mutable: boolean;
  suggestionsEnabled: boolean;
  onReload: () => Promise<void>;
  onSuggestion: (suggestion: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionsUsed, setSuggestionsUsed] = useState(false);
  const usage = message.usage;
  const usageText = [
    usage?.num_turns ? `${usage.num_turns}ターン` : '',
    usage?.duration_ms ? `${(usage.duration_ms / 1000).toFixed(1)}秒` : '',
    typeof usage?.total_cost_usd === 'number' ? `$${usage.total_cost_usd.toFixed(4)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  useEffect(() => {
    if (!editing) setEditValue(message.content);
  }, [editing, message.content]);

  async function saveEdit() {
    if (!message.id) return;
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages/${message.id}`, {
        ...jsonInit('PATCH', { content: editValue }),
      });
      setEditing(false);
      await onReload();
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function deleteMessage() {
    if (
      !message.id ||
      !window.confirm('このメッセージを削除しますか？履歴ファイルを書き換えます。')
    ) {
      return;
    }
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages/${message.id}`, {
        method: 'DELETE',
      });
      await onReload();
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <article className={`message ${message.role}`}>
      <header>
        <span>{message.role === 'user' ? 'あなた' : 'xangi'}</span>
        <time>{displayTime(message.createdAt)}</time>
        {message.edited && <em>編集済み</em>}
        {usageText && <small>{usageText}</small>}
      </header>
      {message.role === 'assistant' && tools.length > 0 && (
        <details className="message-tools">
          <summary>
            <span>使用したツール</span>
            <small>
              {tools.length}件 · <span className="tools-show-label">表示</span>
              <span className="tools-hide-label">隠す</span>
            </small>
          </summary>
          <ol>
            {tools.map((tool, index) => (
              <li key={`${tool.turnId}-${tool.at}-${index}`}>
                <div>
                  <strong>{tool.toolName}</strong>
                  <time dateTime={new Date(tool.at).toISOString()}>
                    {new Date(tool.at).toLocaleTimeString('ja-JP', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </time>
                </div>
                <code>{formatToolSummary(tool)}</code>
                {tool.inputPreview && (
                  <details>
                    <summary>入力の詳細</summary>
                    <code>{tool.inputPreview}</code>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      {editing ? (
        <div className="message-editor">
          <textarea value={editValue} onChange={(event) => setEditValue(event.target.value)} />
          <button type="button" onClick={() => void saveEdit()}>
            保存
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            キャンセル
          </button>
        </div>
      ) : (
        <>
          <MessageContent content={message.content} markdown={message.role === 'assistant'} />
          {message.attachments?.length ? (
            <div className="message-attachments">
              {message.attachments.map((path) => (
                <MessageContent key={path} content={`MEDIA:${path}`} markdown />
              ))}
            </div>
          ) : null}
        </>
      )}
      <div className="message-actions">
        <button type="button" onClick={() => void copyText(message.content)}>
          コピー
        </button>
        {mutable && message.role === 'user' && message.id && (
          <button type="button" onClick={() => setEditing(true)}>
            編集
          </button>
        )}
        {mutable && message.id && (
          <button type="button" onClick={() => void deleteMessage()}>
            削除
          </button>
        )}
      </div>
      {suggestionsEnabled &&
        !suggestionsUsed &&
        message.replySuggestions &&
        message.replySuggestions.length > 0 && (
          <div className="reply-suggestions">
            <button
              type="button"
              aria-expanded={suggestionsOpen}
              onClick={() => setSuggestionsOpen((current) => !current)}
            >
              返信候補
            </button>
            {suggestionsOpen && (
              <ol>
                {message.replySuggestions.map((suggestion) => (
                  <li key={suggestion}>
                    <button
                      type="button"
                      onClick={() => {
                        setSuggestionsOpen(false);
                        setSuggestionsUsed(true);
                        onSuggestion(suggestion);
                      }}
                    >
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
    </article>
  );
}

function ChatPane({
  pane,
  active,
  config,
  summary,
  onFocus,
  onClose,
  onSessionChange,
  onBusyChange,
  onSessionsInvalidated,
  refreshVersion,
  onAbortReady,
}: {
  pane: PaneDescriptor;
  active: boolean;
  config: Config;
  summary?: Session;
  onFocus: () => void;
  onClose: () => void;
  onSessionChange: (sessionId: string | null) => void;
  onBusyChange: (busy: boolean) => void;
  onSessionsInvalidated: () => Promise<void>;
  refreshVersion: number;
  onAbortReady: (abort: (() => void) | null) => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [streamText, setStreamText] = useState('');
  const [toolLines, setToolLines] = useState<string[]>([]);
  const [observedLiveTurn, setObservedLiveTurn] = useState<ObservedLiveTurn>();
  const [liveToolsOpen, setLiveToolsOpen] = useState(true);
  const [toolHistory, setToolHistory] = useState<ToolHistoryEntry[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number>();
  const [clock, setClock] = useState(Date.now());
  const [timeout, setTimeoutState] = useState<TimeoutState>({});
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [discordComposeEnabled, setDiscordComposeEnabled] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const pendingFilesRef = useRef<PendingFile[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followBottomRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const toolHistorySequenceRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const activeRef = useRef(active);
  const sessionId = pane.sessionId;
  const editable =
    detail?.platform === 'web' || (detail?.platform === 'discord' && discordComposeEnabled);
  const discordRemoteMode = detail?.platform === 'discord' && discordComposeEnabled;

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const loadToolHistory = useCallback(async () => {
    if (!sessionId) return;
    const sequence = ++toolHistorySequenceRef.current;
    try {
      const data = await requestJson<ToolHistoryResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/tool-history?limit=100`
      );
      if (sequence === toolHistorySequenceRef.current) setToolHistory(data.tools);
    } catch (cause) {
      console.warn('[web-chat] Failed to load tool history:', cause);
    }
  }, [sessionId]);

  const loadDetail = useCallback(
    async (prepend = false) => {
      if (!sessionId) {
        loadSequenceRef.current += 1;
        setDetail(null);
        setLoadingDetail(false);
        setLoadingOlder(false);
        return;
      }
      const sequence = ++loadSequenceRef.current;
      const cursor = prepend ? detail?.nextCursor : 'tail';
      if (prepend) {
        setLoadingOlder(true);
      } else {
        setLoadingDetail(true);
      }
      const viewport = messagesRef.current;
      const oldHeight = viewport?.scrollHeight || 0;
      try {
        const data = await requestJson<SessionDetail>(
          `/api/sessions/${encodeURIComponent(sessionId)}?limit=50&cursor=${encodeURIComponent(
            String(cursor)
          )}`
        );
        if (sequence !== loadSequenceRef.current) return;
        data.messages = data.messages.filter(
          (message) =>
            message.role !== 'error' &&
            !(message.role === 'user' && message.content.startsWith(AUTO_TALK_SENTINEL))
        );
        setDetail((current) =>
          prepend && current ? { ...data, messages: [...data.messages, ...current.messages] } : data
        );
        if (prepend && viewport) {
          requestAnimationFrame(() => {
            viewport.scrollTop += viewport.scrollHeight - oldHeight;
          });
        }
      } catch (cause) {
        if (sequence === loadSequenceRef.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (sequence === loadSequenceRef.current) {
          setLoadingOlder(false);
          setLoadingDetail(false);
        }
      }
    },
    [detail?.messages.length, detail?.nextBefore, sessionId]
  );

  useEffect(() => {
    setDetail(null);
    setError('');
    setStreamText('');
    setToolLines([]);
    setObservedLiveTurn(undefined);
    setLiveToolsOpen(true);
    setToolHistory([]);
    setDiscordComposeEnabled(false);
    followBottomRef.current = true;
    setTimeoutState({
      timeoutAt: summary?.timeoutAt,
      maxTimeoutAt: summary?.maxTimeoutAt,
      timeoutMs: summary?.timeoutMs,
    });
    void loadDetail();
    void loadToolHistory();
  }, [sessionId]);

  useEffect(() => {
    if (!busy && !summary?.activity?.active) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy, summary?.activity?.active]);

  useEffect(() => {
    if (busy) {
      setObservedLiveTurn(undefined);
      return;
    }
    setObservedLiveTurn((current) => syncObservedLiveTurn(current, summary?.activity));
  }, [busy, summary?.activity?.active, summary?.activity?.textPreview, summary?.activity?.turnId]);

  useEffect(() => {
    if (busy || !summary?.activity?.active) return;
    const threadId = liveThreadId(summary);
    if (!threadId) return;
    const source = new EventSource(`/api/events/stream?thread_id=${encodeURIComponent(threadId)}`);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as PublishedLiveEvent;
        setObservedLiveTurn((current) => applyPublishedLiveEvent(current, data));
      } catch {
        // A malformed observer event must not interrupt the chat pane.
      }
    };
    return () => source.close();
  }, [busy, summary?.activity?.active, summary?.activity?.turnId, summary?.contextKey, sessionId]);

  useEffect(() => {
    if (refreshVersion > 0 && sessionId && !busy) void loadDetail();
  }, [refreshVersion]);

  useEffect(() => {
    if (!active) setPaletteOpen(false);
  }, [active]);

  useEffect(() => {
    const viewport = messagesRef.current;
    if (!viewport) return;

    let frame = 0;
    const scrollToBottom = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (followBottomRef.current) viewport.scrollTop = viewport.scrollHeight;
      });
    };
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scrollToBottom);
    const observeChildren = () => {
      resizeObserver?.disconnect();
      Array.from(viewport.children).forEach((child) => resizeObserver?.observe(child));
      scrollToBottom();
    };
    const mutationObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => observeChildren());

    observeChildren();
    mutationObserver?.observe(viewport, { childList: true, subtree: true });

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [detail?.messages, streamText, toolLines]);

  useEffect(() => {
    pendingFilesRef.current = pendingFiles;
  }, [pendingFiles]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      pendingFilesRef.current.forEach(
        (file) => file.localUrl && URL.revokeObjectURL(file.localUrl)
      );
    },
    []
  );

  useEffect(() => {
    if (!active) return;
    const onDragOver = (event: DragEvent) => event.preventDefault();
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer?.files.length) {
        void uploadFiles(Array.from(event.dataTransfer.files));
      }
    };
    document.body.addEventListener('dragover', onDragOver);
    document.body.addEventListener('drop', onDrop);
    return () => {
      document.body.removeEventListener('dragover', onDragOver);
      document.body.removeEventListener('drop', onDrop);
    };
  });

  function setProcessing(value: boolean) {
    setBusy(value);
    onBusyChange(value);
    if (value) setThinkingStartedAt(Date.now());
    else setThinkingStartedAt(undefined);
  }

  const abortClient = useCallback(() => {
    abortRef.current?.abort();
    setProcessing(false);
    setStreamText('');
    setToolLines([]);
  }, [onBusyChange]);

  useEffect(() => {
    onAbortReady(abortClient);
    return () => onAbortReady(null);
  }, [abortClient, onAbortReady]);

  function runPaneAction(action: () => Promise<void>) {
    action().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause))
    );
  }

  async function uploadFiles(files: File[]) {
    setUploading(true);
    try {
      for (const file of files) {
        const body = new FormData();
        body.append('file', file);
        const result = await requestJson<{
          files?: Array<{ name: string; path: string }>;
          rejected?: Array<{ name: string; reason: string }>;
        }>('/api/upload', { method: 'POST', body });
        if (result.rejected?.length) {
          window.alert(result.rejected.map((item) => `${item.name}: ${item.reason}`).join('\n'));
        }
        const uploaded = result.files?.[0];
        if (uploaded) {
          setPendingFiles((current) => [
            ...current,
            {
              ...uploaded,
              localUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
            },
          ]);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
    }
  }

  function removePendingFile(index: number) {
    setPendingFiles((current) => {
      if (current[index]?.localUrl) URL.revokeObjectURL(current[index].localUrl);
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  }

  async function createSession() {
    const result = await requestJson<{ sessionId: string }>('/api/sessions', { method: 'POST' });
    onSessionChange(result.sessionId);
    setDetail({
      id: result.sessionId,
      title: '新しい会話',
      platform: 'web',
      messages: [],
    });
    await onSessionsInvalidated();
  }

  async function resumeSession() {
    if (!sessionId) return;
    const result = await requestJson<{ sessionId: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/resume`,
      { method: 'POST' }
    );
    onSessionChange(result.sessionId);
    await onSessionsInvalidated();
  }

  async function editTitle() {
    if (!sessionId) return;
    const title = window.prompt('セッション名', detail?.title || summary?.title || '');
    if (!title?.trim()) return;
    await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      ...jsonInit('PATCH', { title: title.trim() }),
    });
    setDetail((current) => (current ? { ...current, title: title.trim() } : current));
    await onSessionsInvalidated();
  }

  async function stopChat() {
    abortRef.current?.abort();
    try {
      if (sessionId) {
        await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {
          method: 'POST',
        });
      }
      await onSessionsInvalidated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProcessing(false);
      setStreamText('');
    }
  }

  async function extendTimeout() {
    if (!sessionId) return;
    try {
      const result = await requestJson<TimeoutState>(
        `/api/sessions/${encodeURIComponent(sessionId)}/timeout/extend`,
        { method: 'POST' }
      );
      setTimeoutState(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function executeCommand(input: string) {
    const result = await requestJson<{
      kind: 'message' | 'skills' | 'chat' | 'action';
      message?: string;
      displayMessage?: string;
      skipPermissions?: boolean;
      action?: 'new' | 'stop' | 'extend' | 'restart';
    }>('/api/web-commands', jsonInit('POST', { appSessionId: sessionId, input }));
    if (result.kind === 'message') {
      setDetail((current) =>
        current
          ? {
              ...current,
              messages: [
                ...current.messages,
                { role: 'user', content: input, createdAt: new Date().toISOString() },
                {
                  role: 'assistant',
                  content: result.message || '',
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : current
      );
      setDraft('');
      setPaletteOpen(false);
    } else if (result.kind === 'skills') {
      setDraft('/skill ');
      setPaletteOpen(true);
    } else if (result.kind === 'chat') {
      await send(result.message || '', result.displayMessage, result.skipPermissions);
    } else if (result.action === 'new') {
      setDraft('');
      setPaletteOpen(false);
      await createSession();
    } else if (result.action === 'stop') {
      setDraft('');
      setPaletteOpen(false);
      await stopChat();
    } else if (result.action === 'extend') {
      setDraft('');
      setPaletteOpen(false);
      await extendTimeout();
    } else if (result.action === 'restart') {
      if (!window.confirm(result.message || 'xangiを再起動しますか？')) return;
      await requestJson('/api/web-commands', {
        ...jsonInit('POST', { appSessionId: sessionId, input, confirm: true }),
      });
      setDraft('');
      setPaletteOpen(false);
      setError('再起動を開始しました。再接続を待っています');
    }
  }

  async function send(rawMessage?: string, displayMessage?: string, skipPermissions = false) {
    const cleanMessage = (rawMessage ?? draft).trim();
    if (!cleanMessage || !sessionId || busy || !editable) return;
    if (discordRemoteMode) {
      setDraft('');
      setError('');
      setProcessing(true);
      try {
        await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/discord-continue`, {
          ...jsonInit('POST', { message: cleanMessage }),
        });
        await Promise.all([loadDetail(), loadToolHistory(), onSessionsInvalidated()]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        await Promise.allSettled([loadDetail(), onSessionsInvalidated()]);
      } finally {
        setProcessing(false);
        if (activeRef.current) requestAnimationFrame(() => draftRef.current?.focus());
      }
      return;
    }
    if (cleanMessage.startsWith('/') && rawMessage === undefined) {
      await executeCommand(cleanMessage);
      return;
    }
    const attachmentLines = pendingFiles.map((file) => `[添付ファイル] ${file.path}`);
    const modelMessage = [cleanMessage, ...attachmentLines].filter(Boolean).join('\n');
    const shownMessage = displayMessage ?? cleanMessage;
    const shownFiles = [...pendingFiles];
    shownFiles.forEach((file) => file.localUrl && URL.revokeObjectURL(file.localUrl));
    setPendingFiles([]);
    setDraft('');
    setPaletteOpen(false);
    setError('');
    setStreamText('');
    setToolLines([]);
    followBottomRef.current = true;
    const optimistic: Message = {
      role: 'user',
      content: shownMessage,
      createdAt: new Date().toISOString(),
      attachments: shownFiles.map((file) => file.path),
    };
    setDetail((current) =>
      current ? { ...current, messages: [...current.messages, optimistic] } : current
    );
    const controller = new AbortController();
    abortRef.current = controller;
    setProcessing(true);
    try {
      const response = await fetch('/api/chat', {
        ...jsonInit('POST', {
          appSessionId: sessionId,
          message: modelMessage,
          skipPermissions,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(await response.text());
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const packets = buffer.split('\n\n');
        buffer = packets.pop() || '';
        for (const packet of packets) {
          const lines = packet.split('\n');
          const eventName = lines
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim();
          const dataText = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!dataText) continue;
          const data = JSON.parse(dataText) as Record<string, unknown>;
          if (eventName === 'text') setStreamText(String(data.fullText || ''));
          if (eventName === 'tool') {
            setToolLines((current) => [
              ...current,
              [data.toolName, data.inputSummary].filter(Boolean).join(': '),
            ]);
          }
          if (eventName === 'timeout') setTimeoutState(data as TimeoutState);
          if (eventName === 'timeout_cleared') setTimeoutState({});
          if (eventName === 'done') {
            setStreamText(String(data.response || ''));
          }
          if (eventName === 'error') throw new Error(String(data.message || '送信に失敗しました'));
        }
      }
      await Promise.all([loadDetail(), loadToolHistory(), onSessionsInvalidated()]);
      setStreamText('');
      setToolLines([]);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        setError('停止しました');
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      // The server may have persisted the user message (or a partial assistant
      // result) before the stream failed. Replace the optimistic state with the
      // transcript instead of leaving a duplicate or phantom bubble behind.
      await Promise.allSettled([loadDetail(), onSessionsInvalidated()]);
    } finally {
      abortRef.current = undefined;
      setProcessing(false);
      if (activeRef.current) {
        requestAnimationFrame(() => draftRef.current?.focus());
      }
    }
  }

  const elapsed = thinkingStartedAt
    ? Math.max(0, Math.floor((clock - thinkingStartedAt) / 1000))
    : 0;
  const liveTurn = selectLiveTurn({
    localBusy: busy,
    localText: streamText,
    localToolLines: toolLines,
    activity: summary?.activity,
    observed: observedLiveTurn,
  });
  const liveElapsed = busy
    ? elapsed
    : liveTurn.startedAt
      ? Math.max(0, Math.floor((clock - liveTurn.startedAt) / 1000))
      : summary?.activity?.elapsedSec || 0;
  const timeoutText = formatRemaining(timeout.timeoutAt);
  const timeoutWarning = Boolean(timeout.timeoutAt && timeout.timeoutAt - clock <= 30_000);
  const timeoutRemaining = timeout.timeoutAt ? Math.max(0, timeout.timeoutAt - clock) : 0;
  const timeoutAtLimit = Boolean(
    timeout.timeoutAt &&
    timeout.maxTimeoutAt &&
    timeout.timeoutAt + timeoutRemaining > timeout.maxTimeoutAt
  );
  const messageTools = useMemo(
    () => associateToolHistory(detail?.messages ?? [], detail?.platform, toolHistory),
    [detail?.messages, detail?.platform, toolHistory]
  );

  return (
    <section
      id={`panel-${pane.key}`}
      className={`pane ${active ? 'active' : ''}`}
      data-pane-key={pane.key}
      onMouseDown={onFocus}
      role="tabpanel"
      aria-labelledby={`tab-${pane.key}`}
    >
      <header className="pane-header">
        <button
          type="button"
          className={sessionId ? 'pane-title' : 'pane-title empty'}
          onClick={() => runPaneAction(editTitle)}
          disabled={!sessionId}
        >
          {detail?.title || summary?.title || '(empty)'}
        </button>
        <button type="button" className="pane-close" aria-label="ペインを閉じる" onClick={onClose}>
          ×
        </button>
      </header>
      <div
        className="pane-messages"
        ref={messagesRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          followBottomRef.current =
            target.scrollHeight - target.scrollTop - target.clientHeight < 80;
        }}
      >
        {!sessionId && (
          <div className="empty-state">
            セッションを選択
            <br />
            または
            <button
              type="button"
              className="empty-cta"
              onClick={() => runPaneAction(createSession)}
            >
              ＋ 新しい会話
            </button>
          </div>
        )}
        {sessionId && loadingDetail && !detail && (
          <div className="empty-state pane-loading" role="status">
            会話を読み込み中…
          </div>
        )}
        {detail?.hasMore && (
          <button
            type="button"
            className="load-older"
            disabled={loadingOlder}
            onClick={() => void loadDetail(true)}
          >
            {loadingOlder ? '読み込み中…' : '以前のメッセージを読み込む'}
          </button>
        )}
        {detail?.messages.map((message, index) => (
          <MessageView
            key={message.id || `${message.role}-${index}`}
            message={message}
            tools={messageTools[index] ?? []}
            sessionId={sessionId || ''}
            mutable={Boolean(detail)}
            suggestionsEnabled={editable}
            onReload={() => loadDetail()}
            onSuggestion={(suggestion) => {
              setDraft(suggestion);
              requestAnimationFrame(() => void send(suggestion));
            }}
          />
        ))}
        {liveTurn.visible && (
          <article className="message assistant live-turn" aria-live="polite">
            <header>
              <span>xangi</span>
              <small>{`${liveTurn.statusLabel} ${liveElapsed}秒`}</small>
            </header>
            {liveTurn.toolLines.length > 0 && (
              <section className="live-tools">
                <button
                  type="button"
                  className="live-tools-toggle"
                  aria-expanded={liveToolsOpen}
                  onClick={() => setLiveToolsOpen((current) => !current)}
                >
                  <span>実行ツール</span>
                  <small>
                    {liveTurn.toolLines.length}件 · {liveToolsOpen ? '隠す' : '表示'}
                  </small>
                </button>
                {liveToolsOpen && (
                  <div className="tool-history">
                    {liveTurn.toolLines.map((line, index) => (
                      <code key={`${line}-${index}`}>{line}</code>
                    ))}
                  </div>
                )}
              </section>
            )}
            {liveTurn.text ? (
              <MessageContent content={liveTurn.text} markdown />
            ) : (
              <div className="thinking">
                <span className="spinner" />
                考えています
              </div>
            )}
          </article>
        )}
      </div>
      {error && (
        <div className="pane-error" role="alert">
          {error}
        </div>
      )}
      {detail && detail.platform !== 'web' && (
        <div className="resume-bar">
          <span>
            {discordRemoteMode
              ? 'この入力は元のDiscordへ送信されます'
              : `${platformLabel(detail.platform)} の会話は読み取り専用です`}
          </span>
          <div className="resume-actions">
            {detail.platform === 'discord' && (
              <button
                type="button"
                aria-pressed={discordComposeEnabled}
                onClick={() => {
                  setDiscordComposeEnabled((current) => !current);
                  requestAnimationFrame(() => draftRef.current?.focus());
                }}
              >
                {discordComposeEnabled ? 'Discord送信をやめる' : 'このDiscordで続ける'}
              </button>
            )}
            <button type="button" onClick={() => runPaneAction(resumeSession)}>
              Web会話として分岐
            </button>
          </div>
        </div>
      )}
      {pendingFiles.length > 0 && (
        <div className="attachment-tray">
          {pendingFiles.map((file, index) => (
            <div className="attachment" key={`${file.path}-${index}`}>
              {file.localUrl ? <img src={file.localUrl} alt="" /> : <span>📄</span>}
              <span>{file.name}</span>
              <button
                type="button"
                onClick={() => removePendingFile(index)}
                aria-label="添付を外す"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        className={busy ? 'pane-input-area busy' : 'pane-input-area'}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="pane-command-shell">
          <div className="pane-composer">
            <button
              type="button"
              className="pane-command-btn"
              disabled={!editable || busy || discordRemoteMode}
              aria-label="コマンドとスキルを選択"
              aria-expanded={paletteOpen}
              onClick={() => {
                if (!draft.trim()) setDraft('/');
                setPaletteOpen((current) => !current);
                requestAnimationFrame(() => draftRef.current?.focus());
              }}
            >
              /
            </button>
            <button
              type="button"
              className="pane-attach-btn"
              disabled={!editable || busy || uploading || discordRemoteMode}
              onClick={() => fileInputRef.current?.click()}
              aria-label="ファイルを添付"
            >
              {uploading ? '…' : '📎'}
            </button>
            <input
              ref={fileInputRef}
              className="pane-file-input"
              type="file"
              multiple
              accept={config.uploadAccept || undefined}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                void uploadFiles(Array.from(event.target.files || []));
                event.target.value = '';
              }}
            />
            <textarea
              ref={draftRef}
              className="pane-input"
              rows={1}
              placeholder={
                discordRemoteMode
                  ? 'Discordへ送るメッセージを入力'
                  : editable
                    ? 'メッセージを入力'
                    : 'セッションを選択するか、新しい会話を開始'
              }
              disabled={!editable || busy}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                event.target.style.height = 'auto';
                event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
                setPaletteOpen(event.target.value.startsWith('/'));
              }}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.ctrlKey && event.key === '/') {
                  event.preventDefault();
                  if (!draft.trim()) setDraft('/');
                  setPaletteOpen(true);
                  return;
                }
                if (event.key === 'Escape' && paletteOpen) {
                  event.preventDefault();
                  setPaletteOpen(false);
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey && !isMobile() && !paletteOpen) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </div>
          <CommandPalette
            sessionId={sessionId}
            value={draft}
            open={paletteOpen && active && !discordRemoteMode}
            onChange={(value) => {
              setDraft(value);
              requestAnimationFrame(() => draftRef.current?.focus());
            }}
            onClose={() => setPaletteOpen(false)}
            onExecute={executeCommand}
          />
        </div>
        {busy ? (
          <button type="button" className="pane-stop action-btn" onClick={() => void stopChat()}>
            停止
          </button>
        ) : (
          <button
            type="submit"
            className="pane-send action-btn"
            disabled={!draft.trim() || !editable}
          >
            送信
          </button>
        )}
        {busy && config.timeoutExtendEnabled && (
          <button
            type="button"
            className="pane-extend action-btn"
            disabled={!timeout.timeoutAt || timeoutAtLimit}
            aria-label={
              timeoutAtLimit ? 'タイムアウト延長の上限に達しました' : 'タイムアウトを延長'
            }
            onClick={() => void extendTimeout()}
          >
            延長
          </button>
        )}
        {busy && timeoutText && (
          <span className={timeoutWarning ? 'pane-timeout warning' : 'pane-timeout'}>
            ⏱ {timeoutText}
          </span>
        )}
      </form>
    </section>
  );
}

function SessionDeleteDialog({
  session,
  deleting,
  onCancel,
  onConfirm,
}: {
  session: Session | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropPointerDownRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (session && !dialog.open) {
      const frame = requestAnimationFrame(() => {
        if (!dialog.open) dialog.showModal();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!session && dialog.open) dialog.close();
  }, [session]);

  return (
    <dialog
      ref={dialogRef}
      className="session-delete-dialog"
      aria-labelledby="session-delete-title"
      aria-describedby="session-delete-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!deleting) onCancel();
      }}
      onPointerDown={(event) => {
        backdropPointerDownRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const clickedBackdrop =
          event.target === event.currentTarget && backdropPointerDownRef.current;
        backdropPointerDownRef.current = false;
        if (clickedBackdrop && !deleting) onCancel();
      }}
    >
      <div className="session-delete-dialog-body">
        <h2 id="session-delete-title">セッションを削除</h2>
        <p id="session-delete-description">
          「{session?.title || 'このセッション'}」の会話履歴を削除します。この操作は元に戻せません。
        </p>
      </div>
      <div className="session-delete-dialog-actions">
        <button type="button" autoFocus disabled={deleting} onClick={onCancel}>
          キャンセル
        </button>
        <button
          type="button"
          className="session-delete-dialog-danger"
          disabled={deleting}
          onClick={onConfirm}
        >
          {deleting ? '削除中…' : '削除'}
        </button>
      </div>
    </dialog>
  );
}

export function Chat() {
  const restored = useMemo(restorePanes, []);
  const [panes, setPanes] = useState<PaneDescriptor[]>(restored.panes);
  const [activeKey, setActiveKey] = useState(restored.activeKey);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState(
    () => window.localStorage.getItem(PROJECT_STATE_KEY) || ''
  );
  const [projectViewOpen, setProjectViewOpen] = useState(false);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string>();
  const [projectName, setProjectName] = useState('');
  const [projectPrompt, setProjectPrompt] = useState('');
  const [savingProject, setSavingProject] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [nextOffset, setNextOffset] = useState<number>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  );
  const [busyPanes, setBusyPanes] = useState<Record<string, boolean>>({});
  const [config, setConfig] = useState<Config>({
    uploadAccept: null,
    timeoutExtendEnabled: true,
    interChatEnabled: false,
  });
  const [notice, setNotice] = useState('');
  const [sessionToDelete, setSessionToDelete] = useState<Session | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const sessionsRef = useRef<Session[]>([]);
  const queryRef = useRef('');
  const searchTimerRef = useRef<number | undefined>(undefined);
  const skipInitialSearchRef = useRef(true);
  const loadRequestRef = useRef(0);
  const paneAbortersRef = useRef<Record<string, () => void>>({});

  const loadSessions = useCallback(
    async (offset = 0, q = query, append = false) => {
      const requestId = ++loadRequestRef.current;
      const params = new URLSearchParams({ limit: '100', offset: String(offset) });
      if (q.trim()) params.set('q', q.trim());
      if (activeProjectId) params.set('projectId', activeProjectId);
      setSearching(true);
      try {
        const data = await requestJson<SessionsResponse>(`/api/sessions?${params}`);
        if (requestId !== loadRequestRef.current) return;
        setSessions((current) => {
          const next = append
            ? [
                ...current,
                ...data.sessions.filter((item) => !current.some((old) => old.id === item.id)),
              ]
            : data.sessions;
          sessionsRef.current = next;
          return next;
        });
        setNextOffset(data.meta?.hasMore ? data.meta.nextOffset : undefined);
        setNotice('');
      } catch (cause) {
        if (requestId !== loadRequestRef.current) return;
        setNotice(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (requestId === loadRequestRef.current) setSearching(false);
      }
    },
    [activeProjectId, query]
  );

  useEffect(() => {
    void Promise.all([
      loadSessions(0, '', false),
      requestJson<Config>('/api/config').then(setConfig),
      requestJson<ProjectsResponse>('/api/projects').then((result) => {
        setProjects(result.projects);
        setActiveProjectId((current) =>
          current && !result.projects.some((project) => project.id === current) ? '' : current
        );
      }),
    ]).catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(PROJECT_STATE_KEY, activeProjectId);
  }, [activeProjectId]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    const activeIndex = Math.max(
      0,
      panes.findIndex((pane) => pane.key === activeKey)
    );
    localStorage.setItem(
      PANE_STATE_KEY,
      JSON.stringify({
        sessions: panes.map((pane) => pane.sessionId),
        activeIndex,
        ids: panes.map((pane) => pane.sessionId),
        activeIdx: activeIndex,
      })
    );
  }, [activeKey, panes]);

  useEffect(() => {
    const streamParams = new URLSearchParams();
    if (activeProjectId) streamParams.set('projectId', activeProjectId);
    const source = new EventSource(`/api/sessions/stream?${streamParams}`);
    source.addEventListener('sessions', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as SessionsResponse;
      if (queryRef.current.trim()) return;
      const hadAdditionalPages = sessionsRef.current.length > data.sessions.length;
      setSessions((current) => {
        const incoming = new Map(data.sessions.map((session) => [session.id, session]));
        const retained = current
          .filter((session) => !incoming.has(session.id))
          .map((session) => session);
        const next = [...data.sessions, ...retained];
        sessionsRef.current = next;
        return next;
      });
      setNextOffset((current) =>
        hadAdditionalPages ? current : data.meta?.hasMore ? data.meta.nextOffset : undefined
      );
      setRefreshVersion((current) => current + 1);
    });
    source.addEventListener('activity_snapshot', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        threadId: string;
        activity: Activity;
      };
      const separator = data.threadId.indexOf(':');
      if (separator < 0) return;
      const platform = data.threadId.slice(0, separator);
      const contextKey = data.threadId.slice(separator + 1);
      setSessions((current) => {
        const next = current
          .map((session) => {
            const matched =
              session.platform === platform &&
              (platform === 'web' ? session.id === contextKey : session.contextKey === contextKey);
            return matched
              ? {
                  ...session,
                  isActive: data.activity.active,
                  updatedAt: new Date(data.activity.updatedAt || Date.now()).toISOString(),
                  activity: data.activity,
                }
              : session;
          })
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        sessionsRef.current = next;
        return next;
      });
      if (!data.activity.active) setRefreshVersion((current) => current + 1);
    });
    source.onopen = () => setNotice('');
    source.onerror = () => setNotice('更新ストリームを再接続しています');
    return () => source.close();
  }, [activeProjectId]);

  useEffect(() => {
    if (skipInitialSearchRef.current) {
      skipInitialSearchRef.current = false;
      return;
    }
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => void loadSessions(0, query, false), 180);
    return () => window.clearTimeout(searchTimerRef.current);
  }, [activeProjectId, query]);

  function addPane(sessionId: string | null = null): PaneDescriptor | null {
    if (panes.length >= MAX_PANES) return null;
    const pane = { key: `pane-${++paneSequence}`, sessionId };
    setPanes((current) => [...current, pane]);
    setActiveKey(pane.key);
    return pane;
  }

  function closePane(paneKey: string) {
    if (busyPanes[paneKey] && !window.confirm('応答は継続したままペインを閉じますか？')) {
      return;
    }
    paneAbortersRef.current[paneKey]?.();
    delete paneAbortersRef.current[paneKey];
    setPanes((current) => {
      const index = current.findIndex((pane) => pane.key === paneKey);
      if (index < 0) return current;
      const next = current.filter((pane) => pane.key !== paneKey);
      if (paneKey === activeKey) {
        setActiveKey(next[Math.min(index, next.length - 1)]?.key || '');
      }
      return next;
    });
  }

  function toggleSidebar() {
    if (window.matchMedia('(max-width: 768px), (max-height: 500px) and (hover: none)').matches) {
      setSidebarOpen((current) => !current);
      return;
    }
    setSidebarCollapsed((current) => !current);
  }

  function openSession(sessionId: string) {
    const existing = panes.find((pane) => pane.sessionId === sessionId);
    if (existing) {
      setActiveKey(existing.key);
      setSidebarOpen(false);
      return;
    }
    const active = panes.find((pane) => pane.key === activeKey);
    if (busyPanes[activeKey] || !active) {
      if (!addPane(sessionId)) {
        setNotice(`最大 ${MAX_PANES} ペインです。空きペインを作ってからセッションを開いてください`);
        return;
      }
    } else {
      setPanes((current) =>
        current.map((pane) => (pane.key === activeKey ? { ...pane, sessionId } : pane))
      );
    }
    setSidebarOpen(false);
  }

  async function createSession() {
    const active = panes.find((pane) => pane.key === activeKey);
    const needsNewPane = !active || Boolean(busyPanes[activeKey]);
    let targetKey = active?.key || '';
    if (needsNewPane) {
      const newPane = addPane();
      if (!newPane) {
        setNotice(
          `最大 ${MAX_PANES} ペインです。空きペインを作ってから新しい会話を開始してください`
        );
        return;
      }
      targetKey = newPane.key;
    }
    try {
      const result = await requestJson<{ sessionId: string }>(
        '/api/sessions',
        jsonInit('POST', activeProjectId ? { projectId: activeProjectId } : {})
      );
      setPanes((current) =>
        current.map((pane) =>
          pane.key === targetKey ? { ...pane, sessionId: result.sessionId } : pane
        )
      );
      setActiveKey(targetKey);
      setSidebarOpen(false);
      await loadSessions(0, query, false);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function openNewProjectForm() {
    setEditingProjectId(undefined);
    setProjectName('');
    setProjectPrompt('');
    setProjectFormOpen(true);
  }

  function openProjectEditor(
    project = projects.find((candidate) => candidate.id === activeProjectId)
  ) {
    if (!project) return;
    setEditingProjectId(project.id);
    setProjectName(project.name);
    setProjectPrompt(project.prompt);
    setProjectFormOpen(true);
  }

  async function saveProject(event: FormEvent) {
    event.preventDefault();
    if (!projectName.trim() || savingProject) return;
    setSavingProject(true);
    try {
      const body = { name: projectName.trim(), prompt: projectPrompt.trim() };
      const endpoint = editingProjectId
        ? `/api/projects/${encodeURIComponent(editingProjectId)}`
        : '/api/projects';
      const result = await requestJson<{ project: Project }>(
        endpoint,
        jsonInit(editingProjectId ? 'PATCH' : 'POST', body)
      );
      const refreshed = await requestJson<ProjectsResponse>('/api/projects');
      setProjects(refreshed.projects);
      setActiveProjectId(result.project.id);
      setProjectViewOpen(false);
      setProjectFormOpen(false);
      setEditingProjectId(undefined);
      setProjectName('');
      setProjectPrompt('');
      setNotice('');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingProject(false);
    }
  }

  async function stopSession(sessionId: string) {
    try {
      panes.forEach((pane) => {
        if (pane.sessionId === sessionId) paneAbortersRef.current[pane.key]?.();
      });
      await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
      await loadSessions(0, query, false);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function toggleAutoTalk(session: Session) {
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(session.id)}/autotalk`, {
        ...jsonInit('POST', { enabled: !session.autoTalk }),
      });
      await loadSessions(0, query, false);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function deleteSession() {
    if (!sessionToDelete || deletingSession) return;
    const sessionId = sessionToDelete.id;
    setDeletingSession(true);
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      setSessionToDelete(null);
      setPanes((current) =>
        current.map((pane) => (pane.sessionId === sessionId ? { ...pane, sessionId: null } : pane))
      );
      await loadSessions(0, query, false);
    } catch (cause) {
      setSessionToDelete(null);
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeletingSession(false);
    }
  }

  const grouped = useMemo(() => {
    const result: Array<{ label: string; sessions: Session[] }> = [];
    for (const session of sessions) {
      const label = dateGroup(session.updatedAt);
      const group = result[result.length - 1];
      if (group?.label === label) group.sessions.push(session);
      else result.push({ label, sessions: [session] });
    }
    return result;
  }, [sessions]);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  );
  const compactSidebar = window.matchMedia(
    '(max-width: 768px), (max-height: 500px) and (hover: none)'
  ).matches;
  const sidebarVisible = compactSidebar ? sidebarOpen : !sidebarCollapsed;

  return (
    <main
      className={[
        'app-shell',
        `pane-count-${panes.length}`,
        sidebarCollapsed ? 'sidebar-collapsed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <AppTopbar current="chat" />
      <aside className={sidebarOpen ? 'sidebar open' : 'sidebar'}>
        <div className="sidebar-header sidebar-drawer-header">
          <span className="sidebar-title">会話一覧</span>
          <button
            type="button"
            className="icon-button"
            aria-label="サイドバーを閉じる"
            onClick={() => {
              if (
                window.matchMedia('(max-width: 768px), (max-height: 500px) and (hover: none)')
                  .matches
              ) {
                setSidebarOpen(false);
              } else {
                setSidebarCollapsed(true);
              }
            }}
          >
            ‹
          </button>
        </div>
        <button
          type="button"
          className="projects-link"
          aria-current={projectViewOpen ? 'page' : undefined}
          onClick={() => {
            setProjectViewOpen(true);
            setProjectFormOpen(false);
            if (compactSidebar) setSidebarOpen(false);
          }}
        >
          <span aria-hidden="true">▱</span>
          <span>Projects</span>
          <span aria-hidden="true">›</span>
        </button>
        <div className="sidebar-actions">
          <input
            className="search"
            aria-label="セッション検索"
            placeholder="会話を検索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="button sidebar-new-chat"
            onClick={() => void createSession()}
          >
            ＋ 新規
          </button>
        </div>
        <nav className="session-list" aria-label="セッション一覧">
          {grouped.map((group) => (
            <section className="session-group" key={group.label}>
              <h2>{group.label}</h2>
              {group.sessions.map((session) => {
                const open = panes.some((pane) => pane.sessionId === session.id);
                const current =
                  panes.find((pane) => pane.key === activeKey)?.sessionId === session.id;
                const projectName = session.projectId
                  ? projectNames.get(session.projectId)
                  : undefined;
                return (
                  <div
                    className={[
                      'session-row',
                      open ? 'active' : '',
                      current ? 'current selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-current={current ? 'true' : undefined}
                    key={session.id}
                  >
                    <button
                      type="button"
                      className="session-main"
                      onClick={() => openSession(session.id)}
                    >
                      <span className={`status-dot ${session.isActive ? 'active' : ''}`} />
                      <span className="session-copy">
                        <strong>{session.title}</strong>
                        <small>
                          <span>
                            {platformLabel(session.platform)} · {relativeTime(session.updatedAt)}
                            {session.autoTalk ? ' · 自走' : ''}
                          </span>
                          {projectName && (
                            <span className="session-project-tag" title={projectName}>
                              {projectName}
                            </span>
                          )}
                        </small>
                      </span>
                    </button>
                    <div className="session-actions">
                      {session.isActive && (
                        <button
                          type="button"
                          aria-label="停止"
                          onClick={() => void stopSession(session.id)}
                        >
                          ■
                        </button>
                      )}
                      {shouldShowAutoTalk(config.interChatEnabled, session.platform) && (
                        <button
                          type="button"
                          aria-label={session.autoTalk ? '自走を無効化' : '自走を有効化'}
                          onClick={() => void toggleAutoTalk(session)}
                        >
                          {session.autoTalk ? '自' : '○'}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label="削除"
                        onClick={() => setSessionToDelete(session)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
          {nextOffset !== undefined && (
            <button
              type="button"
              className="load-more"
              disabled={searching}
              onClick={() => void loadSessions(nextOffset, query, true)}
            >
              {searching ? '読み込み中…' : 'さらに読み込む'}
            </button>
          )}
        </nav>
        <div className="sidebar-links">
          {config.interChatEnabled && (
            <a href="/inter-chat" target="_blank" rel="noopener noreferrer">
              インスタンス間チャット
            </a>
          )}
        </div>
      </aside>
      <section className="workspace">
        {projectViewOpen ? (
          <div className="project-view">
            <header className="project-view-header">
              <div>
                <button
                  type="button"
                  className="project-view-back"
                  onClick={() => {
                    setProjectViewOpen(false);
                    setProjectFormOpen(false);
                  }}
                >
                  ← 会話
                </button>
                <h1>Projects</h1>
              </div>
              {!projectFormOpen && (
                <button type="button" className="project-view-new" onClick={openNewProjectForm}>
                  ＋ 新規Project
                </button>
              )}
            </header>
            {projectFormOpen ? (
              <form className="project-form" onSubmit={(event) => void saveProject(event)}>
                <label>
                  <span>名前</span>
                  <input
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    maxLength={80}
                    required
                  />
                </label>
                <label>
                  <span>追加プロンプト</span>
                  <textarea
                    value={projectPrompt}
                    onChange={(event) => setProjectPrompt(event.target.value)}
                    maxLength={20_000}
                    rows={5}
                    placeholder="このProjectの会話に追加する指示"
                  />
                </label>
                <p>会話をまとめるだけで、フォルダは作成しません。</p>
                <div className="project-form-actions">
                  <button
                    type="button"
                    disabled={savingProject}
                    onClick={() => setProjectFormOpen(false)}
                  >
                    キャンセル
                  </button>
                  <button type="submit" className="primary" disabled={savingProject}>
                    {savingProject ? '保存中…' : editingProjectId ? '更新' : '作成'}
                  </button>
                </div>
              </form>
            ) : (
              <nav className="project-view-list" aria-label="Project一覧">
                <button
                  type="button"
                  className={!activeProject ? 'selected' : ''}
                  onClick={() => {
                    setActiveProjectId('');
                    setProjectViewOpen(false);
                  }}
                >
                  <span className="project-view-icon" aria-hidden="true">
                    ◫
                  </span>
                  <span className="project-view-copy">
                    <strong>すべての会話</strong>
                    <small>Projectに関係なく表示</small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
                {projects.map((project) => (
                  <div
                    className={
                      project.id === activeProjectId
                        ? 'project-view-row selected'
                        : 'project-view-row'
                    }
                    key={project.id}
                  >
                    <button
                      type="button"
                      className="project-view-main"
                      onClick={() => {
                        setActiveProjectId(project.id);
                        setProjectViewOpen(false);
                      }}
                    >
                      <span className="project-view-icon" aria-hidden="true">
                        ▱
                      </span>
                      <span className="project-view-copy">
                        <strong>{project.name}</strong>
                        <small>
                          {project.prompt ? '追加プロンプト設定済み' : '追加プロンプトなし'}
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="project-view-edit"
                      aria-label={`${project.name}の設定`}
                      onClick={() => {
                        setActiveProjectId(project.id);
                        openProjectEditor(project);
                      }}
                    >
                      設定
                    </button>
                    <span aria-hidden="true">›</span>
                  </div>
                ))}
                {projects.length === 0 && (
                  <p className="project-empty">Projectはまだありません。</p>
                )}
              </nav>
            )}
          </div>
        ) : (
          <>
            <header className="panes-toolbar">
              <button
                type="button"
                className="icon-button sidebar-toggle"
                aria-label={sidebarVisible ? 'サイドバーを閉じる' : 'サイドバーを開く'}
                title={sidebarVisible ? 'サイドバーを閉じる' : 'サイドバーを開く'}
                onClick={toggleSidebar}
              >
                ☰
              </button>
              <span className="pane-count">
                {panes.length} / {MAX_PANES} ペイン
              </span>
              <button
                type="button"
                className="add-pane"
                disabled={panes.length >= MAX_PANES}
                onClick={() => addPane()}
              >
                ＋ ペイン
              </button>
            </header>
            {notice && (
              <div className="notice" role="status">
                {notice}
              </div>
            )}
            <div className="pane-tabs" role="tablist">
              {panes.map((pane, index) => (
                <span
                  role="presentation"
                  key={pane.key}
                  style={{ display: 'inline-flex', flex: '0 0 auto', alignItems: 'center' }}
                >
                  <button
                    id={`tab-${pane.key}`}
                    type="button"
                    role="tab"
                    aria-controls={`panel-${pane.key}`}
                    aria-selected={pane.key === activeKey}
                    tabIndex={pane.key === activeKey ? 0 : -1}
                    className={pane.key === activeKey ? 'active' : ''}
                    onClick={() => setActiveKey(pane.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowRight') {
                        setActiveKey(panes[(index + 1) % panes.length].key);
                      }
                      if (event.key === 'ArrowLeft') {
                        setActiveKey(panes[(index - 1 + panes.length) % panes.length].key);
                      }
                      if (event.key === 'Home') setActiveKey(panes[0].key);
                      if (event.key === 'End') setActiveKey(panes[panes.length - 1].key);
                      if (event.key === 'Delete') closePane(pane.key);
                    }}
                  >
                    {sessions.find((session) => session.id === pane.sessionId)?.title ||
                      `ペイン ${index + 1}`}
                  </button>
                  <button
                    type="button"
                    aria-label={`${
                      sessions.find((session) => session.id === pane.sessionId)?.title ||
                      `ペイン ${index + 1}`
                    }を閉じる`}
                    onClick={() => closePane(pane.key)}
                    style={{ minWidth: 28, maxWidth: 28, padding: '7px 4px' }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="panes-container" data-count={panes.length}>
              {panes.length === 0 && (
                <div className="empty-state">
                  ペインは開いていません
                  <button type="button" className="empty-cta" onClick={() => void createSession()}>
                    ＋ 新しい会話
                  </button>
                </div>
              )}
              {panes.map((pane) => (
                <ChatPane
                  key={pane.key}
                  pane={pane}
                  active={pane.key === activeKey}
                  config={config}
                  summary={sessions.find((session) => session.id === pane.sessionId)}
                  onFocus={() => setActiveKey(pane.key)}
                  onClose={() => closePane(pane.key)}
                  onSessionChange={(sessionId) =>
                    setPanes((current) =>
                      current.map((item) => (item.key === pane.key ? { ...item, sessionId } : item))
                    )
                  }
                  onBusyChange={(value) =>
                    setBusyPanes((current) => ({ ...current, [pane.key]: value }))
                  }
                  onSessionsInvalidated={() => loadSessions(0, query, false)}
                  refreshVersion={refreshVersion}
                  onAbortReady={(abort) => {
                    if (abort) paneAbortersRef.current[pane.key] = abort;
                    else delete paneAbortersRef.current[pane.key];
                  }}
                />
              ))}
            </div>
          </>
        )}
      </section>
      {sidebarOpen && (
        <button
          type="button"
          className="scrim"
          aria-label="会話一覧を閉じる"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <SessionDeleteDialog
        session={sessionToDelete}
        deleting={deletingSession}
        onCancel={() => {
          if (!deletingSession) setSessionToDelete(null);
        }}
        onConfirm={() => void deleteSession()}
      />
    </main>
  );
}

export type { Activity, Session, SessionsResponse };
