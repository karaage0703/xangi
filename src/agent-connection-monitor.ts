import { connectionSessionId } from './connection-session-id.js';
export { connectionSessionId } from './connection-session-id.js';
import { subscribeActivity } from './activity-store.js';
import { subscribeSessionChanges } from './sessions.js';
import { isSecretSession } from './secret.js';

type Row = Record<string, unknown>;
const fields = [
  'title',
  'platform',
  'scope',
  'executionOrigin',
  'createdAt',
  'updatedAt',
  'messageCount',
  'isActive',
  'isCurrent',
  'lifecycle',
  'sessionMode',
  'agentRunStatus',
  'closedAt',
  'closeReason',
  'providerTitle',
  'transcriptRevision',
] as const;
const nestedFields: Record<string, string[]> = {
  activity: [
    'state',
    'summary',
    'threadLabel',
    'platform',
    'startedAt',
    'updatedAt',
    'elapsedSec',
    'active',
    'toolLines',
  ],
  backend: ['backend', 'model', 'effort', 'source'],
  nextBackend: ['backend', 'model', 'effort', 'source'],
  origin: ['channelId', 'channelName', 'threadId', 'threadName'],
  tokenUsage: ['inputTokens', 'cachedInputTokens', 'outputTokens', 'updatedAt'],
  contextUsage: ['usedTokens', 'contextWindow', 'updatedAt'],
  processingTime: ['durationMs', 'updatedAt', 'source'],
  estimatedCost: ['value', 'updatedAt'],
  modelExecution: [
    'turnId',
    'backend',
    'configuredModel',
    'effectiveModel',
    'configuredEffort',
    'effectiveEffort',
    'effortSource',
    'modelSelection',
    'observedModels',
    'source',
    'startedAt',
    'updatedAt',
    'status',
  ],
  agentWork: ['runId', 'teamId', 'teamName', 'memberId', 'assignment', 'delivery'],
};
function object(value: unknown): value is Row {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function pick(value: Row, keys: readonly string[]): Row {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])
  );
}

function monitorMetadata(input: Row): Row {
  const row = pick(input, [
    ...fields,
    'id',
    'contextKey',
    'selectedAgentId',
    'parentAppSessionId',
    'projectId',
  ]);
  for (const [key, keys] of Object.entries(nestedFields)) {
    if (object(input[key])) row[key] = pick(input[key], keys);
  }
  if (Array.isArray(input.modelHistory))
    row.modelHistory = input.modelHistory
      .filter(object)
      .map((entry) => pick(entry, nestedFields.modelExecution));
  if (object(input.progressCard)) {
    row.progressCard = {
      ...pick(input.progressCard, ['revision', 'updatedAt', 'note']),
      plan: Array.isArray(input.progressCard.plan)
        ? input.progressCard.plan.filter(object).map((step) => pick(step, ['step', 'status']))
        : [],
    };
  }
  if (object(row.activity) && object(input.activity)) {
    if (Array.isArray(input.activity.history)) {
      row.activity.history = input.activity.history
        .filter(object)
        .map((entry) => pick(entry, ['state', 'summary', 'at']));
    }
    if (Array.isArray(row.activity.toolLines))
      row.activity.toolLines = row.activity.toolLines.filter((line) => typeof line === 'string');
  }
  return row;
}

/** Only display metadata crosses the process boundary, never Bot credentials or transcripts. */
export class AgentConnectionMonitor {
  private sources = new Map<string, Row[]>();
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers must not stop a Bot. */
      }
    }
  }
  receive(connectionId: string, agentId: string, message: unknown): void {
    if (
      !object(message) ||
      message.type !== 'agent-connection-monitor' ||
      !Array.isArray(message.sessions)
    )
      return;
    const rows: Row[] = [];
    const seen = new Set<string>();
    for (const input of message.sessions) {
      if (
        !object(input) ||
        typeof input.id !== 'string' ||
        !input.id ||
        isSecretSession(input.id) ||
        typeof input.contextKey !== 'string' ||
        typeof input.platform !== 'string' ||
        typeof input.createdAt !== 'string' ||
        typeof input.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(input.createdAt)) ||
        !Number.isFinite(Date.parse(input.updatedAt)) ||
        !['open', 'closed'].includes(String(input.lifecycle))
      )
        continue;
      const id = connectionSessionId(connectionId, input.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const row: Row = {
        ...monitorMetadata(input),
        id,
        connectionId,
        selectedAgentId:
          typeof input.selectedAgentId === 'string' && input.selectedAgentId
            ? input.selectedAgentId
            : agentId,
        contextKey: connectionSessionId(connectionId, input.contextKey),
        canReopen: input.canReopen !== false,
        title: typeof input.title === 'string' ? input.title : '',
        messageCount: typeof input.messageCount === 'number' ? input.messageCount : 0,
        isActive: input.isActive === true,
        isCurrent: input.isCurrent === true,
      };
      if (object(row.activity)) {
        row.activity.threadId =
          input.scope === 'scheduler'
            ? `${input.platform}-schedule:${id}`
            : `${input.platform}:${row.contextKey}`;
      }
      if (typeof input.parentAppSessionId === 'string')
        row.parentAppSessionId = connectionSessionId(connectionId, input.parentAppSessionId);
      rows.push(row);
    }
    if (message.sessions.length && !rows.length) return;
    this.sources.set(connectionId, rows);
    this.changed();
  }
  sessions(): Row[] {
    return [...this.sources.values()].flat();
  }
  find(id: string): Row | undefined {
    return this.sessions().find((row) => row.id === id);
  }
  remove(connectionId: string): void {
    if (this.sources.delete(connectionId)) this.changed();
  }
}
export const agentConnectionMonitor = new AgentConnectionMonitor();

/** Coalesce token/tool updates and allow only one snapshot in flight over IPC. */
export function createConnectionMonitorPublisher(
  snapshot: () => Row[],
  send: (
    message: { type: 'agent-connection-monitor'; sessions: Row[] },
    done: (error?: Error | null) => void
  ) => void
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let dirty = false;
  let stopped = false;
  const request = () => {
    if (stopped) return;
    dirty = true;
    if (sending || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      dirty = false;
      sending = true;
      const done = (error?: Error | null) => {
        sending = false;
        if (error) console.warn('[agent-connections] monitor IPC failed');
        if (dirty) request();
      };
      try {
        send(
          {
            type: 'agent-connection-monitor',
            sessions: snapshot()
              .filter((row) => typeof row.id === 'string' && !isSecretSession(row.id))
              .map(monitorMetadata),
          },
          done
        );
      } catch {
        done(new Error('monitor snapshot failed'));
      }
    }, 150);
    timer.unref();
  };
  return {
    request,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function installAgentConnectionMonitorWorker(snapshot: () => Row[]): () => void {
  const publisher = createConnectionMonitorPublisher(snapshot, (message, done) => {
    if (!process.connected || !process.send) {
      done(new Error('parent disconnected'));
      return;
    }
    process.send(message, done);
  });
  const unsubscribeSessions = subscribeSessionChanges(publisher.request);
  const unsubscribeActivity = subscribeActivity(publisher.request);
  publisher.request();
  return () => {
    publisher.stop();
    unsubscribeSessions();
    unsubscribeActivity();
  };
}
