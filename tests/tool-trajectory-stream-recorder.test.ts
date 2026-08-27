import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolTrajectoryLogger } from '../src/tool-trajectory/logger.js';
import { ToolTrajectoryStreamRecorder } from '../src/tool-trajectory/stream-recorder.js';

describe('ToolTrajectoryStreamRecorder', () => {
  it('records timing-safe tool metadata and preserves inner callbacks', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'trajectory-stream-'));
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 'test' });
    const inner = vi.fn();
    const recorder = new ToolTrajectoryStreamRecorder(logger, {
      appSessionId: 'session-1',
      platform: 'web',
      backend: 'codex',
      model: 'gpt-test',
    });
    const callbacks = recorder.callbacks({ onTraceEvent: inner });

    callbacks.onTraceEvent?.({ type: 'tool_started', toolId: 'tool-1', toolName: 'Bash' });
    callbacks.onTraceEvent?.({
      type: 'tool_completed',
      toolId: 'tool-1',
      toolName: 'Bash',
      status: 'completed',
      exitCode: 0,
      outputBytes: 123,
    });

    const path = join(workdir, 'logs', 'tool-trajectory', 'session-1.jsonl');
    const entries = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      kind: 'tool_call',
      backend: 'codex',
      model: 'gpt-test',
      tool_call_id: 'tool-1',
      tool_name: 'Bash',
      args_sanitized: {},
      status: 'success',
    });
    expect(entries[1]).not.toHaveProperty('result_truncated');
    expect(entries[1]).not.toHaveProperty('error_truncated');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('marks a non-zero exit as an error', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'trajectory-stream-'));
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 'test' });
    const recorder = new ToolTrajectoryStreamRecorder(logger, {
      appSessionId: 'session-2',
      backend: 'codex',
    });
    const callbacks = recorder.callbacks();
    callbacks.onTraceEvent?.({ type: 'tool_started', toolId: 'tool-2', toolName: 'Bash' });
    callbacks.onTraceEvent?.({
      type: 'tool_completed',
      toolId: 'tool-2',
      toolName: 'Bash',
      exitCode: 2,
    });

    const entries = readFileSync(
      join(workdir, 'logs', 'tool-trajectory', 'session-2.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries[1]).toMatchObject({ kind: 'tool_call', status: 'error' });
  });
});
