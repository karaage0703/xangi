import { describe, it, expect } from 'vitest';
import {
  hashId,
  sanitizeArgs,
  sanitizeAndTruncateArgs,
  sanitizeAndTruncateResult,
  sanitizeAndTruncateRawText,
  maskHomePath,
  maskUrlSecrets,
  truncate,
} from '../src/tool-trajectory/sanitize.js';

describe('tool-trajectory sanitize', () => {
  it('hashId produces stable 12-char hash with prefix', () => {
    const a = hashId('user-123', 'salt');
    const b = hashId('user-123', 'salt');
    expect(a).toBe(b);
    expect(a.startsWith('h_')).toBe(true);
    expect(a.length).toBe(14); // 'h_' + 12 hex chars
  });

  it('hashId with different salt produces different hash', () => {
    const a = hashId('user-123', 'salt-a');
    const b = hashId('user-123', 'salt-b');
    expect(a).not.toBe(b);
  });

  it('hashId returns empty string for empty input', () => {
    expect(hashId('', 'salt')).toBe('');
  });

  it('maskHomePath replaces home prefix with $HOME literal', () => {
    expect(maskHomePath('/home/karaage/foo.txt', '/home/karaage')).toBe('$HOME/foo.txt');
    expect(maskHomePath('not a path', '/home/karaage')).toBe('not a path');
  });

  it('maskHomePath escapes regex special chars in home', () => {
    // /home/user.x.y is treated literally (dot is escaped)
    expect(maskHomePath('/home/user.x.y/file', '/home/user.x.y')).toBe('$HOME/file');
    // a path that would only match if dot was unescaped should NOT match
    expect(maskHomePath('/home/userxxy/file', '/home/user.x.y')).toBe('/home/userxxy/file');
  });

  it('maskUrlSecrets redacts secret-like query values', () => {
    const url = 'https://api.example.com/v1?token=SECRET123&q=hello&apikey=AAAA';
    const masked = maskUrlSecrets(url);
    expect(masked).toContain('token=[REDACTED_SECRET]');
    expect(masked).toContain('apikey=[REDACTED_SECRET]');
    expect(masked).toContain('q=hello'); // non-secret keys preserved
  });

  it('truncate keeps short strings intact', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('truncate produces head+omit+tail format for long strings', () => {
    const long = 'a'.repeat(1000);
    const out = truncate(long, 100);
    expect(out.length).toBeLessThan(1000);
    expect(out).toContain('chars truncated');
  });

  it('sanitizeArgs redacts secret-like keys at any nesting depth', () => {
    const args = {
      url: 'https://example.com',
      apiKey: 'secret-key-123',
      nested: {
        token: 'inner-token',
        safe_field: 'visible',
      },
      list: [{ password: 'pw1' }, { name: 'n' }],
    };
    const out = sanitizeArgs(args, { salt: 's' }) as Record<string, unknown>;
    expect(out.apiKey).toBe('[REDACTED_SECRET]');
    expect((out.nested as Record<string, unknown>).token).toBe('[REDACTED_SECRET]');
    expect((out.nested as Record<string, unknown>).safe_field).toBe('visible');
    expect(((out.list as Record<string, unknown>[])[0] as Record<string, unknown>).password).toBe(
      '[REDACTED_SECRET]'
    );
    expect(((out.list as Record<string, unknown>[])[1] as Record<string, unknown>).name).toBe('n');
  });

  it('sanitizeArgs masks $HOME in string values', () => {
    const args = { path: '/home/karaage/borot/notes/foo.md' };
    const out = sanitizeArgs(args, { salt: 's', home: '/home/karaage' }) as Record<string, unknown>;
    expect(out.path).toBe('$HOME/borot/notes/foo.md');
  });

  it('sanitizeArgs preserves primitives (number, boolean, null)', () => {
    const args = { n: 42, b: true, x: null };
    const out = sanitizeArgs(args, { salt: 's' }) as Record<string, unknown>;
    expect(out.n).toBe(42);
    expect(out.b).toBe(true);
    expect(out.x).toBe(null);
  });

  it('sanitizeAndTruncateArgs returns truncated marker shape for oversize args', () => {
    const big = { huge: 'x'.repeat(20000) };
    const out = sanitizeAndTruncateArgs(big, { salt: 's', maxArgsChars: 100 }) as Record<
      string,
      unknown
    >;
    expect(out.__truncated__).toBe(true);
    expect(out.original_length).toBeGreaterThan(100);
    expect(typeof out.head).toBe('string');
  });

  it('sanitizeAndTruncateResult applies $HOME + URL sanitize + truncate', () => {
    const text = `error at /home/karaage/foo.ts\nhttps://api.example.com?token=ABC&x=1\n${'long '.repeat(500)}`;
    const out = sanitizeAndTruncateResult(text, {
      salt: 's',
      home: '/home/karaage',
      maxResultChars: 200,
    });
    expect(out).toContain('$HOME/foo.ts');
    expect(out).toContain('token=[REDACTED_SECRET]');
    expect(out.length).toBeLessThan(text.length);
  });

  it('sanitizeAndTruncateRawText uses default 2KB limit', () => {
    const text = 'a'.repeat(5000);
    const out = sanitizeAndTruncateRawText(text, { salt: 's' });
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain('chars truncated');
  });
});
