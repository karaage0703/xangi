import type { WorkThread } from './agent-work.js';
import type { AgentWorkPresentation } from './agent-work-presentation.js';
import { migrateTeamState } from './team-migration.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentBackend, EffortLevel, LocalLlmReasoningEffort } from './config.js';

import type { LocalLlmMode } from './backend-resolver.js';

const FILE_NAME = 'agent-runs.json';
const VERSION = 1;
const MAX_TASK_LENGTH = 100_000;

export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface AgentRun {
  id: string;
  status: AgentRunStatus;
  task: string;
  taskHash: string;
  workPresentation?: AgentWorkPresentation;
  projectId?: string;
  agentId?: string;
  teamId?: string;
  teamTurnId?: string;
  teamPhase?: string;
  parentContextKey?: string;
  /** Platform of the parent conversation, used for completion delivery. */
  parentPlatform?: 'discord' | 'slack' | 'telegram' | 'web' | 'line';
  backend: AgentBackend;
  model?: string;
  effort?: EffortLevel;
  localLlmMode?: LocalLlmMode;
  localLlmReasoningEffort?: LocalLlmReasoningEffort;
  workspaceId: string;
  workspacePath: string;
  appSessionId: string;
  providerSessionId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  parentNotifiedAt?: string;
  /** Only explicitly tracked runs may be recovered by the parent watchdog. */
  parentDeliveryTracked?: boolean;
  parentDeliveryAttempts?: number;
  parentDeliveryAttemptAt?: string;
  parentDeliveryError?: string;
  parentDeliveryFallbackAttempted?: boolean;
  parentProgressAt?: string;
  durationMs?: number;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
  result?: string;
  error?: string;
  trajectoryPath?: string;
  workThread?: WorkThread;
  workRevision?: number;
  workDeliveryError?: string;
  pendingWorkInputs?: Array<{ id: string; text: string }>;
  workInputIds?: string[];
}

interface State {
  version: 1;
  runs: AgentRun[];
}

export interface CreateAgentRunInput {
  workPresentation?: AgentWorkPresentation;
  projectId?: string;
  agentId?: string;
  teamId?: string;
  teamTurnId?: string;
  teamPhase?: string;
  parentContextKey?: string;
  parentPlatform?: AgentRun['parentPlatform'];
  task: string;
  backend: AgentBackend;
  model?: string;
  effort?: EffortLevel;
  localLlmMode?: LocalLlmMode;
  localLlmReasoningEffort?: LocalLlmReasoningEffort;
  workspaceId: string;
  workspacePath: string;
  appSessionId: string;
}

export class AgentRunStore {
  private state: State;

  constructor(private readonly filePath: string) {
    this.state = this.load();
    if (this.recoverInterruptedRuns()) this.persist();
  }

  static fromDataDir(dataDir: string): AgentRunStore {
    return new AgentRunStore(join(dataDir, FILE_NAME));
  }

  list(): AgentRun[] {
    return [...this.state.runs]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneRun);
  }

  get(id: string): AgentRun | undefined {
    const run = this.state.runs.find((candidate) => candidate.id === id);
    return run ? cloneRun(run) : undefined;
  }

  create(input: CreateAgentRunInput): AgentRun {
    const task = input.task.trim();
    if (!task) throw new AgentRunError('task is required', 400);
    if (task.length > MAX_TASK_LENGTH) {
      throw new AgentRunError(`task must be ${MAX_TASK_LENGTH} characters or fewer`, 400);
    }
    const timestamp = new Date().toISOString();
    const run: AgentRun = {
      id: randomUUID(),
      status: 'queued',
      task,
      workPresentation: input.workPresentation && structuredClone(input.workPresentation),
      taskHash: createHash('sha256').update(task).digest('hex'),
      projectId: input.projectId,
      agentId: input.agentId,
      teamId: input.teamId,
      teamTurnId: input.teamTurnId,
      teamPhase: input.teamPhase,
      parentContextKey: input.parentContextKey,
      parentPlatform: input.parentPlatform,
      parentDeliveryTracked: Boolean(input.parentContextKey),
      backend: input.backend,
      model: input.model,
      effort: input.effort,
      localLlmMode: input.localLlmMode,
      localLlmReasoningEffort: input.localLlmReasoningEffort,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      appSessionId: input.appSessionId,
      createdAt: timestamp,
    };
    this.state.runs.push(run);
    this.persist();
    return cloneRun(run);
  }

  markRunning(id: string): AgentRun {
    return this.update(id, (run) => {
      run.status = 'running';
      run.parentDeliveryTracked = Boolean(run.parentContextKey);
      run.workRevision = (run.workRevision || 0) + 1;
      run.startedAt = new Date().toISOString();
      delete run.error;
      delete run.result;
      delete run.usage;
      delete run.durationMs;
      delete run.workDeliveryError;
      delete run.completedAt;
      delete run.parentNotifiedAt;
      delete run.parentDeliveryAttempts;
      delete run.parentDeliveryAttemptAt;
      delete run.parentDeliveryError;
      delete run.parentDeliveryFallbackAttempted;
      delete run.parentProgressAt;
    });
  }

  setWorkThread(id: string, thread: WorkThread) {
    return this.update(id, (run) => {
      run.workThread = thread;
    });
  }
  setWorkDeliveryError(id: string, error: string) {
    return this.update(id, (run) => {
      run.workDeliveryError = error;
    });
  }
  setWorkProviderSession(id: string, sessionId: string) {
    return this.update(id, (run) => {
      run.providerSessionId = sessionId;
    });
  }
  enqueueWorkInput(id: string, input: { id: string; text: string }) {
    return this.update(id, (run) => {
      if (run.workInputIds?.includes(input.id)) return;
      if ((run.pendingWorkInputs?.length || 0) >= 20)
        throw new AgentRunError('追加指示が20件待機中です。完了を待ってください', 409);
      (run.pendingWorkInputs ??= []).push(input);
      (run.workInputIds ??= []).push(input.id);
    });
  }
  takeWorkInputs(id: string) {
    const inputs = this.get(id)?.pendingWorkInputs || [];
    this.update(id, (run) => {
      run.pendingWorkInputs = [];
    });
    return inputs;
  }

  markSucceeded(
    id: string,
    result: { result: string; sessionId: string; usage?: AgentRun['usage'] }
  ): AgentRun {
    return this.update(id, (run) => {
      run.status = 'succeeded';
      run.completedAt = new Date().toISOString();
      run.durationMs = durationSince(run.startedAt, run.completedAt);
      run.providerSessionId = result.sessionId;
      run.usage = result.usage;
      run.result = result.result;
      this.refreshTrajectoryPath(run);
      delete run.error;
    });
  }

  markFailed(id: string, error: unknown): AgentRun {
    return this.update(id, (run) => {
      run.status = 'failed';
      run.completedAt = new Date().toISOString();
      run.durationMs = durationSince(run.startedAt, run.completedAt);
      run.error = error instanceof Error ? error.message : String(error);
      this.refreshTrajectoryPath(run);
    });
  }

  markParentDeliveryAttempt(id: string) {
    return this.update(id, (run) => {
      run.parentDeliveryAttempts = (run.parentDeliveryAttempts || 0) + 1;
      run.parentDeliveryAttemptAt = new Date().toISOString();
      delete run.parentDeliveryError;
    });
  }
  setParentDeliveryError(id: string, error: string) {
    return this.update(id, (run) => {
      run.parentDeliveryError = error;
    });
  }
  markParentFallbackAttempted(id: string) {
    return this.update(id, (run) => {
      run.parentDeliveryFallbackAttempted = true;
    });
  }
  markParentProgress(id: string) {
    return this.update(id, (run) => {
      run.parentProgressAt = new Date().toISOString();
    });
  }

  markParentNotified(id: string): AgentRun {
    return this.update(id, (run) => {
      if (run.status !== 'succeeded' && run.status !== 'failed')
        throw new AgentRunError('実行中の結果は通知済みにできません', 409);
      run.parentNotifiedAt = new Date().toISOString();
    });
  }

  private refreshTrajectoryPath(run: AgentRun): void {
    const candidate = join(
      run.workspacePath,
      'logs',
      'tool-trajectory',
      `${run.appSessionId}.jsonl`
    );
    if (existsSync(candidate)) run.trajectoryPath = candidate;
    else delete run.trajectoryPath;
  }

  private update(id: string, mutate: (run: AgentRun) => void): AgentRun {
    const run = this.state.runs.find((candidate) => candidate.id === id);
    if (!run) throw new AgentRunError('Agent Runが見つかりません', 404);
    mutate(run);
    this.persist();
    return cloneRun(run);
  }

  private load(): State {
    if (!existsSync(this.filePath)) return { version: VERSION, runs: [] };
    const parsed = JSON.parse(
      readFileSync(this.filePath, 'utf8'),
      migrateTeamState
    ) as Partial<State>;
    if (parsed.version !== VERSION || !Array.isArray(parsed.runs)) {
      throw new Error('Agent Run state is invalid');
    }
    return { version: VERSION, runs: parsed.runs };
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }

  private recoverInterruptedRuns(): boolean {
    let changed = false;
    const completedAt = new Date().toISOString();
    for (const run of this.state.runs) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      run.status = 'failed';
      run.completedAt = completedAt;
      run.durationMs = durationSince(run.startedAt, completedAt);
      run.error = 'xangi restarted before the Agent Run completed';
      changed = true;
    }
    return changed;
  }
}

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function durationSince(startedAt: string | undefined, completedAt: string): number | undefined {
  if (!startedAt) return undefined;
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function cloneRun(run: AgentRun): AgentRun {
  return structuredClone(run);
}
