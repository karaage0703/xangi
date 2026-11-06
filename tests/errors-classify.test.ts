import { describe, it, expect, beforeEach } from 'vitest';
import { inspect } from 'node:util';
import {
  AntigravityTurnError,
  AntigravityTimeoutError,
  IncompleteAgentTurnError,
  LlmTimeoutError,
  classifyAgentError,
  formatErrorDiagnostic,
  formatAgentErrorForUser,
  formatAntigravityTimeoutWithPartial,
  isNonRetryableError,
} from '../src/errors.js';
import { consumeRestartNote, resetRestartNoteStateForTest } from '../src/restart-note.js';

const claudeLimitErrors = [
  "You've hit your session limit · resets 3:45pm",
  "You've hit your weekly limit · resets Mon 12:00am",
  "You've hit your Opus limit · resets 3:45pm",
  "You've hit your Sonnet limit · resets 3:45pm",
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
  "You've hit your individual spend limit · ask your admin for a higher limit",
  "You've hit your org's monthly spend limit · visit claude.ai/admin-settings/usage to raise it",
  "You've hit your team's shared budget · ask your admin to raise it at claude.ai/admin-settings/usage",
  "You've hit your channel's monthly spend limit · an org owner or channel manager can raise it in the channel's Claude settings",
];

describe('classifyAgentError', () => {
  it('keeps Agy print timeouts non-retryable and displays partial output with a distinct notice', () => {
    const error = new AntigravityTimeoutError(
      'terminated tasks: task-1',
      'session',
      'Partial answer'
    );
    expect(classifyAgentError(error)).toBe('antigravity-print-timeout');
    expect(isNonRetryableError(error)).toBe(true);
    expect(formatAgentErrorForUser(error)).toContain('自動再実行はしていません');
    expect(formatAgentErrorForUser(error)).not.toContain('Partial answer');
    expect(formatAntigravityTimeoutWithPartial(error)).toContain('Partial answer');
    expect(formatAgentErrorForUser(error)).toContain('task-1');
  });

  it('keeps long timeout answers out of generic notifications and error logs', () => {
    const partial = 'PRIVATE_PARTIAL_ANSWER'.repeat(500);
    const error = new AntigravityTimeoutError('x'.repeat(5000), 'session', partial);
    expect(error.partialResponse).toBe(partial);
    expect(formatAgentErrorForUser(error).length).toBeLessThan(1000);
    expect(error.message).not.toContain('PRIVATE_PARTIAL_ANSWER');
    expect(inspect(error, { depth: null })).not.toContain('PRIVATE_PARTIAL_ANSWER');
    expect(JSON.stringify(error)).not.toContain('PRIVATE_PARTIAL_ANSWER');
    expect(formatErrorDiagnostic(error)).not.toContain('PRIVATE_PARTIAL_ANSWER');
    expect(formatAntigravityTimeoutWithPartial(error)).toContain(partial);
    const bounded = formatAntigravityTimeoutWithPartial(error, 2000);
    expect(bounded.length).toBeLessThanOrEqual(2000);
    expect(bounded).toContain('PRIVATE_PARTIAL_ANSWER');
    expect(bounded).toMatch(/…（以下省略）$/);
  });

  it('does not split surrogate pairs when truncating an explicitly displayed partial answer', () => {
    const error = new AntigravityTimeoutError('timeout', undefined, '😀'.repeat(3000));
    const text = formatAntigravityTimeoutWithPartial(error, 2000);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/…（以下省略）$/);
    expect(text.isWellFormed()).toBe(true);
  });

  it('classifies structured Agy interruptions without relying on message text', () => {
    const error = new AntigravityTurnError('interrupted', 'ETIMEDOUT from a stopped turn');
    expect(classifyAgentError(error)).toBe('antigravity-interrupted');
    expect(isNonRetryableError(error)).toBe(true);
    expect(formatAgentErrorForUser(error)).toContain('中断');
  });

  it('preserves hook messages even when they resemble other error kinds', () => {
    const error = new AntigravityTurnError('error', 'Policy blocked: validation timed out');
    expect(classifyAgentError(error)).toBe('antigravity-terminated');
    expect(isNonRetryableError(error)).toBe(true);
    expect(formatAgentErrorForUser(error)).toContain('Policy blocked: validation timed out');
  });

  it.each([
    ['Request cancelled by user', 'cancelled'],
    ['Claude Code CLI timed out after 300000ms', 'timeout'],
    ['Request timed out after 600000ms. Killing process.', 'timeout'],
    ['Process exited unexpectedly with code 143', 'crash'],
    ['Circuit breaker OPEN. Rejecting all queued requests.', 'circuit-breaker'],
    ["Codex CLI exited with code 1: You've hit your usage limit. Upgrade to Pro", 'usage-limit'],
    ["Error: You've hit your limit · resets 1pm (Asia/Tokyo)", 'usage-limit'],
    ["You've hit your session limit · resets 5am (Asia/Tokyo)", 'usage-limit'],
    ...claudeLimitErrors.map((message) => [message, 'usage-limit']),
    [
      'declaring permissions: cortex tool write_to_file: /workspace/a.md is not a valid artifact path; artifacts must be in /home/user/.gemini/antigravity-cli/brain/conv/',
      'antigravity-artifact-path',
    ],
    ['Something completely different', 'unknown'],
    ["You've hit your session · unrelated limit", 'unknown'],
  ])('%s → %s', (message, expected) => {
    expect(classifyAgentError(new Error(message))).toBe(expected);
  });

  it('Error 以外（文字列）も判別できる', () => {
    expect(classifyAgentError('timed out somewhere')).toBe('timeout');
  });
});

describe('formatAgentErrorForUser', () => {
  it('タイムアウトは秒数付きで整形する', () => {
    const msg = formatAgentErrorForUser(new Error('timed out after 300000ms'), {
      timeoutMs: 300000,
    });
    expect(msg).toBe('⏱️ タイムアウトしました（300秒）');
  });

  it('タイムアウト（秒数情報なし）', () => {
    expect(formatAgentErrorForUser(new Error('timed out'))).toBe('⏱️ タイムアウトしました');
  });

  it('利用上限は専用メッセージ', () => {
    const msg = formatAgentErrorForUser(
      new Error("You've hit your session limit · resets 5am (Asia/Tokyo)")
    );
    expect(msg).toContain('💳');
    expect(msg).toContain('利用上限');
  });

  it('不明なエラーは 200 字に切り詰めて表示', () => {
    const long = 'x'.repeat(500);
    const msg = formatAgentErrorForUser(new Error(long));
    expect(msg.length).toBeLessThan(250);
    expect(msg).toContain('❌');
  });

  it('Agyのartifact誤判定は再試行を促す専用メッセージ', () => {
    const msg = formatAgentErrorForUser(
      new Error(
        'write_to_file: /workspace/a.md is not a valid artifact path; artifacts must be in /brain/'
      )
    );
    expect(msg).toContain('Agy');
    expect(msg).toContain('自動回復');
  });
});

describe('formatErrorDiagnostic', () => {
  it('Antigravity provider diagnosticsをログ向けに整形する', () => {
    const error = Object.assign(new Error('quota exceeded'), {
      providerDiagnostic: {
        antigravity: {
          short_error: 'quota exceeded',
          status: 'RESOURCE_EXHAUSTED',
          code_kind: 'http',
          error_code: 429,
          retryable: true,
          error_id: 'agy-error-1',
        },
      },
    });

    expect(formatErrorDiagnostic(error)).toContain(
      'providerDiagnostic.antigravity(status=RESOURCE_EXHAUSTED, code_kind=http, error_code=429, retryable=true, error_id=agy-error-1)'
    );
  });
});

describe('consumeRestartNote', () => {
  beforeEach(() => {
    resetRestartNoteStateForTest();
  });

  it('既存セッションがあるチャンネルの初回だけ注記を返す', () => {
    const note = consumeRestartNote('ch1', true);
    expect(note).toContain('restart');
    expect(note).toContain('rejected');
    // 2 回目は null
    expect(consumeRestartNote('ch1', true)).toBeNull();
  });

  it('新規セッション（resume なし）なら注記しない', () => {
    expect(consumeRestartNote('ch2', false)).toBeNull();
    // 同じチャンネルで後からセッションが出来ても、初回判定は消費済み
    expect(consumeRestartNote('ch2', true)).toBeNull();
  });

  it('チャンネルごとに独立して一度ずつ返す', () => {
    expect(consumeRestartNote('ch3', true)).not.toBeNull();
    expect(consumeRestartNote('ch4', true)).not.toBeNull();
    expect(consumeRestartNote('ch3', true)).toBeNull();
  });
});

it('reports an incomplete turn without automatic follow-up', () => {
  const error = new IncompleteAgentTurnError('Codex', 'test-thread');
  expect(classifyAgentError(error)).toBe('incomplete-turn');
  expect(formatAgentErrorForUser(error)).toContain('完了通知を受け取れない');
  expect(formatAgentErrorForUser(error)).toContain('自動再実行はしていません');
  expect(error.retryable).toBe(false);
});

it('shows the model deadline instead of the enclosing turn deadline', () => {
  expect(
    formatAgentErrorForUser(new LlmTimeoutError(1_800_000, false), { timeoutMs: 3_600_000 })
  ).toBe('⏱️ LLM応答待ちがタイムアウトしました（1800秒）');
  expect(
    formatAgentErrorForUser(new LlmTimeoutError(1_800_000, true), { timeoutMs: 3_600_000 })
  ).toBe('⏱️ LLM受信待ちがタイムアウトしました（1800秒）');
});
