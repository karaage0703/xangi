import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SecretFilter,
  SecretOutputStream,
  secretFilterFromEnv,
  SECRET_REPLACEMENT,
  SECRET_BLOCK_NOTICE,
  SECRET_AI_WARNING,
  SecretFilterBlockedError,
} from '../src/secret-filter.js';
import { filterRunError, filterStreamCallbacks } from '../src/secret-filter-runner.js';
import { privacyConsole, withPrivateDiagnostics } from '../src/privacy-console.js';
import { NonRetryableError } from '../src/errors.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('exact-value secret filter', () => {
  it('defaults ON and only disables filtering when explicitly set to false', () => {
    for (const flag of [undefined, 'true', '', 'invalid']) {
      const filter = secretFilterFromEnv({
        DEMO_TOKEN: 'dummy-secret',
        XANGI_SECRET_FILTER_ENABLED: flag,
      });
      expect(filter.redact('dummy-secret')).toBe(SECRET_REPLACEMENT);
      expect(() => filter.assertSafe('dummy-secret')).toThrow(SecretFilterBlockedError);
    }
    const off = secretFilterFromEnv({
      DEMO_TOKEN: 'dummy-secret',
      XANGI_SECRET_FILTER_ENABLED: 'false',
    });
    expect(off.redactForAI('dummy-secret')).toBe('dummy-secret');
    expect(() => off.assertSafe('dummy-secret')).not.toThrow();
    const value = { token: 'dummy-secret' };
    expect(off.redactValue(value)).toBe(value);
    expect(() => off.assertFileSafe('/nonexistent-file')).not.toThrow();
  });

  it('adds one fixed warning instruction only when data was detected', () => {
    const filter = new SecretFilter(['dummy-secret']);
    const safe = filter.redactForAI('read dummy-secret');
    expect(safe).toBe(`read ${SECRET_REPLACEMENT}\n\n${SECRET_AI_WARNING}`);
    expect(filter.redactForAI(safe)).toBe(safe);
    expect(filter.redactForAI('ordinary text')).toBe('ordinary text');
    try {
      filter.assertSafe('dummy-secret');
    } catch (error) {
      expect((error as Error).message).toContain(SECRET_AI_WARNING);
      expect((error as Error).message).not.toContain('dummy-secret');
    }
  });
  it('also matches JSON-escaped and URL-encoded representations of known values', () => {
    const value = 'dummy-"password\\\n🔑';
    const filter = new SecretFilter([value]);
    expect(filter.redact(JSON.stringify({ value }))).toBe(
      JSON.stringify({ value: SECRET_REPLACEMENT })
    );
    expect(filter.redact(`https://example.invalid/?key=${encodeURIComponent(value)}`)).toBe(
      `https://example.invalid/?key=${SECRET_REPLACEMENT}`
    );
  });
  it('matches literal metacharacters, duplicates, empty values and overlapping values', () => {
    const filter = new SecretFilter(['abc', 'abcdef', 'a.$&[x]\\', 'abcdef', '']);
    expect(filter.redact('abcdef and a.$&[x]\\ and abc')).toBe(
      `${SECRET_REPLACEMENT} and ${SECRET_REPLACEMENT} and ${SECRET_REPLACEMENT}`
    );
    expect(filter.redact('ordinary UUID-like-id 0193-abcde')).toContain(SECRET_REPLACEMENT);
    expect(new SecretFilter([]).redact('normal')).toBe('normal');
  });

  it('registers only nonempty credential env values and explicit extra names', () => {
    const filter = secretFilterFromEnv({
      DISCORD_TOKEN: 'discord-dummy',
      DB_PASSWORD: 'p@ssword-dummy',
      SERVICE_ACCESS_TOKEN: 'service-account-dummy',
      ANTHROPIC_API_KEY: 'api-dummy',
      PRIVATE_KEY: 'private-dummy',
      LOCAL_LLM_MAX_TOKENS: '500',
      WORKSPACE_PATH: '/normal/path',
      EMPTY_TOKEN: '',
      URI_TOKEN: 'credential://fixture/value',
      CUSTOM: 'custom-dummy',
      XANGI_SECRET_FILTER_ENV_KEYS: ' CUSTOM , ',
    });
    for (const value of [
      'discord-dummy',
      'p@ssword-dummy',
      'service-account-dummy',
      'api-dummy',
      'private-dummy',
      'custom-dummy',
      'credential://fixture/value',
    ])
      expect(filter.contains(value)).toBe(true);
    for (const value of ['500', '/normal/path', 'CUSTOM'])
      expect(filter.contains(value)).toBe(false);
  });

  it('redacts nested values, keys, errors and circular diagnostics without mutation', () => {
    const filter = new SecretFilter(['dummy-secret']);
    const input = {
      nested: [{ 'dummy-secret': 'contains dummy-secret' }],
      error: new Error('dummy-secret'),
    };
    const safe = filter.redactValue(input);
    expect(JSON.stringify(safe)).not.toContain('dummy-secret');
    expect(input.nested[0]['dummy-secret']).toContain('dummy-secret');
    const circular: Record<string, unknown> = { text: 'dummy-secret' };
    circular.self = circular;
    const output = filter.redactValue(circular);
    expect(output.self).toBe(output);
    expect(output.text).toBe(SECRET_REPLACEMENT);
    expect(() => filter.assertValueSafe({ nested: ['dummy-secret'] })).toThrow(SECRET_BLOCK_NOTICE);
  });

  it('does not echo secret values in rejection errors', () => {
    const filter = new SecretFilter(['dummy-secret']);
    expect(() => filter.assertSafe('contains dummy-secret')).toThrow(SECRET_BLOCK_NOTICE);
    const error = filterRunError(new Error('bad dummy-secret'), filter) as Error;
    expect(error.stack).not.toContain('dummy-secret');
  });

  it('preserves non-retryable error semantics while masking extra diagnostics', () => {
    const filter = new SecretFilter(['dummy-secret']);
    const original = Object.assign(new NonRetryableError('dummy-secret'), {
      config: { authorization: 'dummy-secret' },
    });
    const safe = filterRunError(original, filter) as typeof original;
    expect(safe).toBeInstanceOf(NonRetryableError);
    expect(safe.retryable).toBe(false);
    expect(safe.stack).not.toContain('dummy-secret');
    expect(JSON.stringify(safe)).not.toContain('dummy-secret');
    expect(original.message).toBe('dummy-secret');
  });

  it('scans UTF-8 file bytes across 64KiB boundaries and fails closed on unreadable files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'secret-filter-'));
    try {
      const file = join(directory, 'file.bin');
      const filter = new SecretFilter(['dummy-secret-🔑']);
      writeFileSync(file, Buffer.concat([Buffer.alloc(65530, 0), Buffer.from('dummy-secret-🔑')]));
      expect(() => filter.assertFileSafe(file)).toThrow('送信を停止');
      writeFileSync(file, 'normal output');
      expect(() => filter.assertFileSafe(file)).not.toThrow();
      expect(() => filter.assertFileSafe(join(directory, 'missing'))).toThrow('検査に失敗');
      expect(() => filter.assertFileSafe(directory)).toThrow('検査に失敗');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('streaming secret filter', () => {
  it('never emits a known secret for every possible split point', () => {
    const token = 'dummy-secret-🔑';
    for (let index = 0; index <= token.length; index++) {
      const stream = new SecretOutputStream(new SecretFilter([token]));
      const first = stream.push(`safe ${token.slice(0, index)}`);
      const second = stream.push(`${token.slice(index)} end`);
      expect(first + second + stream.finish()).toBe(index === token.length ? '' : 'safe ');
      expect(stream.blocked).toBe(true);
    }
  });

  it('preserves normal text and resolves an ambiguous prefix across character chunks', () => {
    const stream = new SecretOutputStream(new SecretFilter(['abcd', 'abxyz']));
    let output = '';
    for (const char of 'normal abcx and abxy!') output += stream.push(char);
    output += stream.finish();
    expect(output).toBe('normal abcx and abxy!');
    expect(stream.blocked).toBe(false);
  });

  it('suppresses leaked stream even when the final provider result omits it', () => {
    const onText = vi.fn();
    const onToolUse = vi.fn();
    const guard = filterStreamCallbacks({ onText, onToolUse }, new SecretFilter(['dummy-secret']));
    guard.callbacks.onText?.('safe dummy-', 'safe dummy-');
    expect(onText).toHaveBeenLastCalledWith('safe ', 'safe ');
    guard.callbacks.onText?.('secret', 'safe dummy-secret');
    guard.callbacks.onToolUse?.('read', { output: 'dummy-secret' });
    const result = guard.finish({
      result: 'done',
      sessionId: 'session',
      attachments: ['/tmp/file'],
    });
    expect(result).toMatchObject({
      result: SECRET_BLOCK_NOTICE,
      failed: true,
      attachments: undefined,
    });
    expect(JSON.stringify(onText.mock.calls)).not.toContain('dummy-');
    expect(onToolUse).toHaveBeenCalledWith('read', { output: SECRET_REPLACEMENT });
  });

  it('flushes ordinary suffixes and masks user input on both sides', async () => {
    const onText = vi.fn();
    const onUserInput = vi.fn(async () => ({ answers: { q: ['dummy-secret'] } }));
    const guard = filterStreamCallbacks(
      { onText, onUserInput },
      new SecretFilter(['dummy-secret'])
    );
    guard.callbacks.onText?.('normal dummy', 'normal dummy');
    const result = { result: 'normal dummy', sessionId: 'session' };
    expect(guard.finish(result)).toBe(result);
    expect(onText.mock.calls.map(([text]) => text).join('')).toBe('normal dummy');
    const answer = await guard.callbacks.onUserInput!(
      {
        questions: [
          {
            id: 'q',
            header: '',
            question: 'dummy-secret',
            options: [],
            multiSelect: false,
            allowFreeText: true,
          },
        ],
      },
      new AbortController().signal
    );
    expect(JSON.stringify(answer)).not.toContain('dummy-secret');
    expect(JSON.stringify(onUserInput.mock.calls)).not.toContain('dummy-secret');
  });

  it('preserves backend snapshot replacement semantics rather than concatenating messages', () => {
    const onText = vi.fn();
    const guard = filterStreamCallbacks({ onText }, new SecretFilter(['dummy-secret']));
    guard.callbacks.onText?.('first message', 'first message');
    guard.callbacks.onText?.('second message', 'second message');
    guard.finish({ result: 'second message', sessionId: 'session' });
    expect(onText).toHaveBeenLastCalledWith('second message', 'second message');
  });
});

it('redacts known values in diagnostics and retains private-execution suppression', () => {
  vi.stubEnv('DISCORD_TOKEN', 'diagnostic-dummy-secret');
  const output = vi.spyOn(globalThis.console, 'log').mockImplementation(() => {});
  privacyConsole.log('diagnostic-dummy-secret', { message: 'diagnostic-dummy-secret' });
  expect(JSON.stringify(output.mock.calls)).not.toContain('diagnostic-dummy-secret');
  expect(output).toHaveBeenCalledOnce();
  withPrivateDiagnostics(true, () => privacyConsole.log('private'));
  expect(output).toHaveBeenCalledOnce();
});
