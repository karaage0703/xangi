import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AgentTraceEvent } from './agent-runner.js';

export interface TurnLatencyContext {
  platform: string;
  turnId: string;
  threadId: string;
  configuredBackend?: string;
  configuredModel?: string;
  firstTurn: boolean;
  receivedAt: number;
  workdir?: string;
}

type TurnOutcome = 'complete' | 'error' | 'cancelled';

export type TimedAgentTraceEvent = AgentTraceEvent & { at_ms: number };

export interface TurnToolSpan {
  tool_id?: string;
  tool_name: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  status?: string;
  exit_code?: number | null;
  output_bytes?: number;
}

export interface TurnBackendTrace {
  schema_version: 1;
  trace_duration_ms: number;
  tool_count: number;
  tool_batch_count: number;
  tool_wall_ms: number;
  /** Backend time outside tool execution. Includes model inference and CLI orchestration. */
  non_tool_backend_ms: number;
  /** Time until the first tool starts, message completes, or the backend turn completes. */
  first_output_wait_ms?: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  events: TimedAgentTraceEvent[];
  tools: TurnToolSpan[];
}

export interface TurnLatencyRecord {
  ts: string;
  platform: string;
  turn_id: string;
  thread_id: string;
  configured_backend?: string;
  configured_model?: string;
  first_turn: boolean;
  outcome: TurnOutcome;
  received_to_process_start_ms: number;
  received_to_initial_reply_ms?: number;
  agent_start_to_first_activity_ms?: number;
  agent_start_to_backend_ready_ms?: number;
  agent_start_to_first_text_ms?: number;
  agent_duration_ms?: number;
  received_to_final_reply_ms: number;
  backend_trace?: TurnBackendTrace;
}

type Clock = () => number;

export class TurnLatencyRecorder {
  private readonly processStartedAt: number;
  private initialReplyAt?: number;
  private agentStartedAt?: number;
  private firstActivityAt?: number;
  private backendReadyAt?: number;
  private firstTextAt?: number;
  private agentCompletedAt?: number;
  private traceEvents: TimedAgentTraceEvent[] = [];
  private written = false;

  constructor(
    private readonly context: TurnLatencyContext,
    private readonly clock: Clock = Date.now
  ) {
    this.processStartedAt = this.clock();
  }

  markInitialReply(): void {
    this.initialReplyAt ??= this.clock();
  }

  markAgentStart(): void {
    this.agentStartedAt ??= this.clock();
  }

  markActivity(): void {
    this.firstActivityAt ??= this.clock();
  }

  markBackendReady(): void {
    this.backendReadyAt ??= this.clock();
  }

  markText(): void {
    this.markActivity();
    this.firstTextAt ??= this.clock();
  }

  markAgentComplete(): void {
    this.agentCompletedAt ??= this.clock();
  }

  markTraceEvent(event: AgentTraceEvent): void {
    if (this.agentStartedAt === undefined || this.written) return;
    this.traceEvents.push({ ...event, at_ms: Math.max(0, this.clock() - this.agentStartedAt) });
  }

  finish(outcome: TurnOutcome): TurnLatencyRecord | undefined {
    if (this.written) return undefined;
    this.written = true;
    const finishedAt = this.clock();
    const fromAgentStart = (at?: number) =>
      at !== undefined && this.agentStartedAt !== undefined ? at - this.agentStartedAt : undefined;
    const record: TurnLatencyRecord = {
      ts: new Date(finishedAt).toISOString(),
      platform: this.context.platform,
      turn_id: this.context.turnId,
      thread_id: this.context.threadId,
      configured_backend: this.context.configuredBackend,
      configured_model: this.context.configuredModel,
      first_turn: this.context.firstTurn,
      outcome,
      received_to_process_start_ms: Math.max(0, this.processStartedAt - this.context.receivedAt),
      received_to_initial_reply_ms:
        this.initialReplyAt === undefined
          ? undefined
          : Math.max(0, this.initialReplyAt - this.context.receivedAt),
      agent_start_to_first_activity_ms: fromAgentStart(this.firstActivityAt),
      agent_start_to_backend_ready_ms: fromAgentStart(this.backendReadyAt),
      agent_start_to_first_text_ms: fromAgentStart(this.firstTextAt),
      agent_duration_ms: fromAgentStart(this.agentCompletedAt),
      received_to_final_reply_ms: Math.max(0, finishedAt - this.context.receivedAt),
      backend_trace: this.buildBackendTrace(fromAgentStart(this.agentCompletedAt)),
    };
    this.append(record);
    return record;
  }

  private buildBackendTrace(agentDuration?: number): TurnBackendTrace | undefined {
    if (this.traceEvents.length === 0) return undefined;
    const events = [...this.traceEvents].sort((a, b) => a.at_ms - b.at_ms);
    const turnStarted = events.find((event) => event.type === 'turn_started')?.at_ms ?? 0;
    const completedEvents = events.filter((event) => event.type === 'turn_completed');
    const lastTurnCompleted = completedEvents.at(-1);
    const traceEnd = Math.max(
      turnStarted,
      lastTurnCompleted?.at_ms ?? agentDuration ?? turnStarted
    );

    type MutableToolSpan = TurnToolSpan & { completed: boolean };
    const tools: MutableToolSpan[] = [];
    for (const event of events) {
      if (event.type === 'tool_started') {
        tools.push({
          tool_id: event.toolId,
          tool_name: event.toolName,
          start_ms: event.at_ms,
          end_ms: traceEnd,
          duration_ms: Math.max(0, traceEnd - event.at_ms),
          completed: false,
        });
      } else if (event.type === 'tool_completed') {
        const open = tools.find(
          (tool) =>
            !tool.completed &&
            (event.toolId ? tool.tool_id === event.toolId : tool.tool_name === event.toolName)
        );
        const tool =
          open ??
          ({
            tool_id: event.toolId,
            tool_name: event.toolName,
            start_ms: event.at_ms,
            end_ms: event.at_ms,
            duration_ms: 0,
            completed: false,
          } satisfies MutableToolSpan);
        if (!open) tools.push(tool);
        tool.end_ms = event.at_ms;
        tool.duration_ms = Math.max(0, tool.end_ms - tool.start_ms);
        tool.status = event.status;
        tool.exit_code = event.exitCode;
        tool.output_bytes = event.outputBytes;
        tool.completed = true;
      }
    }

    const intervals = tools
      .map((tool) => ({
        start: Math.max(turnStarted, Math.min(tool.start_ms, traceEnd)),
        end: Math.max(turnStarted, Math.min(tool.end_ms, traceEnd)),
      }))
      .sort((a, b) => a.start - b.start);
    const batches: Array<{ start: number; end: number }> = [];
    for (const interval of intervals) {
      const last = batches.at(-1);
      if (!last || interval.start > last.end) {
        batches.push({ ...interval });
      } else {
        last.end = Math.max(last.end, interval.end);
      }
    }
    const toolWallMs = batches.reduce((total, batch) => total + (batch.end - batch.start), 0);
    const traceDurationMs = Math.max(0, traceEnd - turnStarted);
    const firstOutput = events.find(
      (event) =>
        event.at_ms >= turnStarted &&
        (event.type === 'tool_started' ||
          event.type === 'message_completed' ||
          event.type === 'turn_completed')
    );
    const usage =
      lastTurnCompleted?.type === 'turn_completed' ? lastTurnCompleted.usage : undefined;

    return {
      schema_version: 1,
      trace_duration_ms: traceDurationMs,
      tool_count: tools.length,
      tool_batch_count: batches.length,
      tool_wall_ms: toolWallMs,
      non_tool_backend_ms: Math.max(0, traceDurationMs - toolWallMs),
      first_output_wait_ms: firstOutput ? Math.max(0, firstOutput.at_ms - turnStarted) : undefined,
      input_tokens: usage?.inputTokens,
      cached_input_tokens: usage?.cachedInputTokens,
      output_tokens: usage?.outputTokens,
      events,
      tools: tools.map(({ completed: _completed, ...tool }) => tool),
    };
  }

  private append(record: TurnLatencyRecord): void {
    try {
      const workdir = this.context.workdir || process.env.WORKSPACE_PATH || process.cwd();
      const dir = join(workdir, 'logs', 'turn-latency');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${record.platform}.jsonl`), `${JSON.stringify(record)}\n`);
    } catch (error) {
      console.warn(
        `[turn-latency] Failed to write metric: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
