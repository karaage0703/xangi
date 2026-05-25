import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  ToolTrajectoryLogger,
  loggerOptionsFromEnv,
  TRAJECTORY_SCHEMA_VERSION,
} from '../src/tool-trajectory/index.js';

function readEvents(workdir: string, appSessionId: string): Record<string, unknown>[] {
  const path = join(workdir, 'logs/tool-trajectory', `${appSessionId}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('ToolTrajectoryLogger', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'tool-trajectory-test-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('does nothing when disabled', () => {
    const logger = new ToolTrajectoryLogger({
      workdir,
      enabled: false,
      hashSalt: 's',
    });
    logger.logSessionStart(
      { appSessionId: 'sess-1', backend: 'local-llm', model: 'gemma' },
      { features: ['tools'] }
    );
    logger.logToolCall(
      { appSessionId: 'sess-1' },
      { tool_name: 'read', args: { path: '/foo' }, duration_ms: 12, status: 'success' }
    );
    expect(existsSync(join(workdir, 'logs/tool-trajectory'))).toBe(false);
  });

  it('writes session_start with common fields + schema_version', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart(
      {
        appSessionId: 'sess-1',
        platform: 'discord',
        backend: 'local-llm',
        model: 'gemma-4-26b-a4b',
        channelId: '1234567890',
      },
      {
        baseUrl: 'http://localhost:11434/api',
        features: ['tools', 'skills'],
        logger: { enabled: true, sanitize_version: 1 },
      }
    );

    const events = readEvents(workdir, 'sess-1');
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('session_start');
    expect(e.schema_version).toBe(TRAJECTORY_SCHEMA_VERSION);
    expect(e.appSessionId).toBe('sess-1');
    expect(e.platform).toBe('discord');
    expect(e.backend).toBe('local-llm');
    expect(e.model).toBe('gemma-4-26b-a4b');
    expect(typeof e.channelId_hash).toBe('string');
    expect((e.channelId_hash as string).startsWith('h_')).toBe(true);
    expect(e.features).toEqual(['tools', 'skills']);
    expect(typeof e.event_id).toBe('string');
    expect(typeof e.ts).toBe('string');
  });

  it('writes tool_call with sanitized args + truncated result', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart({ appSessionId: 's1' }, {});
    logger.logToolCall(
      { appSessionId: 's1', round: 0, turnIndex: 1 },
      {
        tool_call_id: 'call-1',
        tool_name: 'read',
        args: { path: '/foo', apiKey: 'leaked-secret' },
        result: 'a'.repeat(20000),
        duration_ms: 42,
        status: 'success',
      }
    );

    const events = readEvents(workdir, 's1');
    expect(events).toHaveLength(2);
    const e = events[1];
    expect(e.kind).toBe('tool_call');
    expect(e.tool_name).toBe('read');
    const args = e.args_sanitized as Record<string, unknown>;
    expect(args.apiKey).toBe('[REDACTED_SECRET]');
    expect(args.path).toBe('/foo');
    expect((e.result_truncated as string).length).toBeLessThan(20000);
    expect(e.duration_ms).toBe(42);
    expect(e.status).toBe('success');
    expect(e.round).toBe(0);
    expect(e.turn_index).toBe(1);
  });

  it('writes tool_call error with error_truncated field', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart({ appSessionId: 's1' }, {});
    logger.logToolCall(
      { appSessionId: 's1' },
      {
        tool_name: 'exec',
        args: { command: 'ls' },
        error: 'Permission denied',
        duration_ms: 3,
        status: 'error',
      }
    );
    const events = readEvents(workdir, 's1');
    const e = events[1];
    expect(e.status).toBe('error');
    expect(e.error_truncated).toBe('Permission denied');
    expect(e.result_truncated).toBeUndefined();
  });

  it('writes tool_search with candidates + activated lists', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart({ appSessionId: 's1' }, {});
    logger.logToolSearch(
      { appSessionId: 's1' },
      {
        query: 'discord history',
        candidates: [
          { name: 'discord_history', type: 'tool', score: 10 },
          { name: 'slack_history', type: 'tool', score: 5 },
        ],
        activated_tools: ['discord_history', 'slack_history'],
        activated_skills: [],
      }
    );
    const events = readEvents(workdir, 's1');
    const e = events[1];
    expect(e.kind).toBe('tool_search');
    expect(e.query_sanitized).toBe('discord history');
    expect(e.candidates).toHaveLength(2);
    expect(e.activated_tools).toEqual(['discord_history', 'slack_history']);
  });

  it('writes drift_rescue for each safety verdict', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart({ appSessionId: 's1' }, {});
    logger.logDriftRescue(
      { appSessionId: 's1' },
      {
        raw_text_head: 'call:exec{cmd:rm -rf /}',
        parsed_name: 'exec',
        parsed_args: { cmd: 'rm -rf /' },
        safety_verdict: 'unsafe',
        executed: false,
        failure_reason: 'not in allowlist',
      }
    );
    const events = readEvents(workdir, 's1');
    const e = events[1];
    expect(e.kind).toBe('drift_rescue');
    expect(e.safety_verdict).toBe('unsafe');
    expect(e.executed).toBe(false);
    expect(e.parsed_name).toBe('exec');
  });

  it('writes loop_detected for exact/similar/idempotent_cache_hit', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart({ appSessionId: 's1' }, {});
    logger.logLoopDetected(
      { appSessionId: 's1' },
      { loop_kind: 'exact', signature: 'wc::{file:foo}', tool_name: 'wc', action: 'blocked', repeats: 3 }
    );
    logger.logLoopDetected(
      { appSessionId: 's1' },
      { loop_kind: 'similar', signature: 'sig2', tool_name: 'wc', action: 'blocked' }
    );
    logger.logLoopDetected(
      { appSessionId: 's1' },
      { loop_kind: 'idempotent_cache_hit', signature: 'sig3', tool_name: 'wc', action: 'cached' }
    );
    const events = readEvents(workdir, 's1');
    expect(events).toHaveLength(4);
    expect(events[1].loop_kind).toBe('exact');
    expect(events[2].loop_kind).toBe('similar');
    expect(events[3].loop_kind).toBe('idempotent_cache_hit');
  });

  it('writes runner_event for streaming_hold_buffer_drop / context_prune / session_retry', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart({ appSessionId: 's1' }, {});
    logger.logRunnerEvent({ appSessionId: 's1' }, { event: 'streaming_hold_buffer_drop' });
    logger.logRunnerEvent({ appSessionId: 's1' }, { event: 'context_prune', details: { compacted_count: 5 } });
    logger.logRunnerEvent({ appSessionId: 's1' }, { event: 'session_retry' });
    const events = readEvents(workdir, 's1');
    expect(events).toHaveLength(4);
    expect(events[1].event).toBe('streaming_hold_buffer_drop');
    expect(events[2].event).toBe('context_prune');
    expect(events[3].event).toBe('session_retry');
  });

  it('assigns sequential seq numbers per appSession', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart({ appSessionId: 's1' }, {});
    logger.logSessionStart({ appSessionId: 's2' }, {});
    logger.logToolCall(
      { appSessionId: 's1' },
      { tool_name: 't', args: {}, duration_ms: 1, status: 'success' }
    );
    logger.logToolCall(
      { appSessionId: 's2' },
      { tool_name: 't', args: {}, duration_ms: 1, status: 'success' }
    );
    logger.logToolCall(
      { appSessionId: 's1' },
      { tool_name: 't', args: {}, duration_ms: 1, status: 'success' }
    );
    const s1 = readEvents(workdir, 's1');
    const s2 = readEvents(workdir, 's2');
    expect(s1.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(s2.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('is fail-safe: logger does not throw when args circular', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    logger.logSessionStart({ appSessionId: 's1' }, {});
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    expect(() =>
      logger.logToolCall(
        { appSessionId: 's1' },
        { tool_name: 't', args: circular, duration_ms: 1, status: 'success' }
      )
    ).not.toThrow();
  });

  it('prune is no-op by default (no retention/size cap set)', () => {
    const logger = new ToolTrajectoryLogger({ workdir, enabled: true, hashSalt: 's' });
    const dir = join(workdir, 'logs/tool-trajectory');
    mkdirSync(dir, { recursive: true });
    const f1 = join(dir, 'old.jsonl');
    writeFileSync(f1, '{}\n');
    // Set f1 to 1000 days ago — must NOT be deleted because retention is unset
    const veryOld = (Date.now() - 1000 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(f1, veryOld, veryOld);

    const result = logger.prune();
    expect(result.removed).toBe(0);
    expect(existsSync(f1)).toBe(true);
  });

  it('prune removes files older than TTL', () => {
    const logger = new ToolTrajectoryLogger({
      workdir,
      enabled: true,
      hashSalt: 's',
      retentionDays: 1,
    });
    const dir = join(workdir, 'logs/tool-trajectory');
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, 'old.jsonl');
    const newFile = join(dir, 'new.jsonl');
    writeFileSync(oldFile, '{}\n');
    writeFileSync(newFile, '{}\n');
    // Set old file mtime to 5 days ago
    const fiveDaysAgo = (Date.now() - 5 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(oldFile, fiveDaysAgo, fiveDaysAgo);

    const result = logger.prune();
    expect(result.removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it('prune removes oldest files when total size exceeds cap', () => {
    const logger = new ToolTrajectoryLogger({
      workdir,
      enabled: true,
      hashSalt: 's',
      retentionDays: 365,
      sizeCapMb: 0, // force size cap to be immediately exceeded by any file
    });
    const dir = join(workdir, 'logs/tool-trajectory');
    mkdirSync(dir, { recursive: true });
    const f1 = join(dir, 'older.jsonl');
    const f2 = join(dir, 'newer.jsonl');
    writeFileSync(f1, 'a'.repeat(100));
    writeFileSync(f2, 'a'.repeat(100));
    const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(f1, old, old);

    const result = logger.prune();
    expect(result.removed).toBeGreaterThanOrEqual(1);
    // older one should be removed first
    expect(existsSync(f1)).toBe(false);
  });

  it('loggerOptionsFromEnv reads env vars correctly', () => {
    const opts = loggerOptionsFromEnv('/tmp', {
      XANGI_TOOL_TRAJECTORY_LOG: 'false',
      TOOL_TRAJECTORY_LOG_HASH_SALT: 'fixed-salt',
      TOOL_TRAJECTORY_LOG_MAX_RESULT_CHARS: '500',
      TOOL_TRAJECTORY_LOG_RETENTION_DAYS: '7',
      TOOL_TRAJECTORY_LOG_SIZE_CAP_MB: '50',
    } as NodeJS.ProcessEnv);
    expect(opts.enabled).toBe(false);
    expect(opts.hashSalt).toBe('fixed-salt');
    expect(opts.maxResultChars).toBe(500);
    expect(opts.retentionDays).toBe(7);
    expect(opts.sizeCapMb).toBe(50);
  });

  it('loggerOptionsFromEnv defaults to enabled=true', () => {
    const opts = loggerOptionsFromEnv('/tmp', {} as NodeJS.ProcessEnv);
    expect(opts.enabled).toBe(true);
    expect(opts.hashSalt.length).toBeGreaterThan(0);
  });
});
