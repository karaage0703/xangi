export type Platform = 'web' | 'discord' | 'slack' | 'line' | 'telegram' | string;

export type ActivityState =
  'thinking' | 'streaming' | 'tool' | 'complete' | 'aborted' | 'error' | 'stale';

export interface ActivityHistoryEvent {
  state: ActivityState;
  summary: string;
  at: number;
}

export interface Activity {
  state: ActivityState;
  summary: string;
  userTextPreview?: string;
  textPreview?: string;
  toolLines: string[];
  history: ActivityHistoryEvent[];
  turnId: string;
  threadId: string;
  threadLabel?: string;
  platform?: Platform;
  startedAt: number;
  updatedAt: number;
  elapsedSec: number;
  active: boolean;
}

export interface Session {
  id: string;
  title: string;
  platform: Platform;
  contextKey: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  isActive: boolean;
  lifecycle?: 'open' | 'closed';
  autoTalk: boolean;
  autoTalkActive: boolean;
  timeoutAt?: number;
  maxTimeoutAt?: number;
  timeoutMs?: number;
  activity?: Activity;
}

export interface SessionsMeta {
  limit: number;
  offset?: number;
  q?: string;
  total?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
  processCwd: string;
  workdir: string;
  pid: number;
  pmId?: string;
}

export interface SessionsResponse {
  sessions: Session[];
  meta: SessionsMeta;
}

export type ScheduleType = 'cron' | 'once' | 'startup';

export interface Schedule {
  id: string;
  type: ScheduleType;
  expression?: string;
  runAt?: string;
  message: string;
  channelId: string;
  platform: Platform;
  createdAt: string;
  enabled: boolean;
  label?: string;
  projectId?: string;
}

export interface SchedulesResponse {
  schedules: Schedule[];
  enabled: boolean;
  startupEnabled: boolean;
}

export interface WebProject {
  id: string;
  name: string;
  prompt: string;
  backend?: string;
  model?: string;
  effort?: string;
}

export interface ProjectsResponse {
  projects: WebProject[];
}

export interface MessageUsage {
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error' | string;
  content: string;
  createdAt: string;
  edited?: boolean;
  editedAt?: string;
  usage?: MessageUsage;
  replySuggestions: string[];
  attachments?: string[];
  platformMessageId?: string;
}

export interface SessionDetail {
  id: string;
  title: string;
  platform?: Platform;
  lifecycle?: 'open' | 'closed';
  messages: Message[];
  limit?: number;
  before?: number;
  hasMore?: boolean;
  nextBefore?: number | null;
}

export interface ToolHistoryEntry {
  at: number;
  turnId: string;
  toolName: string;
  summary: string;
  inputPreview?: string;
}

export interface ToolHistoryResponse {
  tools: ToolHistoryEntry[];
}

export type TurnHistoryEntry =
  | { kind: 'text'; at: number; turnId: string; text: string }
  | {
      kind: 'tool';
      at: number;
      turnId: string;
      toolName: string;
      summary: string;
      inputPreview?: string;
    };

export interface TurnHistoryResponse {
  history: TurnHistoryEntry[];
}

export interface RuntimeConfig {
  uploadAccept: string | null;
  timeoutExtendEnabled: boolean;
  interChatEnabled: boolean;
  allowedBackends: string[];
}

export type WebCommandCategory = 'session' | 'skills' | 'settings' | 'system';

export interface WebCommandChoice {
  name: string;
  value: string;
  description?: string;
}

export interface WebCommandOption {
  name: string;
  description: string;
  type: 'subcommand' | 'string';
  required?: boolean;
  choices?: WebCommandChoice[];
  options?: WebCommandOption[];
}

export interface WebCommandDefinition {
  name: string;
  description: string;
  usage: string;
  category: WebCommandCategory;
  options?: WebCommandOption[];
}

export interface WebCommandsResponse {
  commands: WebCommandDefinition[];
}

export type WebCommandAction = 'new' | 'stop' | 'extend' | 'restart';

export type WebCommandResult =
  | { kind: 'message'; message: string }
  | {
      kind: 'chat';
      message: string;
      displayMessage: string;
      skipPermissions?: boolean;
    }
  | {
      kind: 'skills';
      skills: Array<{ name: string; description: string }>;
    }
  | {
      kind: 'action';
      action: WebCommandAction;
      message?: string;
      confirmationRequired?: boolean;
    };

export interface CreateSessionResponse {
  ok: true;
  sessionId: string;
}

export interface ResumeSessionResponse {
  ok: true;
  sessionId: string;
  sourceId: string;
}

export interface MutationResponse {
  ok: true;
}

export interface StopSessionResponse extends MutationResponse {
  stopped: boolean;
}

export interface AutoTalkResponse extends MutationResponse {
  appSessionId: string;
  autoTalk: boolean;
  active: boolean;
}

export interface UpdateMessageResponse extends MutationResponse {
  message: {
    id: string;
    role: Message['role'];
    content: string | Record<string, unknown>;
    createdAt: string;
    usage?: Record<string, unknown>;
    edited?: boolean;
    editedAt?: string;
    platformMessageId?: string;
  };
}

export interface UploadedFile {
  name: string;
  path: string;
}

export interface RejectedUpload {
  name: string;
  reason: string;
}

export interface UploadResponse {
  files: UploadedFile[];
  rejected: RejectedUpload[];
}

export interface TimeoutState {
  active: boolean;
  timeoutAt?: number;
  maxTimeoutAt?: number;
  remainingMs?: number;
  timeoutMs?: number;
}

export interface ExtendTimeoutResponse {
  sessionId: string;
  timeoutAt: number;
  remainingMs: number;
  timeoutMs: number;
  maxTimeoutAt: number;
}

export interface ChatRequest {
  appSessionId?: string;
  message: string;
  skipPermissions?: boolean;
}

export interface ChatTextData {
  fullText: string;
}

export interface ChatToolData {
  toolName: string;
  inputSummary?: string;
}

export interface ChatDoneData {
  response: string;
  replySuggestions: string[];
  sessionId: string;
  usage: MessageUsage;
  userMessageId?: string;
  assistantMessageId?: string;
}

export interface ChatTimeoutData {
  sessionId: string;
  timeoutAt?: number;
  maxTimeoutAt?: number;
  timeoutMs?: number;
  remainingMs?: number;
}

export interface ChatTimeoutClearedData {
  sessionId: string;
}

export interface ChatErrorData {
  message: string;
}

export interface ChatSseDataMap {
  text: ChatTextData;
  tool: ChatToolData;
  done: ChatDoneData;
  timeout: ChatTimeoutData;
  timeout_cleared: ChatTimeoutClearedData;
  error: ChatErrorData;
}

export type ChatSseEvent = {
  [K in keyof ChatSseDataMap]: { type: K; data: ChatSseDataMap[K] };
}[keyof ChatSseDataMap];

interface PublishedEventBase {
  thread_id: string;
  turn_id: string;
  thread_label?: string;
  platform?: Platform;
  ts: number;
  instance_id?: string;
  host_hint?: string;
}

export type ActivityEvent =
  | (PublishedEventBase & { type: 'turn.started'; user_text?: string })
  | (PublishedEventBase & {
      type: 'message.delta';
      text: string;
      full_text: string;
    })
  | (PublishedEventBase & { type: 'turn.complete'; text?: string })
  | (PublishedEventBase & { type: 'turn.aborted' })
  | (PublishedEventBase & { type: 'agent.error'; message: string })
  | (PublishedEventBase & {
      type: 'timeout.started';
      timeout_at: number;
      max_timeout_at: number;
      timeout_ms: number;
    })
  | (PublishedEventBase & {
      type: 'timeout.extended';
      timeout_at: number;
      max_timeout_at: number;
      timeout_ms: number;
      remaining_ms: number;
    })
  | (PublishedEventBase & { type: 'timeout.cleared' });

export interface SsePacket {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface ParsedSsePackets {
  packets: SsePacket[];
  remainder: string;
}
