import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  parseCodexContextUsage,
  parseCodexRateLimits,
  parseCodexRolloutContextUsage,
  parseCopilotQuota,
  parseAntigravityStatus,
  applyAntigravitySessionUsage,
  parseClaudeUsage,
  readCodexContextUsage,
  readClaudeUsage,
} from '../src/usage-monitor.js';
import { extractClaudeContextUsage } from '../src/claude-code.js';
import {
  clearSessions,
  createSession,
  getSessionEntry,
  initSessions,
  setProviderSessionId,
} from '../src/sessions.js';

function claudeOutput(response: unknown): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: '1', response },
  })}\n`;
}

describe('usage monitor parsers', () => {
  it('parses supported Copilot account quota snapshots', () => {
    expect(
      parseCopilotQuota({
        quotaSnapshots: {
          chat: {
            hasQuota: true,
            remainingPercentage: 84.6,
            resetDate: '2026-09-01T00:00:00.000Z',
          },
          premium_interactions: { hasQuota: false, remainingPercentage: 0 },
        },
      }, Date.parse('2026-08-28T00:00:00.000Z'))
    ).toEqual([
      {
        id: 'copilot',
        label: 'GitHub Copilot',
        windows: [
          {
            label: 'Chat / AI Credits',
            usedPercent: 15.4,
            resetsAt: Date.parse('2026-09-01T00:00:00.000Z') / 1000,
          },
        ],
      },
    ]);
  });

  it('omits a Copilot reset date that is not in the future', () => {
    const now = Date.parse('2026-08-28T01:45:03.832Z');
    expect(
      parseCopilotQuota(
        {
          quotaSnapshots: {
            chat: {
              hasQuota: true,
              remainingPercentage: 84.6,
              resetDate: '2026-08-28T01:45:03.832Z',
            },
          },
        },
        now
      )
    ).toEqual([
      {
        id: 'copilot',
        label: 'GitHub Copilot',
        windows: [{ label: 'Chat / AI Credits', usedPercent: 15.4, resetsAt: undefined }],
      },
    ]);
  });

  it('parses Antigravity official statusline quota and context', () => {
    expect(
      parseAntigravityStatus({
        conversation_id: 'conversation-1',
        plan_tier: 'Pro',
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 12.5,
          current_usage: { input_tokens: 100, output_tokens: 20 },
        },
        cost: 0.012345678,
        quota: {
          '3p-5h': {
            remaining_fraction: 1,
            reset_time: '2026-08-31T08:00:06.000Z',
          },
          '3p-weekly': {
            remaining_fraction: 1,
            reset_time: '2026-09-02T00:00:00.000Z',
          },
          'gemini-5h': {
            remaining_fraction: 0.95,
            reset_time: '2026-08-31T08:00:06.000Z',
          },
          'gemini-weekly': {
            remaining_fraction: 0.9035936,
            reset_time: '2026-09-01T00:00:00.000Z',
          },
        },
      })
    ).toEqual({
      conversationId: 'conversation-1',
      context: { usedTokens: 125_000, contextWindow: 1_000_000 },
      estimatedCost: 0.012345678,
      groups: [
        {
          id: 'gemini',
          label: 'Geminiモデル',
          planType: 'Pro',
          windows: [
            {
              label: '5時間',
              usedPercent: 5,
              resetsAt: Date.parse('2026-08-31T08:00:06.000Z') / 1000,
            },
            {
              label: '週次',
              usedPercent: 9.64064,
              resetsAt: Date.parse('2026-09-01T00:00:00.000Z') / 1000,
            },
          ],
        },
        {
          id: 'third-party',
          label: 'サードパーティモデル',
          planType: 'Pro',
          windows: [
            {
              label: '5時間',
              usedPercent: 0,
              resetsAt: Date.parse('2026-08-31T08:00:06.000Z') / 1000,
            },
            {
              label: '週次',
              usedPercent: 0,
              resetsAt: Date.parse('2026-09-02T00:00:00.000Z') / 1000,
            },
          ],
        },
      ],
    });
  });

  it('keeps unknown Antigravity quota buckets and ignores unavailable cost', () => {
    expect(
      parseAntigravityStatus({
        cost: 'not-reported',
        quota: {
          'future-daily': {
            remaining_fraction: 0.5,
            reset_time: '2026-09-01T00:00:00.000Z',
          },
          invalid: { reset_time: '2026-09-01T00:00:00.000Z' },
        },
      })
    ).toEqual({
      conversationId: undefined,
      context: undefined,
      groups: [
        {
          id: 'future-daily',
          label: 'future-daily',
          planType: undefined,
          windows: [
            {
              label: 'future-daily',
              usedPercent: 50,
              resetsAt: Date.parse('2026-09-01T00:00:00.000Z') / 1000,
            },
          ],
        },
      ],
    });
  });

  it('persists Antigravity cost when a status update omits context', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'xangi-antigravity-cost-'));
    clearSessions();
    initSessions(dataDir);
    const appId = createSession('antigravity-cost', {
      platform: 'web',
      backend: 'antigravity',
    });
    setProviderSessionId(appId, 'conversation-cost', 'antigravity');

    const result = applyAntigravitySessionUsage(
      parseAntigravityStatus({ conversation_id: 'conversation-cost', cost: 0.25 })
    );

    expect(result).toEqual({ contextUpdated: false, costUpdated: true });
    expect(getSessionEntry(appId)?.estimatedCost).toMatchObject({
      value: 0.25,
      source: 'antigravity-statusline',
    });
    expect(getSessionEntry(appId)?.contextUsage).toBeUndefined();
    clearSessions();
  });

  it('parses and deduplicates named Codex account limit buckets', () => {
    const snapshot = {
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'pro',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_800_100_000 },
    };
    const output = `${JSON.stringify({ id: 3, result: { rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot } } })}\n`;

    expect(parseCodexRateLimits(output)).toEqual([
      {
        id: 'codex',
        label: 'Codex',
        planType: 'pro',
        windows: [
          { label: '5時間', usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          { label: '週次', usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_800_100_000 },
        ],
      },
    ]);
  });

  it('uses the last request rather than cumulative thread tokens for context', () => {
    const output = `${JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: { totalTokens: 900_000 },
          last: { totalTokens: 120_000 },
          modelContextWindow: 258_400,
        },
      },
    })}\n`;
    expect(parseCodexContextUsage(output)).toEqual({ usedTokens: 120_000, contextWindow: 258_400 });
  });

  it('reads the latest token count from the rollout returned by thread/resume', async () => {
    const threadId = '01a03d46-4176-7322-91e8-c4facd4903aa';
    const codexHome = await mkdtemp(join(tmpdir(), 'xangi-codex-'));
    const sessionsDir = join(codexHome, 'sessions', '2026', '08', '26');
    await mkdir(sessionsDir, { recursive: true });
    const rolloutPath = join(sessionsDir, `rollout-${threadId}.jsonl`);
    const rollout = [
      { type: 'session_meta', payload: { id: threadId } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { total_tokens: 23_935 }, model_context_window: 258_400 },
        },
      },
    ]
      .map(JSON.stringify)
      .join('\n');
    await writeFile(rolloutPath, `${rollout}\n`);
    const appServerOutput = [
      { id: 1, result: { codexHome } },
      { id: 2, result: { thread: { path: rolloutPath } } },
    ]
      .map(JSON.stringify)
      .join('\n');

    await expect(readCodexContextUsage(threadId, async () => appServerOutput)).resolves.toEqual({
      usedTokens: 23_935,
      contextWindow: 258_400,
    });
    expect(parseCodexRolloutContextUsage(rollout, threadId)).toEqual({
      usedTokens: 23_935,
      contextWindow: 258_400,
    });
  });

  it('rejects a rollout outside the Codex sessions directory', async () => {
    const threadId = '01a03d46-4176-7322-91e8-c4facd4903aa';
    const codexHome = await mkdtemp(join(tmpdir(), 'xangi-codex-'));
    await mkdir(join(codexHome, 'sessions'));
    const rolloutPath = join(codexHome, `rollout-${threadId}.jsonl`);
    await writeFile(rolloutPath, '{}\n');
    const output = [
      { id: 1, result: { codexHome } },
      { id: 2, result: { thread: { path: rolloutPath } } },
    ]
      .map(JSON.stringify)
      .join('\n');
    await expect(readCodexContextUsage(threadId, async () => output)).resolves.toBeUndefined();
  });

  it('derives Claude context from the final iteration and model window', () => {
    expect(
      extractClaudeContextUsage({
        usage: {
          iterations: [
            { input_tokens: 10, cache_read_input_tokens: 20 },
            { input_tokens: 100, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 300 },
          ],
        },
        modelUsage: { 'claude-opus': { contextWindow: 200_000 } },
      })
    ).toEqual({ contextTokens: 2_400, contextWindow: 200_000 });
  });

  it('parses Claude get_usage five-hour and weekly windows with plan type', () => {
    const output = claudeOutput({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: '2026-09-01T12:00:00.000Z' },
        seven_day: { utilization: 61, resets_at: '2026-09-05T12:00:00.000Z' },
      },
    });

    expect(parseClaudeUsage(output)).toEqual([
      {
        id: 'claude',
        label: 'アカウント枠',
        planType: 'max',
        windows: [
          {
            label: '5時間',
            usedPercent: 42,
            windowDurationMins: 300,
            resetsAt: Date.parse('2026-09-01T12:00:00.000Z') / 1000,
          },
          {
            label: '週次',
            usedPercent: 61,
            windowDurationMins: 10_080,
            resetsAt: Date.parse('2026-09-05T12:00:00.000Z') / 1000,
          },
        ],
      },
    ]);
  });

  it('includes model-scoped weekly windows labeled by display name', () => {
    const output = claudeOutput({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 10, resets_at: '2026-09-01T12:00:00.000Z' },
        model_scoped: [
          { display_name: 'Opus', utilization: 88, resets_at: '2026-09-05T12:00:00.000Z' },
        ],
      },
    });

    const groups = parseClaudeUsage(output);
    expect(groups[0].windows).toContainEqual({
      label: 'Opus週次',
      usedPercent: 88,
      windowDurationMins: 10_080,
      resetsAt: Date.parse('2026-09-05T12:00:00.000Z') / 1000,
    });
  });

  it('never surfaces unreleased codename keys or extra usage', () => {
    const output = claudeOutput({
      subscription_type: 'max',
      rate_limits_available: true,
      member_dashboard_available: true,
      rate_limits: {
        five_hour: { utilization: 20, resets_at: '2026-09-01T12:00:00.000Z' },
        seven_day: { utilization: 30, resets_at: '2026-09-05T12:00:00.000Z' },
        seven_day_opus: { utilization: 40, resets_at: '2026-09-05T12:00:00.000Z' },
        model_scoped: [
          { display_name: 'Opus', utilization: 50, resets_at: '2026-09-05T12:00:00.000Z' },
        ],
        nimbus_quill: { utilization: 5, resets_at: '2026-09-05T12:00:00.000Z' },
        extra_usage: { used_credits: 12.34, limit_dollars: 20, remaining_dollars: 7.66 },
      },
    });

    const groups = parseClaudeUsage(output);
    const labels = groups[0].windows.map((window) => window.label);
    expect(labels).toEqual(['5時間', '週次', 'Opus週次']);
    const serialized = JSON.stringify(groups);
    expect(serialized).not.toContain('nimbus_quill');
    expect(serialized).not.toContain('used_credits');
    expect(serialized).not.toContain('12.34');
    expect(serialized).not.toContain('member_dashboard_available');
  });

  it('returns no groups when rate limits are unavailable', () => {
    const output = claudeOutput({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    });
    expect(parseClaudeUsage(output)).toEqual([]);
  });

  it('returns no groups for a control error response', () => {
    const errorOutput = `${JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: '1', error: 'boom' },
    })}\n`;
    expect(parseClaudeUsage(errorOutput)).toEqual([]);

    const mismatchedRequestId = `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '2',
        response: {
          subscription_type: 'max',
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 10, resets_at: null } },
        },
      },
    })}\n`;
    expect(parseClaudeUsage(mismatchedRequestId)).toEqual([]);
  });

  it('clamps utilization and omits pace for null reset times', () => {
    const output = claudeOutput({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 150, resets_at: null },
      },
    });

    expect(parseClaudeUsage(output)).toEqual([
      {
        id: 'claude',
        label: 'アカウント枠',
        planType: 'pro',
        windows: [
          { label: '5時間', usedPercent: 100, windowDurationMins: 300, resetsAt: undefined },
        ],
      },
    ]);
  });

  it('ignores surrounding stream noise and malformed model-scoped entries', () => {
    const output = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'probe' }),
      '{"type":"system","truncated',
      claudeOutput({
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 7, resets_at: 'not-a-timestamp' },
          model_scoped: [
            { display_name: 'Opus', utilization: 20, resets_at: '2026-09-05T12:00:00.000Z' },
            { display_name: 42, utilization: 99, resets_at: '2026-09-05T12:00:00.000Z' },
          ],
        },
      }).trim(),
    ].join('\n');

    expect(parseClaudeUsage(output)).toEqual([
      {
        id: 'claude',
        label: 'アカウント枠',
        planType: 'pro',
        windows: [
          { label: '5時間', usedPercent: 7, windowDurationMins: 300, resetsAt: undefined },
          {
            label: 'Opus週次',
            usedPercent: 20,
            windowDurationMins: 10_080,
            resetsAt: Date.parse('2026-09-05T12:00:00.000Z') / 1000,
          },
        ],
      },
    ]);
  });

  it('reads Claude usage through an injected runner', async () => {
    await expect(
      readClaudeUsage(async () =>
        claudeOutput({
          subscription_type: 'max',
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 15, resets_at: '2026-09-01T12:00:00.000Z' },
          },
        })
      )
    ).resolves.toEqual({
      id: 'claude-code',
      label: 'Claude Code',
      groups: [
        {
          id: 'claude',
          label: 'アカウント枠',
          planType: 'max',
          windows: [
            {
              label: '5時間',
              usedPercent: 15,
              windowDurationMins: 300,
              resetsAt: Date.parse('2026-09-01T12:00:00.000Z') / 1000,
            },
          ],
        },
      ],
    });

    await expect(
      readClaudeUsage(async () =>
        claudeOutput({
          subscription_type: null,
          rate_limits_available: false,
          rate_limits: null,
        })
      )
    ).rejects.toThrow(/no account rate limits/);
  });
});
