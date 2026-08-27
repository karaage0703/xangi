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
  readCodexContextUsage,
} from '../src/usage-monitor.js';
import { extractClaudeContextUsage } from '../src/claude-code.js';

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
      })
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
        quota: {
          '3p-weekly': {
            remaining_fraction: 1,
            reset_time: '2026-09-02T00:00:00.000Z',
          },
          'gemini-weekly': {
            remaining_fraction: 0.75,
            reset_time: '2026-09-01T00:00:00.000Z',
          },
        },
      })
    ).toEqual({
      conversationId: 'conversation-1',
      context: { usedTokens: 125_000, contextWindow: 1_000_000 },
      groups: [
        {
          id: '3p-weekly',
          label: 'サードパーティモデル',
          planType: 'Pro',
          windows: [
            {
              label: '週次',
              usedPercent: 0,
              resetsAt: Date.parse('2026-09-02T00:00:00.000Z') / 1000,
            },
          ],
        },
        {
          id: 'gemini-weekly',
          label: 'Geminiモデル',
          planType: 'Pro',
          windows: [
            {
              label: '週次',
              usedPercent: 25,
              resetsAt: Date.parse('2026-09-01T00:00:00.000Z') / 1000,
            },
          ],
        },
      ],
    });
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
});
