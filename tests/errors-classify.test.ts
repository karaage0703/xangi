import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyAgentError,
  formatErrorDiagnostic,
  formatAgentErrorForUser,
  shouldSendErrorFollowUp,
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

describe('shouldSendErrorFollowUp', () => {
  it.each([
    ['timed out after 300000ms', false],
    ['Circuit breaker OPEN', false],
    ["You've hit your usage limit", false],
    ["You've hit your session limit · resets 5am (Asia/Tokyo)", false],
    ...claudeLimitErrors.map((message) => [message, false]),
    ['Request cancelled by user', false],
    [
      'write_to_file: /workspace/a.md is not a valid artifact path; artifacts must be in /brain/',
      false,
    ],
    ['Process exited unexpectedly with code 143', true],
    ['Some random error', true],
  ])('%s → %s', (message, expected) => {
    expect(shouldSendErrorFollowUp(new Error(message))).toBe(expected);
  });
});

describe('consumeRestartNote', () => {
  beforeEach(() => {
    resetRestartNoteStateForTest();
  });

  it('既存セッションがあるチャンネルの初回だけ注記を返す', () => {
    const note = consumeRestartNote('ch1', true);
    expect(note).toContain('再起動');
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
