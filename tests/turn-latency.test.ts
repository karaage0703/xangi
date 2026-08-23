import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { TurnLatencyRecorder } from '../src/turn-latency.js';

describe('TurnLatencyRecorder', () => {
  it('writes decomposed first-turn latency as JSONL', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'xangi-latency-'));
    let now = 1_100;
    const recorder = new TurnLatencyRecorder(
      {
        platform: 'discord',
        turnId: 'discord-msg-1',
        threadId: 'discord:thread-1',
        configuredBackend: 'codex',
        configuredModel: 'gpt-test',
        firstTurn: true,
        receivedAt: 1_000,
        workdir,
      },
      () => now
    );

    now = 1_250;
    recorder.markInitialReply();
    now = 1_300;
    recorder.markAgentStart();
    now = 1_400;
    recorder.markBackendReady();
    now = 1_800;
    recorder.markActivity();
    now = 2_100;
    recorder.markText();
    now = 2_600;
    recorder.markAgentComplete();
    now = 2_750;
    const record = recorder.finish('complete');

    expect(record).toMatchObject({
      first_turn: true,
      received_to_process_start_ms: 100,
      received_to_initial_reply_ms: 250,
      agent_start_to_first_activity_ms: 500,
      agent_start_to_backend_ready_ms: 100,
      agent_start_to_first_text_ms: 800,
      agent_duration_ms: 1300,
      received_to_final_reply_ms: 1750,
    });
    const line = readFileSync(join(workdir, 'logs/turn-latency/discord.jsonl'), 'utf8');
    expect(JSON.parse(line)).toEqual(record);
  });

  it('records only the first occurrence of each milestone and finishes once', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'xangi-latency-'));
    let now = 10;
    const recorder = new TurnLatencyRecorder(
      {
        platform: 'discord',
        turnId: 'turn',
        threadId: 'thread',
        firstTurn: false,
        receivedAt: 0,
        workdir,
      },
      () => now
    );
    recorder.markAgentStart();
    now = 20;
    recorder.markText();
    now = 30;
    recorder.markText();
    now = 40;

    expect(recorder.finish('error')?.agent_start_to_first_text_ms).toBe(10);
    expect(recorder.finish('complete')).toBeUndefined();
  });

  it('decomposes overlapping Codex tools from non-tool backend time', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'xangi-latency-'));
    let now = 1_000;
    const recorder = new TurnLatencyRecorder(
      {
        platform: 'discord',
        turnId: 'turn-trace',
        threadId: 'thread',
        firstTurn: false,
        receivedAt: 900,
        workdir,
      },
      () => now
    );

    recorder.markAgentStart();
    now = 1_050;
    recorder.markTraceEvent({ type: 'turn_started' });
    now = 1_200;
    recorder.markTraceEvent({ type: 'tool_started', toolId: 'a', toolName: 'Bash' });
    now = 1_250;
    recorder.markTraceEvent({ type: 'tool_started', toolId: 'b', toolName: 'view' });
    now = 1_400;
    recorder.markTraceEvent({
      type: 'tool_completed',
      toolId: 'a',
      toolName: 'Bash',
      status: 'completed',
      exitCode: 0,
      outputBytes: 24,
    });
    now = 1_500;
    recorder.markTraceEvent({
      type: 'tool_completed',
      toolId: 'b',
      toolName: 'view',
      status: 'completed',
    });
    now = 1_800;
    recorder.markTraceEvent({ type: 'message_completed' });
    now = 1_900;
    recorder.markTraceEvent({
      type: 'turn_completed',
      usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 },
    });
    now = 1_950;
    recorder.markAgentComplete();
    now = 2_000;

    const trace = recorder.finish('complete')?.backend_trace;
    expect(trace).toMatchObject({
      trace_duration_ms: 850,
      tool_count: 2,
      tool_batch_count: 1,
      tool_wall_ms: 300,
      non_tool_backend_ms: 550,
      first_output_wait_ms: 150,
      input_tokens: 100,
      cached_input_tokens: 80,
      output_tokens: 20,
    });
    expect(trace?.tools).toEqual([
      expect.objectContaining({
        tool_id: 'a',
        tool_name: 'Bash',
        start_ms: 200,
        end_ms: 400,
        duration_ms: 200,
        exit_code: 0,
        output_bytes: 24,
      }),
      expect.objectContaining({
        tool_id: 'b',
        tool_name: 'view',
        start_ms: 250,
        end_ms: 500,
        duration_ms: 250,
      }),
    ]);
  });

  it('closes an in-flight tool at agent completion on error', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'xangi-latency-'));
    let now = 100;
    const recorder = new TurnLatencyRecorder(
      {
        platform: 'web',
        turnId: 'turn-error',
        threadId: 'thread',
        firstTurn: true,
        receivedAt: 0,
        workdir,
      },
      () => now
    );
    recorder.markAgentStart();
    recorder.markTraceEvent({ type: 'turn_started' });
    now = 130;
    recorder.markTraceEvent({ type: 'tool_started', toolId: 'a', toolName: 'Bash' });
    now = 180;
    recorder.markAgentComplete();

    const trace = recorder.finish('error')?.backend_trace;
    expect(trace).toMatchObject({
      trace_duration_ms: 80,
      tool_count: 1,
      tool_batch_count: 1,
      tool_wall_ms: 50,
      non_tool_backend_ms: 30,
    });
    expect(trace?.tools[0]).toMatchObject({ start_ms: 30, end_ms: 80, duration_ms: 50 });
  });
});
