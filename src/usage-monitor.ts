import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { CopilotClient } from '@github/copilot-sdk';
import { configuredBackendCommand } from './setup/backend-executable.js';
import { getSafeEnv } from './safe-env.js';
import { updateSessionContextUsageByProviderSession } from './sessions.js';

const TIMEOUT_MS = 5000;
// claude CLI ships a larger Node bundle than codex, so allow more headroom for cold start
// (a warm call round-trips get_usage in ~1.8s, but first-run JIT/module load can be slower).
const CLAUDE_TIMEOUT_MS = 10_000;
const CACHE_MS = 30_000;

export interface UsageWindow {
  label: string;
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface AccountUsageGroup {
  id: string;
  label: string;
  planType?: string;
  windows: UsageWindow[];
}

export interface AccountUsageResponse {
  providers: AccountUsageProvider[];
  updatedAt: string;
  stale?: boolean;
}

export interface AccountUsageProvider {
  id: 'codex' | 'antigravity' | 'github-copilot' | 'claude-code';
  label: string;
  groups: AccountUsageGroup[];
}

interface AntigravityStatusPayload {
  conversation_id?: string;
  plan_tier?: string;
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  quota?: Record<
    string,
    { remaining_fraction?: number; reset_time?: string; reset_in_seconds?: number }
  >;
}

type CommandRunner = (input: string, done: (stdout: string) => boolean) => Promise<string>;

function runJsonLinesProbe(
  command: string,
  args: string[],
  label: string,
  timeoutMs: number,
  input: string,
  done: (stdout: string) => boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = getSafeEnv();
    const child = spawn(configuredBackendCommand(command, env), args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => finish(new Error(`${label} timed out`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (done(stdout)) finish();
    });
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (!settled)
        finish(code === 0 ? undefined : new Error(stderr.trim() || `${command} exited ${code}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.write(input);
  });
}

function runCodexAppServer(input: string, done: (stdout: string) => boolean): Promise<string> {
  return runJsonLinesProbe('codex', ['app-server'], 'Codex usage probe', TIMEOUT_MS, input, done);
}

function runClaudeCli(input: string, done: (stdout: string) => boolean): Promise<string> {
  return runJsonLinesProbe(
    'claude',
    [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      // 枠の取得だけが目的なので、MCPサーバの起動とセッション記録は行わない
      '--strict-mcp-config',
      '--no-session-persistence',
    ],
    'Claude usage probe',
    CLAUDE_TIMEOUT_MS,
    input,
    done
  );
}

function jsonLines(output: string): unknown[] {
  return output.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

export function parseCodexRateLimits(output: string): AccountUsageGroup[] {
  const envelope = jsonLines(output).find((value) => (value as { id?: number }).id === 3) as
    | { result?: { rateLimits?: unknown; rateLimitsByLimitId?: Record<string, unknown> } }
    | undefined;
  const snapshots = [
    envelope?.result?.rateLimits,
    ...Object.values(envelope?.result?.rateLimitsByLimitId ?? {}),
  ].filter(Boolean) as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  return snapshots.flatMap((snapshot, index) => {
    const snapshotId = String(snapshot.limitId ?? `default-${index}`);
    if (seen.has(snapshotId)) return [];
    seen.add(snapshotId);
    const windows = [
      ['Primary', snapshot.primary],
      ['Secondary', snapshot.secondary],
    ].flatMap(([fallback, raw]) => {
      if (!raw || typeof raw !== 'object') return [];
      const window = raw as Record<string, unknown>;
      if (typeof window.usedPercent !== 'number') return [];
      return [
        {
          label:
            typeof window.windowDurationMins === 'number'
              ? formatWindowLabel(window.windowDurationMins)
              : String(fallback),
          usedPercent: window.usedPercent,
          windowDurationMins:
            typeof window.windowDurationMins === 'number' ? window.windowDurationMins : undefined,
          resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt : undefined,
        },
      ];
    });
    if (!windows.length) return [];
    return [
      {
        id: snapshotId,
        label: String(
          snapshot.limitName ?? (index === 0 ? 'Codex' : (snapshot.limitId ?? 'Codex'))
        ),
        planType: typeof snapshot.planType === 'string' ? snapshot.planType : undefined,
        windows,
      },
    ];
  });
}

function formatWindowLabel(minutes: number): string {
  if (minutes === 300) return '5時間';
  if (minutes === 10_080) return '週次';
  if (minutes % 1440 === 0) return `${minutes / 1440}日`;
  if (minutes % 60 === 0) return `${minutes / 60}時間`;
  return `${minutes}分`;
}

export function parseCodexContextUsage(
  output: string
): { usedTokens: number; contextWindow: number } | undefined {
  for (const value of jsonLines(output)) {
    const event = value as {
      method?: string;
      params?: { tokenUsage?: { last?: { totalTokens?: number }; modelContextWindow?: number } };
    };
    if (event.method !== 'thread/tokenUsage/updated') continue;
    const usedTokens = event.params?.tokenUsage?.last?.totalTokens;
    const contextWindow = event.params?.tokenUsage?.modelContextWindow;
    if (typeof usedTokens === 'number' && typeof contextWindow === 'number')
      return { usedTokens, contextWindow };
  }
  return undefined;
}

export function parseCodexRolloutContextUsage(
  output: string,
  threadId: string
): { usedTokens: number; contextWindow: number } | undefined {
  let sessionMatches = false;
  let usage: { usedTokens: number; contextWindow: number } | undefined;
  for (const value of jsonLines(output)) {
    const event = value as {
      type?: string;
      payload?: {
        type?: string;
        id?: string;
        session_id?: string;
        info?: {
          last_token_usage?: { total_tokens?: number };
          model_context_window?: number;
        };
      };
    };
    if (event.type === 'session_meta') {
      sessionMatches = (event.payload?.id ?? event.payload?.session_id) === threadId;
    }
    if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
    const usedTokens = event.payload.info?.last_token_usage?.total_tokens;
    const contextWindow = event.payload.info?.model_context_window;
    if (typeof usedTokens === 'number' && typeof contextWindow === 'number') {
      usage = { usedTokens, contextWindow };
    }
  }
  return sessionMatches ? usage : undefined;
}

function parseCodexResume(output: string): { codexHome: string; path: string } | undefined {
  const lines = jsonLines(output);
  const initialized = lines.find((value) => (value as { id?: number }).id === 1) as
    { result?: { codexHome?: string } } | undefined;
  const resumed = lines.find((value) => (value as { id?: number }).id === 2) as
    { result?: { thread?: { path?: string } } } | undefined;
  const codexHome = initialized?.result?.codexHome;
  const path = resumed?.result?.thread?.path;
  return typeof codexHome === 'string' && typeof path === 'string'
    ? { codexHome, path }
    : undefined;
}

let cached: AccountUsageResponse | undefined;

export function parseCopilotQuota(result: unknown, now = Date.now()): AccountUsageGroup[] {
  const snapshots = (result as { quotaSnapshots?: Record<string, Record<string, unknown>> })
    ?.quotaSnapshots;
  if (!snapshots) return [];
  const labels: Record<string, string> = {
    chat: 'Chat / AI Credits',
    completions: 'Completions',
    premium_interactions: 'Premium requests',
  };
  const windows = Object.entries(snapshots).flatMap(([id, snapshot]) => {
    if (snapshot.hasQuota === false || typeof snapshot.remainingPercentage !== 'number') return [];
    const resetMs =
      typeof snapshot.resetDate === 'string' ? Date.parse(snapshot.resetDate) : Number.NaN;
    return [
      {
        label: labels[id] ?? id,
        usedPercent: Number(
          Math.min(100, Math.max(0, 100 - snapshot.remainingPercentage)).toFixed(6)
        ),
        resetsAt: Number.isFinite(resetMs) && resetMs > now ? resetMs / 1000 : undefined,
      },
    ];
  });
  return windows.length ? [{ id: 'copilot', label: 'GitHub Copilot', windows }] : [];
}

export function parseAntigravityStatus(payload: unknown): {
  groups: AccountUsageGroup[];
  conversationId?: string;
  context?: { usedTokens: number; contextWindow: number };
} {
  const status = payload as AntigravityStatusPayload;
  const quotaLabels: Record<string, string> = {
    'gemini-weekly': 'Geminiモデル',
    '3p-weekly': 'サードパーティモデル',
  };
  const groups = Object.entries(status?.quota ?? {}).flatMap(([id, quota]) => {
    if (typeof quota.remaining_fraction !== 'number') return [];
    const resetMs = quota.reset_time ? Date.parse(quota.reset_time) : Number.NaN;
    const label = /week/i.test(id) ? '週次' : id;
    return [
      {
        id,
        label: quotaLabels[id] ?? id,
        planType: status.plan_tier,
        windows: [
          {
            label,
            usedPercent: Math.min(100, Math.max(0, (1 - quota.remaining_fraction) * 100)),
            resetsAt: Number.isFinite(resetMs) ? resetMs / 1000 : undefined,
          },
        ],
      },
    ];
  });
  const contextWindow = status?.context_window?.context_window_size;
  const current = status?.context_window?.current_usage;
  const usedTokens =
    typeof status?.context_window?.used_percentage === 'number' && typeof contextWindow === 'number'
      ? Math.round((status.context_window.used_percentage / 100) * contextWindow)
      : current
        ? (current.input_tokens ?? 0) +
          (current.output_tokens ?? 0) +
          (current.cache_creation_input_tokens ?? 0) +
          (current.cache_read_input_tokens ?? 0)
        : undefined;
  return {
    groups,
    conversationId: status?.conversation_id,
    context:
      typeof usedTokens === 'number' && typeof contextWindow === 'number' && contextWindow > 0
        ? { usedTokens, contextWindow }
        : undefined,
  };
}

interface ClaudeRateLimitWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface ClaudeUsageResponse {
  subscription_type?: unknown;
  rate_limits_available?: unknown;
  rate_limits?: {
    five_hour?: ClaudeRateLimitWindow;
    seven_day?: ClaudeRateLimitWindow;
    model_scoped?: Array<ClaudeRateLimitWindow & { display_name?: unknown }>;
  } | null;
}

function claudeUsageWindow(
  label: string,
  raw: ClaudeRateLimitWindow | undefined,
  windowDurationMins: number
): UsageWindow[] {
  if (!raw || typeof raw.utilization !== 'number') return [];
  const resetMs = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : Number.NaN;
  return [
    {
      label,
      usedPercent: Math.min(100, Math.max(0, raw.utilization)),
      windowDurationMins,
      resetsAt: Number.isFinite(resetMs) ? resetMs / 1000 : undefined,
    },
  ];
}

export function parseClaudeUsage(output: string): AccountUsageGroup[] {
  const envelope = jsonLines(output).find(
    (value) =>
      (value as { type?: string }).type === 'control_response' &&
      (value as { response?: { request_id?: string } }).response?.request_id === '1'
  ) as { response?: { subtype?: string; response?: ClaudeUsageResponse } } | undefined;
  if (envelope?.response?.subtype !== 'success') return [];
  const payload = envelope.response.response;
  if (payload?.rate_limits_available !== true) return [];
  const rateLimits = payload.rate_limits;
  if (!rateLimits || typeof rateLimits !== 'object') return [];

  // model_scoped はCLIのスキーマ上「モデル別の週次枠」なので、週次と同じ期間長を割り当てる
  const modelScoped = Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : [];
  const windows: UsageWindow[] = [
    ...claudeUsageWindow(formatWindowLabel(300), rateLimits.five_hour, 300),
    ...claudeUsageWindow(formatWindowLabel(10_080), rateLimits.seven_day, 10_080),
    ...modelScoped.flatMap((entry) =>
      typeof entry.display_name === 'string'
        ? claudeUsageWindow(`${entry.display_name}週次`, entry, 10_080)
        : []
    ),
  ];
  if (!windows.length) return [];
  return [
    {
      id: 'claude',
      label: 'アカウント枠',
      planType:
        typeof payload.subscription_type === 'string' ? payload.subscription_type : undefined,
      windows,
    },
  ];
}

async function readCopilotUsage(): Promise<AccountUsageProvider> {
  const client = new CopilotClient();
  try {
    await client.start();
    const groups = parseCopilotQuota(await client.rpc.account.getQuota({}));
    if (!groups.length) throw new Error('Copilot SDK returned no account quota');
    return { id: 'github-copilot', label: 'GitHub Copilot', groups };
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function readAntigravityUsage(): Promise<AccountUsageProvider> {
  const dataDir =
    process.env.DATA_DIR || resolve(process.env.WORKSPACE_PATH || process.cwd(), '.xangi');
  const payload = JSON.parse(await readFile(join(dataDir, 'antigravity-status.json'), 'utf8'));
  const parsed = parseAntigravityStatus(payload);
  const groups = parsed.groups;
  if (parsed.conversationId && parsed.context) {
    updateSessionContextUsageByProviderSession('antigravity', parsed.conversationId, {
      ...parsed.context,
      source: 'antigravity-statusline',
    });
  }
  if (!groups.length) throw new Error('Antigravity status payload has no quota');
  return { id: 'antigravity', label: 'Antigravity', groups };
}

export async function readClaudeUsage(
  runner: CommandRunner = runClaudeCli
): Promise<AccountUsageProvider> {
  const input =
    JSON.stringify({
      type: 'control_request',
      request_id: '1',
      request: { subtype: 'get_usage' },
    }) + '\n';
  const output = await runner(input, (value) =>
    jsonLines(value).some(
      (item) =>
        (item as { type?: string }).type === 'control_response' &&
        (item as { response?: { request_id?: string } }).response?.request_id === '1'
    )
  );
  const groups = parseClaudeUsage(output);
  if (!groups.length) throw new Error('Claude Code returned no account rate limits');
  return { id: 'claude-code', label: 'Claude Code', groups };
}

export async function readAccountUsage(
  runner: CommandRunner = runCodexAppServer,
  readers: Array<() => Promise<AccountUsageProvider>> = [
    readCopilotUsage,
    readAntigravityUsage,
    readClaudeUsage,
  ]
): Promise<AccountUsageResponse> {
  if (cached && Date.now() - Date.parse(cached.updatedAt) < CACHE_MS) return cached;
  const input =
    [
      {
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: {
            name: 'xangi-usage-monitor',
            title: 'xangi usage monitor',
            version: '0.1.0',
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method: 'initialized', params: {} },
      { method: 'account/rateLimits/read', id: 3 },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n';
  const codexReader = async (): Promise<AccountUsageProvider> => {
    const output = await runner(input, (value) =>
      jsonLines(value).some((item) => (item as { id?: number }).id === 3)
    );
    const groups = parseCodexRateLimits(output);
    if (!groups.length) throw new Error('Codex app-server returned no account rate limits');
    return { id: 'codex', label: 'Codex', groups };
  };
  const results = await Promise.allSettled([codexReader(), ...readers.map((reader) => reader())]);
  const providers = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  );
  if (!providers.length) {
    if (cached) return { ...cached, stale: true };
    throw new Error('No supported provider returned account usage');
  }
  cached = {
    providers,
    updatedAt: new Date().toISOString(),
  };
  return cached;
}

export async function readCodexContextUsage(
  threadId: string,
  runner: CommandRunner = runCodexAppServer
): Promise<{ usedTokens: number; contextWindow: number } | undefined> {
  const input =
    [
      {
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: {
            name: 'xangi-usage-monitor',
            title: 'xangi usage monitor',
            version: '0.1.0',
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method: 'initialized', params: {} },
      { method: 'thread/resume', id: 2, params: { threadId, excludeTurns: true } },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n';
  const output = await runner(input, (value) =>
    jsonLines(value).some((item) => (item as { id?: number }).id === 2)
  );
  const notifiedUsage = parseCodexContextUsage(output);
  if (notifiedUsage) return notifiedUsage;

  const resumed = parseCodexResume(output);
  if (!resumed || !basename(resumed.path).includes(threadId)) return undefined;
  const [sessionsRoot, rolloutPath] = await Promise.all([
    realpath(resolve(resumed.codexHome, 'sessions')),
    realpath(resumed.path),
  ]);
  if (!rolloutPath.startsWith(`${sessionsRoot}${sep}`)) return undefined;
  return parseCodexRolloutContextUsage(await readFile(rolloutPath, 'utf8'), threadId);
}
