import type { AgentTraceEvent, StreamCallbacks } from '../agent-runner.js';
import { ToolTrajectoryLogger, type TrajectoryCommon } from './logger.js';

interface PendingTool {
  name: string;
  startedAt: number;
}

/**
 * Records timing-safe stream metadata for CLI-style runners.
 *
 * AgentTraceEvent deliberately excludes command arguments and output text. Keep that
 * boundary here: the recorder stores only tool name, status, and duration so enabling
 * it for more backends cannot leak provider payloads into the trajectory JSONL.
 */
export class ToolTrajectoryStreamRecorder {
  private readonly pending = new Map<string, PendingTool>();

  constructor(
    private readonly logger: ToolTrajectoryLogger,
    private readonly common: TrajectoryCommon
  ) {
    this.logger.logSessionStart(common, {
      features: ['timing-safe-trace'],
      logger: { enabled: logger.enabled, sanitize_version: 1 },
    });
  }

  callbacks(inner: StreamCallbacks = {}): StreamCallbacks {
    return {
      ...inner,
      onTraceEvent: (event) => {
        this.record(event);
        inner.onTraceEvent?.(event);
      },
    };
  }

  private record(event: AgentTraceEvent): void {
    if (event.type === 'tool_started') {
      this.pending.set(event.toolId ?? this.fallbackKey(event.toolName), {
        name: event.toolName,
        startedAt: Date.now(),
      });
      return;
    }
    if (event.type !== 'tool_completed') return;

    const key = event.toolId ?? this.fallbackKey(event.toolName);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    const failed =
      (event.exitCode !== undefined && event.exitCode !== null && event.exitCode !== 0) ||
      /(?:fail|error)/i.test(event.status ?? '');
    this.logger.logToolCall(this.common, {
      tool_call_id: event.toolId,
      tool_name: event.toolName,
      args: {},
      duration_ms: pending ? Math.max(0, Date.now() - pending.startedAt) : 0,
      status: failed ? 'error' : 'success',
    });
  }

  private fallbackKey(toolName: string): string {
    return `name:${toolName}`;
  }
}
