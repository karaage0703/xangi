import { describe, expect, it } from 'vitest';
import { parseAntigravityStderrError } from '../src/antigravity-output.js';

const REAL_AGY_ERROR = {
  short_error:
    'agent executor error: generating and executing: Error 401, Message: fixture unauthorized, Status: UNAUTHENTICATED, Details: []',
  status: 'UNAUTHENTICATED',
  error_code: 401,
  code_kind: 'http',
  retryable: false,
  error_id: '138ee442-3372-48a7-b37c-157dbec7923d-1',
};

describe('parseAntigravityStderrError', () => {
  it('parses and validates the Agy 1.2.6 structured error fields', () => {
    expect(
      parseAntigravityStderrError(
        `warning before\n  AGY_ERROR: ${JSON.stringify(REAL_AGY_ERROR)}\r\n`
      )
    ).toEqual(REAL_AGY_ERROR);
  });

  it('does not parse quoted, malformed, or invalid markers', () => {
    expect(
      parseAntigravityStderrError(`diagnostic quoted AGY_ERROR: ${JSON.stringify(REAL_AGY_ERROR)}`)
    ).toBeUndefined();
    expect(parseAntigravityStderrError('AGY_ERROR: {"short_error":')).toBeUndefined();
    expect(
      parseAntigravityStderrError(
        `AGY_ERROR: ${JSON.stringify({ ...REAL_AGY_ERROR, retryable: 'false' })}`
      )
    ).toBeUndefined();
  });

  it.each(['\u001b[31mred', 'nul\u0000byte', 'bell\u0007tone'])(
    'rejects short_error containing control characters: %j',
    (shortError) => {
      expect(
        parseAntigravityStderrError(
          `AGY_ERROR: ${JSON.stringify({ ...REAL_AGY_ERROR, short_error: shortError })}`
        )
      ).toBeUndefined();
    }
  );

  it('normalizes whitespace controls in short_error', () => {
    expect(
      parseAntigravityStderrError(
        `AGY_ERROR: ${JSON.stringify({ ...REAL_AGY_ERROR, short_error: 'first\n\tsecond\rthird' })}`
      )?.short_error
    ).toBe('first second third');
  });

  it('bounds short_error without splitting a Unicode code point', () => {
    const parsed = parseAntigravityStderrError(
      `AGY_ERROR: ${JSON.stringify({ short_error: `${'x'.repeat(1_999)}😀tail` })}`
    );
    expect([...parsed!.short_error]).toHaveLength(2_000);
    expect(parsed!.short_error.endsWith('😀')).toBe(true);
  });
});
