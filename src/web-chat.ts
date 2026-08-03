/**
 * Web チャット UI — 複数スレッド並存・並列ストリーミング対応版
 *
 * 各 Web セッションは contextKey = `web-chat:<appSessionId>` で独立。
 * 同時に複数のセッションを保持・操作できる。
 */
import { createServer } from 'http';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  realpathSync,
} from 'fs';
import { join, dirname, extname, basename, relative, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AgentRunner } from './agent-runner.js';
import type { DiscordRemoteInputBridge } from './discord/message-handler.js';
import {
  getSession,
  setSession,
  ensureSession,
  listAllSessions,
  getSessionEntry,
  getActiveSessionId,
  updateSessionTitle,
  updateSessionProject,
  incrementMessageCount,
  createWebSession,
  clearResumedFromSessionId,
  setProviderSessionId,
  removeSession,
  setAutoTalk,
  WEB_CHAT_CONTEXT_PREFIX,
} from './sessions.js';
import {
  readSessionMessages,
  readSessionMessagesPage,
  readSessionMessagesTail,
  updateMessageContent,
  deleteMessage as deleteTranscriptMessage,
  ensureVisibleAssistantResponse,
} from './transcript-logger.js';
import { threadIdFor, turnIdFor, events, subscribeEvents } from './events-emitter.js';
import {
  getActivity,
  readToolHistory,
  readTurnHistory,
  subscribeActivity,
} from './activity-store.js';
import { TIMEOUT_EXTEND_ENABLED } from './constants.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import {
  deriveActivityThreadIdFromFirstMessage,
  deriveTitleFromFirstMessage,
  stripPromptMetadata,
} from './session-title.js';
import { isSchedulerRunId } from './scheduler-run.js';
import { handleInterChatRequest } from './inter-instance-chat/web-server.js';
import { flowFromHostPlatform, getInterChatConfig } from './inter-instance-chat/index.js';
import { setupAutoTalk } from './inter-instance-chat/auto-talk.js';
import { resolveAccessUrls, formatAccessUrls, primaryAccessUrl } from './access-urls.js';
import { handleEventsStreamRequest } from './events-stream-server.js';
import { handlePetInboxRequest, isInboxPath } from './pet-inbox-server.js';
import { handleEvenTerminalRequest } from './even-terminal-server.js';
import { TurnLatencyRecorder } from './turn-latency.js';
import { buildPrefetchedHistoryBlock } from './prefetched-history.js';
import {
  appendReplySuggestionInstruction,
  fallbackReplySuggestions,
  sanitizeReplySuggestionOutput,
  stripReplySuggestionMarkup,
} from './reply-suggestions.js';
import type { AgentBackend, Config, EffortLevel } from './config.js';
import { loadReplySuggestionsEnabled } from './settings.js';
import type { BackendResolver, ChannelOverride } from './backend-resolver.js';
import { discoverBackendModels } from './backend-models.js';
import {
  getSupportedEffortLevels,
  requiresExplicitModelForEffort,
  supportsEffort,
} from './backend-effort.js';
import type { Platform, ScheduleInput, Scheduler } from './scheduler.js';
import type { Skill } from './skills.js';
import { canSelfRestart, getSelfLifecyclePermission } from './self-lifecycle.js';
import { executeWebCommand, getWebCommandDefinitions } from './web-slash-commands.js';
import { WorkspaceBrowser, WorkspaceBrowserError } from './workspace-browser.js';
import { prependWebProjectPrompt, WebProjectError, WebProjectStore } from './web-projects.js';
import { registerStreamFinalizer } from './stream-finalizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PORT = 18888;
const SESSION_LIST_LIMIT = 100;
const SESSION_LIST_MAX_LIMIT = 200;
const SESSION_MESSAGE_LIMIT = 50;
const SESSION_MESSAGE_MAX_LIMIT = 200;
const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const WEB_SCHEDULE_NEW_SESSION_ID = '__new__';
const ACTIVE_DOWNLOAD_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.svg',
  '.js',
  '.mjs',
  '.css',
  '.xml',
]);

function isRealPathWithin(root: string, target: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    const fromRoot = relative(realRoot, realTarget);
    return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
  } catch {
    return false;
  }
}

function isRealFileWithin(root: string, target: string): boolean {
  try {
    return isAbsolute(target) && isRealPathWithin(root, target) && statSync(target).isFile();
  } catch {
    return false;
  }
}

function parseDisplayedUserAttachments(
  content: string,
  allowedRoots: string[]
): { content: string; attachments: string[] } {
  const attachments: string[] = [];
  const displayLines: string[] = [];
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = line.match(/^\[添付ファイル\](?:[ \t]+(.+?))?[ \t]*$/);
    if (!marker) {
      displayLines.push(line);
      continue;
    }

    const candidates: string[] = [];
    if (marker[1]) candidates.push(marker[1].trim());

    while (index + 1 < lines.length) {
      const bullet = lines[index + 1].match(/^[ \t]*-[ \t]+(.+?)[ \t]*$/);
      if (!bullet) break;
      index += 1;
      candidates.push(bullet[1].trim());
    }

    for (const candidate of candidates) {
      if (
        allowedRoots.some((root) => isRealFileWithin(root, candidate)) &&
        !attachments.includes(candidate)
      ) {
        attachments.push(candidate);
      }
    }
  }

  return {
    content: displayLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    attachments,
  };
}

function uploadMaxBytes(): number {
  const configured = Number(process.env.WEB_CHAT_UPLOAD_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_UPLOAD_MAX_BYTES;
}

/** appSessionId に対応する contextKey を返す */
function webContextKey(appSessionId: string): string {
  return `${WEB_CHAT_CONTEXT_PREFIX}${appSessionId}`;
}

/** appSessionId が web セッションかどうか */
function isWebSession(appSessionId: string): boolean {
  const entry = getSessionEntry(appSessionId);
  return entry?.platform === 'web';
}

function sessionThreadId(session: {
  id: string;
  platform: string;
  contextKey: string;
}): string | null {
  if (session.platform === 'web') return threadIdFor('web', session.id);
  if (session.platform === 'discord') return threadIdFor('discord', session.contextKey);
  if (session.platform === 'slack') return threadIdFor('slack', session.contextKey);
  return null;
}

/** 同一 appSessionId への並行送信を抑止するためのビジー集合 */
const busySessions = new Set<string>();

function hasInternalPromptMetadata(text: string): boolean {
  return /\[システム注記:|\[runtime\]|<prefetched-history\b|(?:<|\[)system-context(?:>|\])|<xangi_reply|(?:🧵 スレッド元|💬 返信元)|\[チャンネルルール（必ず従うこと）\]/.test(
    text
  );
}

interface WebChatOptions {
  agentRunner: AgentRunner;
  port?: number;
  historyPrefetch?: Config['historyPrefetch'];
  replySuggestions?: Config['web'];
  config?: Config;
  resolver?: BackendResolver;
  scheduler?: Scheduler;
  skillsRef?: { current: Skill[] };
  discordRemoteInputRef?: { current?: DiscordRemoteInputBridge };
  host?: string;
  discoverModels?: typeof discoverBackendModels;
}

export function startWebChat(options: WebChatOptions): void {
  const { agentRunner } = options;
  const historyPrefetch = options.historyPrefetch ?? { enabled: false, count: 10 };
  const replySuggestions = options.replySuggestions ?? {
    replySuggestions: false,
    replySuggestionCount: 3,
  };
  const port = options.port || parseInt(process.env.WEB_CHAT_PORT || String(DEFAULT_PORT), 10);
  const host = options.host || process.env.WEB_CHAT_HOST || '0.0.0.0';
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  const workspaceBrowser = new WorkspaceBrowser(workdir);
  const webProjects = WebProjectStore.fromDataDir(dataDir);

  const resolveProject = (projectId: unknown) => {
    if (typeof projectId !== 'string' || !projectId.trim()) return undefined;
    const project = webProjects.get(projectId.trim());
    if (!project) throw new WebProjectError('Projectが見つかりません', 404);
    return project;
  };

  const projectBackendDefault = (
    project: ReturnType<typeof resolveProject>
  ): ChannelOverride | undefined => {
    if (!project?.backend) return undefined;
    return { backend: project.backend, model: project.model, effort: project.effort };
  };

  const parseProjectBackendSettings = (body: Record<string, unknown>) => {
    const backend = body.backend ? String(body.backend) : undefined;
    const model = body.model ? String(body.model).trim() : undefined;
    const effort = body.effort ? String(body.effort) : undefined;
    if (!backend) {
      if (model || effort) {
        throw new WebProjectError('モデルまたはeffortを設定するにはバックエンドが必要です', 400);
      }
      return { backend: null, model: null, effort: null } as const;
    }
    if (!options.resolver) {
      throw new WebProjectError('この環境ではProjectのバックエンド設定を利用できません', 503);
    }
    if (!options.resolver.isBackendAllowed(backend as AgentBackend)) {
      throw new WebProjectError(
        `許可されたバックエンドを指定してください: ${options.resolver.getAllowedBackends().join(', ')}`,
        400
      );
    }
    if (model && !options.resolver.isModelAllowed(model)) {
      throw new WebProjectError(`モデル ${model} は許可されていません`, 400);
    }
    if (effort && !supportsEffort(backend as AgentBackend, effort as EffortLevel)) {
      throw new WebProjectError(
        `${backend} のeffortは ${getSupportedEffortLevels(backend as AgentBackend).join(', ') || '未対応'} です`,
        400
      );
    }
    if (effort && requiresExplicitModelForEffort(backend as AgentBackend) && !model) {
      throw new WebProjectError(`${backend}でeffortを指定するにはモデルも必要です`, 400);
    }
    return {
      backend: backend as AgentBackend,
      model: model || null,
      effort: (effort as EffortLevel | undefined) || null,
    };
  };

  const resolveWebSessionBackend = (appSessionId: string) => {
    const entry = getSessionEntry(appSessionId);
    if (!entry || entry.platform !== 'web' || !options.resolver) return undefined;
    const project = entry.projectId ? webProjects.get(entry.projectId) : undefined;
    const projectDefault = projectBackendDefault(project);
    const contextKey = webContextKey(appSessionId);
    const resolved = options.resolver.resolve(contextKey, projectDefault);
    const source = options.resolver.getChannelOverride(contextKey)
      ? 'session'
      : projectDefault
        ? 'project'
        : 'default';
    return { ...resolved, source };
  };

  options.scheduler?.registerAgentRunner('web', async (prompt, requestedSessionId, schedule) => {
    const appSessionId =
      requestedSessionId === WEB_SCHEDULE_NEW_SESSION_ID
        ? createWebSession({
            projectId: resolveProject(schedule?.projectId)?.id,
            title: schedule?.label,
          })
        : requestedSessionId;
    const entry = getSessionEntry(appSessionId);
    if (!entry || entry.platform !== 'web') {
      throw new Error(`Web session ${appSessionId} not found`);
    }
    const contextKey = webContextKey(appSessionId);
    const project = entry.projectId ? webProjects.get(entry.projectId) : undefined;
    const backendDefault = projectBackendDefault(project);
    const result = await agentRunner.run(
      `[プラットフォーム: Web]\n${prependWebProjectPrompt(project, prompt)}`,
      {
        sessionId: getSession(contextKey),
        channelId: contextKey,
        settingsChannelId: contextKey,
        appSessionId,
        platform: 'web',
        defaultBackend: backendDefault?.backend,
        defaultModel: backendDefault?.model,
        defaultEffort: backendDefault?.effort,
      }
    );
    setSession(contextKey, result.sessionId);
    setProviderSessionId(appSessionId, result.sessionId);
    incrementMessageCount(appSessionId);
    return result.result;
  });

  const scheduleInputFromBody = (body: Record<string, unknown>): ScheduleInput => {
    const platform = String(body.platform || 'web').trim() as Platform;
    if (!['discord', 'slack', 'telegram', 'web'].includes(platform)) {
      throw new Error('platform must be discord, slack, telegram, or web');
    }
    const type = String(body.type || '');
    if (type !== 'cron' && type !== 'once' && type !== 'startup') {
      throw new Error('type must be cron, once, or startup');
    }
    const message = String(body.message || '').trim();
    if (!message) throw new Error('実行内容を入力してください');

    let channelId = String(body.channelId || body.sessionId || '').trim();
    let projectId: string | undefined;
    if (platform === 'web') {
      const project = resolveProject(body.projectId);
      channelId = WEB_SCHEDULE_NEW_SESSION_ID;
      projectId = project?.id;
    } else if (!channelId) {
      throw new Error('送信先IDを入力してください');
    }

    return {
      type,
      expression: type === 'cron' ? String(body.expression || '').trim() : undefined,
      runAt: type === 'once' ? String(body.runAt || '').trim() : undefined,
      message,
      channelId,
      platform,
      label: String(body.label || '').trim() || undefined,
      projectId,
    };
  };

  // WEB_CHAT_UPLOAD_ACCEPT: 未設定なら全許可。設定時は HTML <input accept> にそのまま渡しつつ、
  // バックエンドでも .ext 部分を抽出して拡張子検証する。MIME パターン (image/* など) は
  // フロント側のヒントとしてのみ機能し、サーバ側検証では使われない。
  const uploadAccept = (process.env.WEB_CHAT_UPLOAD_ACCEPT || '').trim();
  const uploadAllowedExts = uploadAccept
    ? uploadAccept
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.startsWith('.'))
    : [];

  // WEB_CHAT_DOWNLOAD_ACCEPT: 未設定なら全許可 (任意の拡張子はファイル名付き Content-Disposition
  // attachment でダウンロード)。設定時は許可拡張子を絞り、リスト外は 403 を返す。
  // UPLOAD_ACCEPT と同じ書式 (例: "image/*,.pdf,.mp3,.html")。
  // 拡張子部分 (`.html` 等) のみサーバ側検証で使われる。
  const downloadAccept = (process.env.WEB_CHAT_DOWNLOAD_ACCEPT || '').trim();
  const downloadAllowedExts = downloadAccept
    ? downloadAccept
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.startsWith('.'))
    : [];

  const interChatEnabled = getInterChatConfig().enabled;

  // 自走モード（auto-talk）の準備。inter-chat 有効時のみ実体起動。
  const autoTalkHandle = interChatEnabled ? setupAutoTalk({ agentRunner }) : null;

  const buildSessionsResponse = (
    query: {
      limit?: number;
      offset?: number;
      cursor?: string;
      q?: string;
      projectId?: string;
    } = {}
  ) => {
    const limit = Math.min(
      SESSION_LIST_MAX_LIMIT,
      Math.max(1, Math.floor(query.limit ?? SESSION_LIST_LIMIT))
    );
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const normalizedQuery = (query.q || '').trim().toLowerCase();

    const allManaged = listAllSessions();
    const managedIds = new Set(allManaged.map((session) => session.id));
    const managed = allManaged.map((s) => {
      const isCurrentSession = s.platform === 'web' || getActiveSessionId(s.contextKey) === s.id;
      const threadId = isCurrentSession ? sessionThreadId(s) : null;
      const activity = threadId ? getActivity(threadId) : undefined;
      const isActive = activity?.active === true;
      const timeoutState =
        isActive && s.contextKey ? agentRunner.getTimeoutState?.(s.contextKey) : undefined;
      const storedTitle = s.title || '';
      const transcriptPath = join(workdir, 'logs', 'sessions', `${s.id}.jsonl`);
      const transcriptUpdatedAt = existsSync(transcriptPath)
        ? statSync(transcriptPath).mtime.toISOString()
        : undefined;
      return {
        id: s.id,
        title: storedTitle && !hasInternalPromptMetadata(storedTitle) ? storedTitle : '',
        platform: s.platform,
        contextKey: s.contextKey,
        createdAt: s.createdAt,
        updatedAt: activity?.updatedAt
          ? new Date(activity.updatedAt).toISOString()
          : transcriptUpdatedAt || s.updatedAt,
        messageCount: s.messageCount,
        isActive,
        autoTalk: s.autoTalk === true,
        autoTalkActive: autoTalkHandle?.isActive(s.id) ?? false,
        timeoutAt: timeoutState?.active ? timeoutState.timeoutAt : undefined,
        maxTimeoutAt: timeoutState?.active ? timeoutState.maxTimeoutAt : undefined,
        timeoutMs: timeoutState?.active ? timeoutState.timeoutMs : undefined,
        activity,
        projectId: s.projectId,
        ...(s.platform === 'web' ? { backend: resolveWebSessionBackend(s.id) } : {}),
      };
    });

    const sessionsDir = join(workdir, 'logs', 'sessions');
    const unmanagedCandidates: Array<{
      id: string;
      createdAt: string;
      updatedAt: string;
    }> = [];
    if (existsSync(sessionsDir)) {
      for (const file of readdirSync(sessionsDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const id = file.replace('.jsonl', '');
        if (managedIds.has(id) || isSchedulerRunId(id)) continue;
        const stat = statSync(join(sessionsDir, file));
        unmanagedCandidates.push({
          id,
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }

    const unmanaged = unmanagedCandidates.flatMap((candidate) => {
      const title = deriveTitleFromFirstMessage(workdir, candidate.id);
      if (!title) return [];
      return [
        {
          ...candidate,
          title,
          platform: 'discord',
          contextKey: '',
          messageCount: 0,
          isActive: false,
          autoTalk: false,
          autoTalkActive: false,
          timeoutAt: undefined,
          maxTimeoutAt: undefined,
          timeoutMs: undefined,
          activity: undefined,
          projectId: undefined,
        },
      ];
    });

    const titleCache = new Map<string, string>();
    const resolveTitle = (candidate: (typeof managed)[number] | (typeof unmanaged)[number]) => {
      const cached = titleCache.get(candidate.id);
      if (cached !== undefined) return cached;
      const title =
        candidate.title ||
        deriveTitleFromFirstMessage(workdir, candidate.id) ||
        candidate.contextKey ||
        candidate.id;
      titleCache.set(candidate.id, title);
      return title;
    };

    const matching = [...managed, ...unmanaged]
      .filter((candidate) => {
        if (query.projectId === '__none__' && candidate.projectId) return false;
        if (
          query.projectId &&
          query.projectId !== '__none__' &&
          candidate.projectId !== query.projectId
        ) {
          return false;
        }
        if (!normalizedQuery) return true;
        return [
          resolveTitle(candidate),
          candidate.id,
          candidate.platform,
          candidate.contextKey,
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const cursorSeparator = query.cursor?.indexOf('\t') ?? -1;
    const cursorUpdatedAt =
      cursorSeparator >= 0 ? query.cursor?.slice(0, cursorSeparator) : undefined;
    const cursorId = cursorSeparator >= 0 ? query.cursor?.slice(cursorSeparator + 1) : undefined;
    const cursorFiltered =
      cursorUpdatedAt && cursorId
        ? matching.filter(
            (candidate) =>
              candidate.updatedAt < cursorUpdatedAt ||
              (candidate.updatedAt === cursorUpdatedAt && candidate.id < cursorId)
          )
        : matching;
    const total = matching.length;
    const pageStart = query.cursor ? 0 : offset;
    const pageCandidates = cursorFiltered.slice(pageStart, pageStart + limit);
    const sessions = pageCandidates.map((candidate) => ({
      ...candidate,
      title: resolveTitle(candidate),
    }));
    const nextOffset = offset + sessions.length;
    const hasMore = pageStart + sessions.length < cursorFiltered.length;
    const lastSession = sessions.at(-1);

    return {
      sessions,
      meta: {
        limit,
        offset,
        q: query.q || '',
        total,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        nextCursor: hasMore && lastSession ? `${lastSession.updatedAt}\t${lastSession.id}` : null,
        processCwd: process.cwd(),
        workdir,
        pid: process.pid,
        pmId: process.env.pm_id,
      },
    };
  };

  const sessionSnapshotListeners = new Set<() => void>();
  const invalidateSessionSnapshots = () => {
    if (sessionSnapshotListeners.size === 0) return;
    try {
      for (const listener of sessionSnapshotListeners) {
        try {
          listener();
        } catch {
          // A disconnected SSE client must not fail the mutation that triggered invalidation.
        }
      }
    } catch {
      // Snapshot refresh is best-effort and must not fail the completed mutation.
    }
  };

  const server = createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    const url = rawUrl.split('?')[0];

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // inter-instance-chat の HTML / API は専用ハンドラに委譲
    if (url === '/inter-chat' || url === '/inter-chat/' || url.startsWith('/api/inter-chat')) {
      try {
        const handled = await handleInterChatRequest(req, res);
        if (handled) return;
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }
    }

    // events SSE pull (consumer がここに繋ぎに来る)
    if (url === '/api/events/stream') {
      try {
        const handled = handleEventsStreamRequest(req, res);
        if (handled) return;
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }
    }

    // Even Terminal compatibility API (`@evenrealities/even-terminal`)
    if (url.startsWith('/api/')) {
      try {
        const handled = await handleEvenTerminalRequest(req, res, agentRunner);
        if (handled) return;
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }
    }

    // 外部 device からのテキスト送信 (xangi-pet / Even G2 等の consumer 側 UI から POST される)
    if (isInboxPath(url)) {
      try {
        const handled = await handlePetInboxRequest(req, res, agentRunner, replySuggestions);
        if (handled) return;
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }
    }

    if (
      url === '/' ||
      url === '/index.html' ||
      url === '/monitor' ||
      url === '/monitor.html' ||
      url === '/schedules' ||
      url === '/schedules/' ||
      url === '/workspace' ||
      url === '/workspace/' ||
      /^\/chat\/[^/]+\/?$/.test(url)
    ) {
      try {
        const htmlPath = join(__dirname, '..', 'web', 'app', 'index.html');
        const html = readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end('web/app/index.html not found');
      }
      return;
    }

    if (url.startsWith('/app/')) {
      try {
        const relativePath = decodeURIComponent(url.slice('/app/'.length));
        if (!relativePath || relativePath.includes('..') || relativePath.includes('\\')) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const assetPath = join(__dirname, '..', 'web', 'app', relativePath);
        const contentType =
          extname(assetPath) === '.js'
            ? 'text/javascript; charset=utf-8'
            : extname(assetPath) === '.css'
              ? 'text/css; charset=utf-8'
              : extname(assetPath) === '.svg'
                ? 'image/svg+xml'
                : 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(readFileSync(assetPath));
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port }));
      return;
    }

    // GET /api/config — フロント向け実行時設定
    if (url === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          uploadAccept: uploadAccept || null,
          timeoutExtendEnabled: TIMEOUT_EXTEND_ENABLED,
          interChatEnabled,
          allowedBackends: options.resolver?.getAllowedBackends() ?? [],
        })
      );
      return;
    }

    // Project設定フォーム向けの構造化モデル一覧。
    if (url === '/api/models' && req.method === 'GET') {
      if (!options.resolver) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'backend resolver is not available' }));
        return;
      }
      const backend = new URL(rawUrl, 'http://localhost').searchParams.get(
        'backend'
      ) as AgentBackend | null;
      if (!backend || !options.resolver.isBackendAllowed(backend)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `backend must be one of: ${options.resolver.getAllowedBackends().join(', ')}`,
          })
        );
        return;
      }
      const discovery = await discoverBackendModels(backend);
      const allowedModels = options.resolver.getAllowedModels();
      const models = allowedModels
        ? discovery.models.filter((model) => allowedModels.includes(model.id))
        : discovery.models;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          ...discovery,
          models,
          supportedEfforts: getSupportedEffortLevels(backend),
        })
      );
      return;
    }

    // Web automation: all supported platforms can be created and edited here. Web schedules
    // create a fresh conversation for every run, optionally inside a logical Project.
    if (url === '/api/schedules' && req.method === 'GET') {
      if (!options.scheduler) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scheduler is not available' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          schedules: options.scheduler.list(),
          enabled: options.config?.scheduler.enabled ?? process.env.SCHEDULER_ENABLED !== 'false',
          startupEnabled:
            options.config?.scheduler.startupEnabled ?? process.env.STARTUP_ENABLED !== 'false',
        })
      );
      return;
    }

    if (url === '/api/schedules' && req.method === 'POST') {
      if (!options.scheduler) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scheduler is not available' }));
        return;
      }
      try {
        const body = await readBody(req);
        const schedule = options.scheduler.add(scheduleInputFromBody(body));
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ schedule }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    const scheduleMatch = url.match(/^\/api\/schedules\/([^/]+)$/);
    if (scheduleMatch && req.method === 'PATCH') {
      if (!options.scheduler) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scheduler is not available' }));
        return;
      }
      const id = decodeURIComponent(scheduleMatch[1]);
      const current = options.scheduler.get(id);
      if (!current) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'スケジュールが見つかりません' }));
        return;
      }
      try {
        const body = await readBody(req);
        const hasContentUpdate = ['type', 'message', 'platform', 'channelId', 'projectId'].some(
          (key) => body[key] !== undefined
        );
        let schedule = hasContentUpdate
          ? options.scheduler.update(id, scheduleInputFromBody(body))
          : current;
        if (typeof body.enabled === 'boolean' && body.enabled !== schedule?.enabled) {
          schedule = options.scheduler.toggle(id);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ schedule }));
      } catch (error) {
        const status = error instanceof WebProjectError ? error.status : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (scheduleMatch && req.method === 'DELETE') {
      if (!options.scheduler) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scheduler is not available' }));
        return;
      }
      const removed = options.scheduler.remove(decodeURIComponent(scheduleMatch[1]));
      if (!removed) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'スケジュールが見つかりません' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Workspace browser/editor. Paths are always workspace-relative and validated again
    // by WorkspaceBrowser before filesystem access.
    if (url === '/api/workspace/entries' && req.method === 'GET') {
      try {
        const directory =
          new URL(rawUrl, 'http://localhost').searchParams.get('path')?.trim() || '';
        const result = await workspaceBrowser.list(directory);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(result));
      } catch (error) {
        const status = error instanceof WorkspaceBrowserError ? error.status : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (url === '/api/workspace/file' && req.method === 'GET') {
      try {
        const filePath = new URL(rawUrl, 'http://localhost').searchParams.get('path')?.trim() || '';
        const result = await workspaceBrowser.read(filePath);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(result));
      } catch (error) {
        const status = error instanceof WorkspaceBrowserError ? error.status : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (url === '/api/workspace/file' && req.method === 'PUT') {
      try {
        const body = await readBody(req);
        const result = await workspaceBrowser.write(
          typeof body.path === 'string' ? body.path : '',
          body.content,
          body.version
        );
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(result));
      } catch (error) {
        const status = error instanceof WorkspaceBrowserError ? error.status : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // GET /api/web-commands — Web入力欄の候補と引数ヒント
    if (url === '/api/web-commands' && req.method === 'GET') {
      const commandUrl = new URL(rawUrl, 'http://localhost');
      const appSessionId = commandUrl.searchParams.get('appSessionId');
      const selectedBackend = commandUrl.searchParams.get('backend') as AgentBackend | null;
      const selectedModel = commandUrl.searchParams.get('model') || undefined;
      const modelDiscovery =
        selectedBackend && options.resolver?.isBackendAllowed(selectedBackend)
          ? await (options.discoverModels ?? discoverBackendModels)(selectedBackend)
          : undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          commands: getWebCommandDefinitions({
            appSessionId: appSessionId || undefined,
            workdir,
            config: options.config,
            resolver: options.resolver,
            selectedBackend: modelDiscovery?.backend,
            selectedModel,
            modelDiscovery,
            discoverModels: options.discoverModels,
            scheduler: options.scheduler,
            skillsRef: options.skillsRef,
          }),
        })
      );
      return;
    }

    // POST /api/web-commands — Web専用アダプタでslash commandを解釈・実行
    if (url === '/api/web-commands' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const input = String(body.input || '').trim();
        if (!input.startsWith('/')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'command must start with /' }));
          return;
        }
        const commandSessionId = body.appSessionId ? String(body.appSessionId) : undefined;
        const commandSession = commandSessionId ? getSessionEntry(commandSessionId) : undefined;
        const commandProject = commandSession?.projectId
          ? webProjects.get(commandSession.projectId)
          : undefined;
        const result = await executeWebCommand(input, {
          appSessionId: commandSessionId,
          workdir,
          config: options.config,
          resolver: options.resolver,
          backendDefault: projectBackendDefault(commandProject),
          backendDefaultSource: commandProject ? `${commandProject.name} Project設定` : undefined,
          discoverModels: options.discoverModels,
          scheduler: options.scheduler,
          skillsRef: options.skillsRef,
        });

        if (result.kind === 'action' && result.action === 'restart') {
          if (!canSelfRestart(getSelfLifecyclePermission())) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error:
                  '自己再起動が無効です。XANGI_SELF_LIFECYCLE=restart-only を設定してください。',
              })
            );
            return;
          }
          if (body.confirm !== true) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...result, confirmationRequired: true }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...result, confirmationRequired: false }));
          setTimeout(() => process.exit(0), 250);
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // Web Projectは会話を束ねる論理単位。workspaceやディレクトリは作成しない。
    if (url === '/api/projects' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ projects: webProjects.list() }));
      return;
    }

    if (url === '/api/projects' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const project = webProjects.create({
          name: String(body.name || ''),
          prompt: String(body.prompt || ''),
          ...parseProjectBackendSettings(body),
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project }));
      } catch (error) {
        const status = error instanceof WebProjectError ? error.status : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    const projectMatch = url.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && req.method === 'PATCH') {
      try {
        const projectId = decodeURIComponent(projectMatch[1]);
        const body = await readBody(req);
        const hasBackendUpdate = ['backend', 'model', 'effort'].some(
          (key) => body[key] !== undefined
        );
        const project = webProjects.update(projectId, {
          name: body.name === undefined ? undefined : String(body.name),
          prompt: body.prompt === undefined ? undefined : String(body.prompt),
          ...(hasBackendUpdate ? parseProjectBackendSettings(body) : {}),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project }));
      } catch (error) {
        const status = error instanceof WebProjectError ? error.status : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // GET /api/sessions — セッション一覧
    if (url === '/api/sessions' && req.method === 'GET') {
      const searchParams = new URL(rawUrl, 'http://localhost').searchParams;
      const requestedLimit = Number(searchParams.get('limit'));
      const requestedOffset = Number(searchParams.get('offset'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          buildSessionsResponse({
            limit:
              Number.isFinite(requestedLimit) && requestedLimit > 0
                ? requestedLimit
                : SESSION_LIST_LIMIT,
            offset: Number.isFinite(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0,
            cursor: searchParams.get('cursor') || undefined,
            q: searchParams.get('q') || '',
            projectId: searchParams.get('projectId') || undefined,
          })
        )
      );
      return;
    }

    // GET /api/sessions/stream — Monitor/Web Chat 共通の軽量更新通知。
    // 初期 snapshot を即返し、その後は turn の境界イベントだけを差分送信する。
    if (url === '/api/sessions/stream' && req.method === 'GET') {
      const streamProjectId =
        new URL(rawUrl, 'http://localhost').searchParams.get('projectId') || undefined;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let closed = false;
      let backpressured = false;
      let pendingSnapshot: string | undefined;
      const writeSse = (frame: string): boolean => {
        if (closed || backpressured || res.destroyed || res.writableEnded) return false;
        try {
          const accepted = res.write(frame);
          if (!accepted) backpressured = true;
          return accepted;
        } catch {
          return false;
        }
      };
      const sendSnapshot = () => {
        const payload = JSON.stringify(buildSessionsResponse({ projectId: streamProjectId }));
        if (backpressured) {
          pendingSnapshot = payload;
          return;
        }
        writeSse(`event: sessions\ndata: ${payload}\n\n`);
      };
      const handleDrain = () => {
        backpressured = false;
        if (pendingSnapshot) {
          pendingSnapshot = undefined;
          sendSnapshot();
        }
      };
      res.on('drain', handleDrain);
      sendSnapshot();
      sessionSnapshotListeners.add(sendSnapshot);
      const unsubscribe = subscribeEvents(
        (event) => {
          if (
            event.type === 'turn.started' ||
            event.type === 'turn.complete' ||
            event.type === 'turn.aborted' ||
            event.type === 'agent.error'
          ) {
            writeSse(`event: activity\ndata: ${JSON.stringify(event)}\n\n`);
          }
        },
        { whenDisabled: true }
      );
      const pendingActivityThreads = new Set<string>();
      let activityFlushTimer: NodeJS.Timeout | undefined;
      const flushActivities = () => {
        activityFlushTimer = undefined;
        if (closed || res.destroyed || res.writableEnded) return;
        for (const threadId of pendingActivityThreads) {
          const activity = getActivity(threadId);
          if (activity) {
            writeSse(
              `event: activity_snapshot\ndata: ${JSON.stringify({ threadId, activity })}\n\n`
            );
          }
        }
        pendingActivityThreads.clear();
      };
      const unsubscribeActivity = subscribeActivity((threadId) => {
        pendingActivityThreads.add(threadId);
        activityFlushTimer ??= setTimeout(flushActivities, 150);
      });
      const keepAlive = setInterval(() => {
        writeSse(': keep-alive\n\n');
      }, 25_000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        if (activityFlushTimer) clearTimeout(activityFlushTimer);
        unsubscribe();
        unsubscribeActivity();
        sessionSnapshotListeners.delete(sendSnapshot);
        res.off('drain', handleDrain);
        pendingActivityThreads.clear();
        pendingSnapshot = undefined;
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }

    // GET /api/sessions/:id/turn-history — 永続化された途中コメント・ツール履歴を遅延取得
    // `/history` は Even Terminal の会話履歴APIが使用済みなので分離する。
    const historyMatch = url.match(/^\/api\/sessions\/([^/]+)\/turn-history$/);
    if (historyMatch && req.method === 'GET') {
      const appSessionId = decodeURIComponent(historyMatch[1]);
      const entry = getSessionEntry(appSessionId);
      const transcriptPath = join(workdir, 'logs', 'sessions', `${appSessionId}.jsonl`);
      if (!entry && !existsSync(transcriptPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      const threadId =
        (entry ? sessionThreadId(entry) : null) ||
        deriveActivityThreadIdFromFirstMessage(workdir, appSessionId);
      const requestedLimit = Number(new URL(rawUrl, 'http://localhost').searchParams.get('limit'));
      const history = threadId
        ? readTurnHistory(
            threadId,
            Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100
          )
        : [];
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ history }));
      return;
    }

    // 旧クライアント互換: ツールだけを返す従来endpointも維持する
    const toolHistoryMatch = url.match(/^\/api\/sessions\/([^/]+)\/tool-history$/);
    if (toolHistoryMatch && req.method === 'GET') {
      const appSessionId = decodeURIComponent(toolHistoryMatch[1]);
      const entry = getSessionEntry(appSessionId);
      const transcriptPath = join(workdir, 'logs', 'sessions', `${appSessionId}.jsonl`);
      if (!entry && !existsSync(transcriptPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      const threadId =
        (entry ? sessionThreadId(entry) : null) ||
        deriveActivityThreadIdFromFirstMessage(workdir, appSessionId);
      const requestedLimit = Number(new URL(rawUrl, 'http://localhost').searchParams.get('limit'));
      const tools = threadId
        ? readToolHistory(
            threadId,
            Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100
          )
        : [];
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ tools }));
      return;
    }

    // GET /api/sessions/:id — セッション詳細
    if (
      url.startsWith('/api/sessions/') &&
      !url.includes('/resume') &&
      !url.includes('/timeout') &&
      req.method === 'GET'
    ) {
      const appSessionId = decodeURIComponent(url.replace('/api/sessions/', ''));
      const entry = getSessionEntry(appSessionId);
      const searchParams = new URL(rawUrl, 'http://localhost').searchParams;
      const requestedLimit = Number(searchParams.get('limit'));
      const requestedBefore = Number(searchParams.get('before'));
      const requestedCursor = Number(searchParams.get('cursor'));
      const limit = Math.min(
        SESSION_MESSAGE_MAX_LIMIT,
        Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.floor(requestedLimit)
          : SESSION_MESSAGE_LIMIT
      );
      const before =
        Number.isFinite(requestedBefore) && requestedBefore >= 0 ? Math.floor(requestedBefore) : 0;
      const cursorMode = searchParams.has('cursor');
      const cursorPage = cursorMode
        ? readSessionMessagesPage(
            workdir,
            appSessionId,
            limit,
            Number.isFinite(requestedCursor) && requestedCursor >= 0 ? requestedCursor : undefined
          )
        : undefined;
      const rawMessages = cursorPage
        ? cursorPage.entries
        : readSessionMessagesTail(workdir, appSessionId, limit + 1, before);
      const hasMore = cursorPage?.hasMore ?? rawMessages.length > limit;
      const pageMessages = cursorPage ? rawMessages : hasMore ? rawMessages.slice(1) : rawMessages;
      const messages = pageMessages.map((m) => {
        const isObj = typeof m.content === 'object' && m.content !== null;
        const obj = isObj ? (m.content as Record<string, unknown>) : {};
        const rawContent = isObj ? (obj.result ?? JSON.stringify(m.content)) : m.content;
        const assistantReplyData =
          m.role === 'assistant'
            ? sanitizeReplySuggestionOutput(
                String(rawContent),
                loadReplySuggestionsEnabled(replySuggestions.replySuggestions),
                replySuggestions.replySuggestionCount
              )
            : undefined;
        const sanitizedUserContent =
          m.role === 'user' ? stripPromptMetadata(String(rawContent)) : '';
        const displayedUser =
          m.role === 'user'
            ? parseDisplayedUserAttachments(sanitizedUserContent, [
                join(workdir, 'tmp'),
                join(dataDir, 'media', 'attachments'),
              ])
            : { content: '', attachments: [] };
        const displayContent =
          m.role === 'user'
            ? displayedUser.content
            : m.role === 'assistant'
              ? assistantReplyData?.text || stripReplySuggestionMarkup(String(rawContent))
              : rawContent;
        return {
          id: m.id,
          role: m.role,
          content: displayContent,
          createdAt: m.createdAt,
          edited: m.edited,
          editedAt: m.editedAt,
          platformMessageId: m.platformMessageId,
          usage: isObj
            ? {
                num_turns: obj.num_turns,
                duration_ms: obj.duration_ms,
                total_cost_usd: obj.total_cost_usd,
              }
            : undefined,
          replySuggestions: assistantReplyData?.suggestions ?? [],
          attachments: displayedUser.attachments,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: appSessionId,
          title:
            (entry?.title && !hasInternalPromptMetadata(entry.title) ? entry.title : '') ||
            deriveTitleFromFirstMessage(workdir, appSessionId) ||
            messages
              .find((m) => m.role === 'user')
              ?.content?.toString()
              .slice(0, 50) ||
            appSessionId,
          platform: entry?.platform,
          messages,
          limit,
          before,
          hasMore,
          nextBefore: hasMore ? before + messages.length : null,
          nextCursor: cursorPage?.nextCursor ?? null,
        })
      );
      return;
    }

    // PATCH /api/sessions/:sid/messages/:mid — 既存メッセージの編集
    const editMsgMatch = url.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)$/);
    if (editMsgMatch && req.method === 'PATCH') {
      const appSessionId = decodeURIComponent(editMsgMatch[1]);
      const messageId = decodeURIComponent(editMsgMatch[2]);
      const body = await readBody(req);
      if (typeof body.content !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'content (string) required' }));
        return;
      }
      const updated = updateMessageContent(workdir, appSessionId, messageId, body.content);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message not found' }));
        return;
      }
      invalidateSessionSnapshots();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: updated }));
      return;
    }

    // DELETE /api/sessions/:sid/messages/:mid — メッセージ削除
    if (editMsgMatch && req.method === 'DELETE') {
      const appSessionId = decodeURIComponent(editMsgMatch[1]);
      const messageId = decodeURIComponent(editMsgMatch[2]);
      const ok = deleteTranscriptMessage(workdir, appSessionId, messageId);
      if (!ok) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message not found' }));
        return;
      }
      invalidateSessionSnapshots();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // PATCH /api/sessions/:id — タイトル・所属Project変更
    if (url.startsWith('/api/sessions/') && !url.includes('/messages/') && req.method === 'PATCH') {
      const appSessionId = decodeURIComponent(url.replace('/api/sessions/', ''));
      const body = await readBody(req);
      const entry = getSessionEntry(appSessionId);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      if (body.title) {
        updateSessionTitle(appSessionId, body.title);
      }
      if (body.projectId !== undefined) {
        if (entry.platform !== 'web') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Web会話だけProjectへ移動できます' }));
          return;
        }
        if (busySessions.has(appSessionId)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '実行中の会話はProjectへ移動できません' }));
          return;
        }
        const project = resolveProject(body.projectId);
        updateSessionProject(appSessionId, project?.id);
      }
      invalidateSessionSnapshots();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/sessions — 新規 Web セッション（既存セッションはそのまま並存）
    if (url === '/api/sessions' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const project = resolveProject(body.projectId);
        const newAppId = createWebSession({ projectId: project?.id });
        console.log(
          `[web-chat] Created new web session ${newAppId}${project ? ` in Project ${project.id}` : ''}`
        );
        invalidateSessionSnapshots();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionId: newAppId }));
      } catch (error) {
        const status = error instanceof WebProjectError ? error.status : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // POST /api/sessions/:id/resume — 既存セッションの内容を引き継いだ新 Web セッションを作る
    if (url.match(/^\/api\/sessions\/[^/]+\/resume$/) && req.method === 'POST') {
      const sourceId = decodeURIComponent(url.replace('/api/sessions/', '').replace('/resume', ''));
      const sourceEntry = getSessionEntry(sourceId);
      const providerSid = sourceEntry?.agent?.providerSessionId;

      const newAppId = createWebSession({
        title: sourceEntry?.title ? `${sourceEntry.title} (resumed)` : '',
        resumedFromSessionId: sourceId,
        projectId: sourceEntry?.projectId,
      });
      if (providerSid) {
        setSession(webContextKey(newAppId), providerSid);
      }
      console.log(`[web-chat] Resumed session ${sourceId} into new web session ${newAppId}`);
      invalidateSessionSnapshots();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: newAppId, sourceId }));
      return;
    }

    // POST /api/sessions/:id/discord-continue — Web UI から元の Discord 会話へ投稿する
    if (url.match(/^\/api\/sessions\/[^/]+\/discord-continue$/) && req.method === 'POST') {
      const sourceId = decodeURIComponent(
        url.replace('/api/sessions/', '').replace('/discord-continue', '')
      );
      const sourceEntry = getSessionEntry(sourceId);
      if (!sourceEntry || sourceEntry.platform !== 'discord') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Discordセッションが見つかりません' }));
        return;
      }
      const bridge = options.discordRemoteInputRef?.current;
      if (!bridge) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Discordが起動していません' }));
        return;
      }
      try {
        const body = await readBody(req);
        const message = String(body.message || '').trim();
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'メッセージを入力してください' }));
          return;
        }
        const result = await bridge.continueSession({ appSessionId: sourceId, message });
        invalidateSessionSnapshots();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes('処理中') ? 409 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // GET /api/sessions/:id/timeout — 現在のタイムアウト状態を取得
    // UI のサイドバー初期表示で polling せずに済むよう公開する。レスポンスは
    // {active, timeoutAt, maxTimeoutAt, remainingMs, timeoutMs} (TimeoutState 準拠)。
    if (url.match(/^\/api\/sessions\/[^/]+\/timeout$/) && req.method === 'GET') {
      const targetId = decodeURIComponent(
        url.replace('/api/sessions/', '').replace('/timeout', '')
      );
      const entry = getSessionEntry(targetId);
      if (!entry?.contextKey || !agentRunner.getTimeoutState) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: false }));
        return;
      }
      const state = agentRunner.getTimeoutState(entry.contextKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }

    // POST /api/sessions/:id/timeout/extend — 現在のリクエストのタイムアウトを延長
    // body: { additionalMs?: number }
    //   - 省略時は **残り時間を加算** (= 結果として残り時間が 2 倍になる)
    //   - 数値を渡せばそのミリ秒分加算 (上限内で)
    // 成功時 200, 進行中リクエスト無し 404, 上限超過 409, ランナー未サポート 501。
    if (url.match(/^\/api\/sessions\/[^/]+\/timeout\/extend$/) && req.method === 'POST') {
      const targetId = decodeURIComponent(
        url.replace('/api/sessions/', '').replace('/timeout/extend', '')
      );
      const entry = getSessionEntry(targetId);
      if (!entry?.contextKey) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      if (!agentRunner.extendTimeout) {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported', reason: 'runner does not support extend' }));
        return;
      }
      const body = await readBody(req);
      const rawAdditional = Number(body.additionalMs);
      // additionalMs が正の数なら指定値、そうでなければ undefined を渡して
      // runner 側の「残り時間を加算 = 2 倍」のデフォルト挙動に任せる
      const additionalMs =
        Number.isFinite(rawAdditional) && rawAdditional > 0 ? rawAdditional : undefined;
      const result = agentRunner.extendTimeout(entry.contextKey, additionalMs);
      if (result.ok) {
        // events-emitter に extended を流す (xangi-pets 等の consumer が拾えるよう)
        const platform =
          entry.platform === 'web' || entry.platform === 'discord' || entry.platform === 'slack'
            ? entry.platform
            : 'web';
        events.timeoutExtended({
          threadId: threadIdFor(platform, targetId),
          turnId: turnIdFor(platform, `extend-${Date.now()}`),
          threadLabel: entry.title || targetId,
          platform,
          timeoutAt: result.timeoutAt!,
          maxTimeoutAt: result.maxTimeoutAt!,
          timeoutMs: result.timeoutMs!,
          remainingMs: result.remainingMs!,
        });
        invalidateSessionSnapshots();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            sessionId: targetId,
            timeoutAt: result.timeoutAt,
            remainingMs: result.remainingMs,
            timeoutMs: result.timeoutMs,
            maxTimeoutAt: result.maxTimeoutAt,
          })
        );
        console.log(
          `[web-chat] Timeout extended by ${additionalMs}ms for session ${targetId} ` +
            `(platform=${entry.platform}, timeoutAt=${new Date(result.timeoutAt!).toISOString()})`
        );
        return;
      }
      if (result.reason === 'max_timeout_exceeded') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'max_timeout_exceeded',
            maxTimeoutAt: result.maxTimeoutAt,
          })
        );
        return;
      }
      // no_active_request その他
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.reason || 'no_active_request' }));
      return;
    }

    // POST /api/sessions/:id/stop — ランナーだけ停止（セッションは残す）
    // Web/Discord/Slack 共通。entry.contextKey をそのまま runner pool のキーとして使う。
    if (url.match(/^\/api\/sessions\/[^/]+\/stop$/) && req.method === 'POST') {
      const targetId = decodeURIComponent(url.replace('/api/sessions/', '').replace('/stop', ''));
      const entry = getSessionEntry(targetId);
      let stopped = false;
      if (entry?.contextKey) {
        // 進行中の処理があれば cancel、その上で runner プロセスを破棄
        agentRunner.cancel?.(entry.contextKey);
        stopped = Boolean(agentRunner.destroy?.(entry.contextKey));
      }
      busySessions.delete(targetId);
      console.log(
        `[web-chat] Stopped runner for session ${targetId} ` +
          `(platform=${entry?.platform}, stopped=${stopped})`
      );
      invalidateSessionSnapshots();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stopped }));
      return;
    }

    // POST /api/sessions/:id/autotalk — 自走モード ON/OFF
    // body: { enabled: boolean }
    if (url.match(/^\/api\/sessions\/[^/]+\/autotalk$/) && req.method === 'POST') {
      const targetId = decodeURIComponent(
        url.replace('/api/sessions/', '').replace('/autotalk', '')
      );
      const body = await readBody(req);
      const enabled = body.enabled === true;
      const entry = getSessionEntry(targetId);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      if (entry.platform !== 'web') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'autotalk is only available for web sessions' }));
        return;
      }
      const interCfg = getInterChatConfig();
      if (!interCfg.enabled) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              'INTER_INSTANCE_CHAT_ENABLED=true が必要です（自走発話は inter-chat に流れます）',
          })
        );
        return;
      }
      setAutoTalk(targetId, enabled);
      if (autoTalkHandle) {
        if (enabled) autoTalkHandle.enable(targetId);
        else autoTalkHandle.disable(targetId);
      }
      console.log(`[web-chat] autotalk ${enabled ? 'ON' : 'OFF'} for session ${targetId}`);
      invalidateSessionSnapshots();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          appSessionId: targetId,
          autoTalk: enabled,
          active: autoTalkHandle?.isActive(targetId) ?? false,
        })
      );
      return;
    }

    // DELETE /api/sessions/:id — セッション削除
    if (
      url.startsWith('/api/sessions/') &&
      !url.includes('/resume') &&
      !url.includes('/stop') &&
      !url.includes('/autotalk') &&
      !url.includes('/messages/') &&
      req.method === 'DELETE'
    ) {
      const targetId = decodeURIComponent(url.replace('/api/sessions/', ''));
      const entry = getSessionEntry(targetId);
      // ランナーも破棄（web セッションの場合のみ）
      if (entry?.platform === 'web') {
        agentRunner.destroy?.(webContextKey(targetId));
      }
      removeSession(targetId);
      busySessions.delete(targetId);

      const logPath = join(workdir, 'logs', 'sessions', `${targetId}.jsonl`);
      if (existsSync(logPath)) {
        const { unlinkSync } = await import('fs');
        unlinkSync(logPath);
      }

      console.log(`[web-chat] Deleted session ${targetId}`);
      invalidateSessionSnapshots();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/upload — ファイルアップロード
    if (url === '/api/upload' && req.method === 'POST') {
      try {
        const uploadDir = join(workdir, 'tmp', 'web-uploads');
        mkdirSync(uploadDir, { recursive: true });
        const maxBytes = uploadMaxBytes();
        const declaredBytes = Number(req.headers['content-length']);
        if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upload too large', maxBytes }));
          req.resume();
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.length;
          if (receivedBytes > maxBytes) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Upload too large', maxBytes }));
            req.resume();
            return;
          }
          chunks.push(buffer);
        }
        const body = Buffer.concat(chunks);

        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No boundary in content-type' }));
          return;
        }
        const boundary = '--' + boundaryMatch[1];
        const parts = body.toString('binary').split(boundary);

        const files: { name: string; path: string }[] = [];
        const rejected: { name: string; reason: string }[] = [];
        for (const part of parts) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          const headers = part.slice(0, headerEnd);
          const filenameMatch = headers.match(/filename="([^"]+)"/);
          if (!filenameMatch) continue;

          // filename はここまで body.toString('binary') の 1 バイト=1 文字
          // 表現になっているので、UTF-8 として再デコードしないと日本語名が化ける。
          const filename = Buffer.from(filenameMatch[1], 'binary').toString('utf8');
          const ext = extname(filename).toLowerCase();

          if (uploadAllowedExts.length > 0 && !uploadAllowedExts.includes(ext)) {
            rejected.push({
              name: filename,
              reason: `Extension ${ext || '(none)'} not in WEB_CHAT_UPLOAD_ACCEPT allowlist`,
            });
            continue;
          }

          const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
          const filePath = join(uploadDir, safeName);

          const dataStart = headerEnd + 4;
          const dataEnd = part.length - 2;
          const fileData = Buffer.from(part.slice(dataStart, dataEnd), 'binary');
          writeFileSync(filePath, fileData);

          files.push({ name: filename, path: filePath });
        }

        if (files.length === 0 && rejected.length > 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'All files rejected', rejected }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files, rejected }));
      } catch (err) {
        console.error('[web-chat] Upload error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upload failed' }));
      }
      return;
    }

    if (url.startsWith('/api/files/') && req.method === 'GET') {
      const filename = decodeURIComponent(url.replace('/api/files/', ''));
      const uploadDir = join(workdir, 'tmp', 'web-uploads');
      const filePath = join(uploadDir, filename);
      if (
        !existsSync(filePath) ||
        filename.includes('..') ||
        !isRealFileWithin(uploadDir, filePath)
      ) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8',
        '.csv': 'text/csv; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8',
        '.yaml': 'application/x-yaml; charset=utf-8',
        '.yml': 'application/x-yaml; charset=utf-8',
        '.zip': 'application/zip',
      };
      // 拡張子に対応する mime があれば inline 表示、無ければ Content-Disposition: attachment で
      // ファイル名付きダウンロードに落とす (LLM が出力する任意拡張子のファイルでも開ける)
      const mappedMime = mimeTypes[ext];
      const headers: Record<string, string> = {
        'Content-Type': mappedMime || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      };
      if (!mappedMime || ACTIVE_DOWNLOAD_EXTENSIONS.has(ext)) {
        const filename = basename(filePath);
        headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`;
      }
      res.writeHead(200, headers);
      res.end(readFileSync(filePath));
      return;
    }

    if (url.startsWith('/api/workspace-file') && req.method === 'GET') {
      const urlObj = new URL(rawUrl, 'http://localhost');
      const requestedPath = urlObj.searchParams.get('path') || '';
      if (!requestedPath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const filePath = isAbsolute(requestedPath)
        ? resolve(requestedPath)
        : resolve(workdir, requestedPath);
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      if (
        !isRealFileWithin(workdir, filePath) &&
        !isRealFileWithin(join(dataDir, 'media', 'attachments'), filePath)
      ) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      // WEB_CHAT_DOWNLOAD_ACCEPT で許可拡張子が絞られているならチェック
      if (downloadAllowedExts.length > 0 && !downloadAllowedExts.includes(ext)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Forbidden',
            reason: `Extension ${ext || '(none)'} not in WEB_CHAT_DOWNLOAD_ACCEPT allowlist`,
          })
        );
        return;
      }
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.ts': 'text/plain; charset=utf-8',
        '.tsx': 'text/plain; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8',
        '.csv': 'text/csv; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8',
        '.yaml': 'application/x-yaml; charset=utf-8',
        '.yml': 'application/x-yaml; charset=utf-8',
        '.zip': 'application/zip',
      };
      // 拡張子に対応する mime があれば inline 表示、無ければ Content-Disposition: attachment で
      // ファイル名付きダウンロードに落とす (LLM が出力する任意拡張子のファイルでも開ける)
      const mappedMime = mimeTypes[ext];
      const headers: Record<string, string> = {
        'Content-Type': mappedMime || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      };
      if (!mappedMime || ACTIVE_DOWNLOAD_EXTENSIONS.has(ext)) {
        const filename = basename(filePath);
        headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`;
      }
      res.writeHead(200, headers);
      res.end(readFileSync(filePath));
      return;
    }

    // POST /api/chat — メッセージ送信（SSE）
    // body: { appSessionId?: string, message: string }
    if (url === '/api/chat' && req.method === 'POST') {
      const requestReceivedAt = Date.now();
      try {
        const body = await readBody(req);
        const message = (body.message || '').toString();

        if (!message.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message is required' }));
          return;
        }

        // appSessionId 解決
        let appSessionId: string = (body.appSessionId || '').toString().trim();
        if (!appSessionId) {
          // 後方互換: 最後に更新された web セッションを使う、なければ新規作成
          const latestWeb = listAllSessions().find((s) => s.platform === 'web');
          appSessionId = latestWeb?.id || createWebSession({});
        }

        // entry 確認 / web 以外への送信は弾く
        const entry = getSessionEntry(appSessionId);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Session ${appSessionId} not found` }));
          return;
        }
        if (entry.platform !== 'web') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `Session ${appSessionId} is not a web session (platform: ${entry.platform}). Use the resume endpoint to fork it.`,
            })
          );
          return;
        }

        // 並行送信ロック
        if (busySessions.has(appSessionId)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session is busy' }));
          return;
        }
        busySessions.add(appSessionId);

        try {
          const ctxKey = webContextKey(appSessionId);
          // 安全網: contextKey と active が紐付いていることを保証
          ensureSession(ctxKey, { platform: 'web' });
          const sessionId = getSession(ctxKey);
          const project = entry.projectId ? webProjects.get(entry.projectId) : undefined;
          const backendDefault = projectBackendDefault(project);
          const resolvedBackend = options.resolver?.resolve(ctxKey, backendDefault);
          const providerBackendChanged = Boolean(
            sessionId &&
            entry.agent?.backend &&
            resolvedBackend &&
            entry.agent.backend !== resolvedBackend.backend
          );

          // provider セッションが無い初回、または Project 移動で backend が変わった時は
          // 直近履歴を先読みする。backend 変更時は通常の先読み設定が無効でも会話を引き継ぐ。
          // 新規 Web セッションは空履歴ブロックを入れ、初期確認目的の
          // web_history 二重実行を避ける。
          let historyContext = '';
          const resumeSourceId = entry.resumedFromSessionId;
          const hasExplicitResumeHistory = Boolean(resumeSourceId);
          const shouldPrefetchFirstTurn =
            providerBackendChanged || (historyPrefetch.enabled && !sessionId);
          if (hasExplicitResumeHistory || shouldPrefetchFirstTurn) {
            const pastMessages = readSessionMessages(workdir, resumeSourceId || appSessionId);
            const sourcePlatform = resumeSourceId
              ? getSessionEntry(resumeSourceId)?.platform
              : undefined;
            const historyPlatform =
              sourcePlatform === 'discord'
                ? 'Discord'
                : sourcePlatform === 'slack'
                  ? 'Slack'
                  : 'Web';
            const recent = pastMessages.slice(-historyPrefetch.count);
            const entries = recent.map((m, index) => {
              const content =
                typeof m.content === 'object'
                  ? ((m.content as Record<string, unknown>).result as string) || ''
                  : String(m.content);
              return {
                timestamp: new Date(m.createdAt),
                id: m.id || `web-history-${index}`,
                author: m.role === 'user' ? 'ユーザー' : 'AI',
                content: stripPromptMetadata(content),
              };
            });
            historyContext = `${buildPrefetchedHistoryBlock(historyPlatform, entries)}\n\n`;
          }

          let prompt = `[プラットフォーム: Web]\n${prependWebProjectPrompt(
            project,
            `${historyContext}${message}`
          )}`;
          const replySuggestionsEnabled = loadReplySuggestionsEnabled(
            replySuggestions.replySuggestions
          );
          if (replySuggestionsEnabled) {
            prompt = appendReplySuggestionInstruction(
              prompt,
              replySuggestions.replySuggestionCount
            );
          }

          console.log(`[web-chat] Message (session ${appSessionId}): ${message.slice(0, 100)}`);

          // INTER_INSTANCE_CHAT_ENABLED=true なら自分の jsonl にも流す（他 xangi へ伝播）
          flowFromHostPlatform(message, 'user');

          const threadId = threadIdFor('web', appSessionId);
          const turnId = turnIdFor('web', `${Date.now()}`);
          const sessionTitle = getSessionEntry(appSessionId)?.title;
          const threadLabel = sessionTitle || 'Browser session';
          const eventCtx = {
            threadId,
            turnId,
            threadLabel,
            platform: 'web' as const,
            userText: message,
          };
          const latency = new TurnLatencyRecorder({
            platform: 'web',
            turnId,
            threadId,
            firstTurn: !sessionId,
            receivedAt: requestReceivedAt,
            workdir,
          });

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          latency.markInitialReply();

          const sendSSE = (event: string, data: unknown) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };

          let lastStreamText = '';
          const unregisterStreamFinalizer = registerStreamFinalizer(() => {
            const note = '⏸ プロセス再起動により中断されました';
            const partialText = stripReplySuggestionMarkup(lastStreamText).trimEnd();
            const interruptedText = partialText ? `${partialText}\n\n${note}` : note;
            const stored = ensureVisibleAssistantResponse(
              workdir,
              appSessionId,
              undefined,
              interruptedText
            );
            const storedResult =
              stored && typeof stored.content === 'object'
                ? (stored.content as Record<string, unknown>).result
                : undefined;
            const responseText =
              typeof storedResult === 'string' && storedResult ? storedResult : interruptedText;

            invalidateSessionSnapshots();
            sendSSE('text', { fullText: responseText });
            sendSSE('done', {
              response: responseText,
              replySuggestions: [],
              sessionId: appSessionId,
              assistantMessageId: stored?.id,
            });
          });

          // ランナーから timeout 状態を chat SSE に流す。
          // PersistentRunner / RunnerManager は EventEmitter で
          // timeout-started / timeout-extended / timeout-cleared を emit するので、
          // ctxKey (= channelId) で filter してフロントに渡す。
          // Local LLM 等の非 EventEmitter ランナーは on が無いので no-op。
          const runnerEmitter =
            typeof (agentRunner as unknown as { on?: unknown }).on === 'function'
              ? (agentRunner as unknown as {
                  on: (e: string, l: (p: unknown) => void) => void;
                  off: (e: string, l: (p: unknown) => void) => void;
                })
              : null;
          const timeoutListeners: Array<{ event: string; handler: (p: unknown) => void }> = [];
          if (runnerEmitter) {
            const makeHandler = (sseEvent: 'timeout' | 'timeout_cleared') => (payload: unknown) => {
              const p = payload as {
                channelId?: string;
                timeoutAt?: number;
                maxTimeoutAt?: number;
                timeoutMs?: number;
                remainingMs?: number;
              };
              if (p.channelId !== ctxKey) return;
              if (sseEvent === 'timeout_cleared') {
                sendSSE('timeout_cleared', { sessionId: appSessionId });
              } else {
                sendSSE('timeout', {
                  sessionId: appSessionId,
                  timeoutAt: p.timeoutAt,
                  maxTimeoutAt: p.maxTimeoutAt,
                  timeoutMs: p.timeoutMs,
                  remainingMs: p.remainingMs,
                });
              }
            };
            const startedHandler = makeHandler('timeout');
            const extendedHandler = makeHandler('timeout');
            const clearedHandler = makeHandler('timeout_cleared');
            runnerEmitter.on('timeout-started', startedHandler);
            runnerEmitter.on('timeout-extended', extendedHandler);
            runnerEmitter.on('timeout-cleared', clearedHandler);
            timeoutListeners.push(
              { event: 'timeout-started', handler: startedHandler },
              { event: 'timeout-extended', handler: extendedHandler },
              { event: 'timeout-cleared', handler: clearedHandler }
            );
          }

          try {
            latency.markAgentStart();
            const result = await runWithBubbleEvents(
              agentRunner,
              prompt,
              eventCtx,
              {
                onBackendReady: () => latency.markBackendReady(),
                onText: (_chunk, fullText) => {
                  latency.markText();
                  lastStreamText = fullText;
                  sendSSE('text', { fullText: stripReplySuggestionMarkup(fullText) });
                },
                onToolUse: (toolName, toolInput) => {
                  latency.markActivity();
                  const inputSummary =
                    Object.keys(toolInput).length > 0
                      ? ` ${JSON.stringify(toolInput).slice(0, 100)}`
                      : '';
                  sendSSE('tool', { toolName, inputSummary });
                },
                onComplete: (completedResult) => {
                  latency.markAgentComplete();
                  if (resumeSourceId) {
                    clearResumedFromSessionId(appSessionId);
                  }
                  setProviderSessionId(appSessionId, completedResult.sessionId);
                  setSession(ctxKey, completedResult.sessionId);
                  incrementMessageCount(appSessionId);

                  const e = getSessionEntry(appSessionId);
                  if (!e?.title) {
                    updateSessionTitle(appSessionId, message.slice(0, 50));
                  }
                  invalidateSessionSnapshots();

                  // INTER_INSTANCE_CHAT_ENABLED=true なら agent 応答も自分の jsonl に流す
                  flowFromHostPlatform(stripReplySuggestionMarkup(completedResult.result), 'agent');
                },
                onError: (error) => {
                  sendSSE('error', { message: error.message });
                },
              },
              {
                sessionId,
                channelId: ctxKey,
                appSessionId,
                platform: 'web',
                defaultBackend: backendDefault?.backend,
                defaultModel: backendDefault?.model,
                defaultEffort: backendDefault?.effort,
                skipPermissions: body.skipPermissions === true ? true : undefined,
              }
            );

            const msgs = readSessionMessages(workdir, appSessionId);
            const reversed = [...msgs].reverse();
            const lastAssistant = reversed.find((m) => m.role === 'assistant');
            const lastUser = reversed.find((m) => m.role === 'user');
            const usageObj =
              lastAssistant && typeof lastAssistant.content === 'object'
                ? (lastAssistant.content as Record<string, unknown>)
                : {};
            const usage = {
              num_turns: usageObj.num_turns,
              duration_ms: usageObj.duration_ms,
              total_cost_usd: usageObj.total_cost_usd,
            };

            const extracted = sanitizeReplySuggestionOutput(
              result.result,
              replySuggestionsEnabled,
              replySuggestions.replySuggestionCount
            );
            if (replySuggestionsEnabled && extracted.suggestions.length === 0) {
              extracted.suggestions = fallbackReplySuggestions(
                replySuggestions.replySuggestionCount
              );
            }
            sendSSE('done', {
              response: extracted.text,
              replySuggestions: extracted.suggestions,
              sessionId: appSessionId,
              usage,
              userMessageId: lastUser?.id,
              assistantMessageId: lastAssistant?.id,
            });
            latency.finish('complete');
          } catch (err) {
            latency.markAgentComplete();
            const errorMsg = err instanceof Error ? err.message : String(err);
            sendSSE('error', { message: errorMsg });
            latency.finish(errorMsg === 'Request cancelled by user' ? 'cancelled' : 'error');
          } finally {
            unregisterStreamFinalizer();
            // timeout listener を必ず解除 (res.end 前のリーク防止)
            if (runnerEmitter) {
              for (const l of timeoutListeners) {
                runnerEmitter.off(l.event, l.handler);
              }
            }
          }
          res.end();
        } finally {
          busySessions.delete(appSessionId);
        }
      } catch (err) {
        console.error('[web-chat] Error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, host, () => {
    // 冒頭行も実際に到達できる URL に合わせる（specific IP bind なら localhost は誤誘導）。
    console.log(`[web-chat] Chat UI: ${primaryAccessUrl(port, host)}`);
    // Tailscale が動いてれば LAN/Tailnet 経由のアクセス URL も出す（best-effort）。
    // host を loopback / 特定 IP に絞っている場合は到達できない経路を出さないよう、
    // resolveAccessUrls 側で表示範囲を host 種別に合わせる。
    resolveAccessUrls(port, host)
      .then((urls) => {
        console.log(formatAccessUrls('web-chat', urls));
        // pull 型 events SSE の URL も併せて出す。consumer (pet 等) はこれに繋ぐ。
        const eventsUrls = urls.map((u) => `${u}/api/events/stream`);
        console.log(formatAccessUrls('xangi-events (SSE)', eventsUrls));
      })
      .catch(() => {
        // resolveAccessUrls 内で握り潰すが念のため
      });
  });
}

// 単体テストから参照される
export const __test__ = {
  busySessions,
  webContextKey,
  isWebSession,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readBody(req: import('http').IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
