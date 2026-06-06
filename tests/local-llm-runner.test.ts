import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isSessionRelatedError,
  formatLlmError,
  LocalLlmRunner,
  loadMessagesFromTranscript,
} from '../src/local-llm/runner.js';
import type { TranscriptEntry } from '../src/transcript-logger.js';
import { FRIENDLY_FALLBACK_MESSAGE } from '../src/local-llm/pseudo-toolcall.js';

describe('isSessionRelatedError', () => {
  it('should return true for "context length exceeded"', () => {
    expect(isSessionRelatedError(new Error('context length exceeded'))).toBe(true);
  });

  it('should return true for "too many tokens"', () => {
    expect(isSessionRelatedError(new Error('too many tokens'))).toBe(true);
  });

  it('should return true for "max_tokens exceeded"', () => {
    expect(isSessionRelatedError(new Error('max_tokens exceeded'))).toBe(true);
  });

  it('should return true for "context window"', () => {
    expect(isSessionRelatedError(new Error('context window full'))).toBe(true);
  });

  it('should return true for "invalid message format"', () => {
    expect(isSessionRelatedError(new Error('invalid message format'))).toBe(true);
  });

  it('should return true for "malformed request"', () => {
    expect(isSessionRelatedError(new Error('malformed request'))).toBe(true);
  });

  it('should return true for "400 Bad Request"', () => {
    expect(isSessionRelatedError(new Error('400 Bad Request'))).toBe(true);
  });

  it('should return true for "422 Unprocessable"', () => {
    expect(isSessionRelatedError(new Error('422 Unprocessable Entity'))).toBe(true);
  });

  it('should return false for "network error"', () => {
    expect(isSessionRelatedError(new Error('network error'))).toBe(false);
  });

  it('should return false for "random error"', () => {
    expect(isSessionRelatedError(new Error('random error'))).toBe(false);
  });

  it('should return false for non-Error values', () => {
    expect(isSessionRelatedError('string error')).toBe(false);
    expect(isSessionRelatedError(null)).toBe(false);
    expect(isSessionRelatedError(undefined)).toBe(false);
    expect(isSessionRelatedError(42)).toBe(false);
  });
});

describe('formatLlmError', () => {
  it('should format ECONNREFUSED error', () => {
    const result = formatLlmError(new Error('ECONNREFUSED'));
    expect(result).toContain('LLMサーバーに接続できませんでした');
  });

  it('should format timeout error', () => {
    const result = formatLlmError(new Error('request timeout'));
    expect(result).toContain('タイムアウト');
  });

  it('should format 401 auth error', () => {
    const result = formatLlmError(new Error('401 Unauthorized'));
    expect(result).toContain('認証');
  });

  it('should format 429 rate limit error', () => {
    const result = formatLlmError(new Error('429 Too Many Requests'));
    expect(result).toContain('レートリミット');
  });

  it('should format 500 internal error', () => {
    const result = formatLlmError(new Error('500 Internal Server Error'));
    expect(result).toContain('内部エラー');
  });

  it('should format unknown error with message', () => {
    const result = formatLlmError(new Error('unknown'));
    expect(result).toContain('LLMエラー: unknown');
  });

  it('should handle non-Error values', () => {
    const result = formatLlmError('not an error');
    expect(result).toContain('予期しないエラー');
  });
});

describe('LocalLlmRunner liteMode', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['LOCAL_LLM_MODE', 'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL'];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
    // テスト用にデフォルト値を設定
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434';
    process.env.LOCAL_LLM_MODEL = 'test-model';
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('should default to all features enabled', () => {
    delete process.env.LOCAL_LLM_MODE;
    const runner = new LocalLlmRunner({ workdir: '/tmp', model: 'test' });
    expect(runner.enableTools).toBe(true);
    expect(runner.enableSkills).toBe(true);
    expect(runner.enableXangiCommands).toBe(true);
    expect(runner.enableTriggers).toBe(false);
  });

  it('should use lite defaults when LOCAL_LLM_MODE=lite', () => {
    process.env.LOCAL_LLM_MODE = 'lite';
    const runner = new LocalLlmRunner({ workdir: '/tmp', model: 'test' });
    expect(runner.enableTools).toBe(true);
    expect(runner.enableSkills).toBe(false);
    expect(runner.enableXangiCommands).toBe(true);
    expect(runner.enableTriggers).toBe(true);
  });

  it('should use chat defaults when LOCAL_LLM_MODE=chat', () => {
    process.env.LOCAL_LLM_MODE = 'chat';
    const runner = new LocalLlmRunner({ workdir: '/tmp', model: 'test' });
    expect(runner.enableTools).toBe(false);
    expect(runner.enableSkills).toBe(false);
    expect(runner.enableXangiCommands).toBe(false);
    expect(runner.enableTriggers).toBe(false);
  });

  it('should allow individual overrides over mode defaults', () => {
    process.env.LOCAL_LLM_MODE = 'chat';
    process.env.LOCAL_LLM_TOOLS = 'true';
    const runner = new LocalLlmRunner({ workdir: '/tmp', model: 'test' });
    expect(runner.enableTools).toBe(true);
    expect(runner.enableSkills).toBe(false);
  });
});

describe('loadMessagesFromTranscript', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'xangi-test-'));
    mkdirSync(join(workdir, 'logs', 'sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function writeJsonl(appSessionId: string, entries: TranscriptEntry[]): void {
    const path = join(workdir, 'logs', 'sessions', `${appSessionId}.jsonl`);
    const lines = entries.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(path, entries.length > 0 ? lines + '\n' : '');
  }

  it('returns empty array when no jsonl exists', () => {
    expect(loadMessagesFromTranscript(workdir, 'nonexistent')).toEqual([]);
  });

  it('restores user and assistant messages preserving order', () => {
    writeJsonl('sess1', [
      { id: 'm1', role: 'user', content: 'こんにちは', createdAt: '2026-05-17T15:21:00Z' },
      {
        id: 'm2',
        role: 'assistant',
        content: { result: 'やあ', sessionId: 'abc' },
        createdAt: '2026-05-17T15:21:01Z',
      },
      { id: 'm3', role: 'user', content: 'YouTubeまとめて', createdAt: '2026-05-17T15:22:00Z' },
    ]);

    const restored = loadMessagesFromTranscript(workdir, 'sess1');
    expect(restored).toEqual([
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'やあ' },
      { role: 'user', content: 'YouTubeまとめて' },
    ]);
  });

  it('skips error entries', () => {
    writeJsonl('sess2', [
      { id: 'm1', role: 'user', content: 'q1', createdAt: '2026-05-17T15:00:00Z' },
      { id: 'm2', role: 'error', content: 'LLM failed', createdAt: '2026-05-17T15:00:01Z' },
      {
        id: 'm3',
        role: 'assistant',
        content: { result: 'a1', sessionId: 'x' },
        createdAt: '2026-05-17T15:00:02Z',
      },
    ]);

    const restored = loadMessagesFromTranscript(workdir, 'sess2');
    expect(restored.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('accepts assistant content as plain string', () => {
    writeJsonl('sess3', [
      {
        id: 'm1',
        role: 'assistant',
        content: 'plain text response',
        createdAt: '2026-05-17T15:00:00Z',
      },
    ]);

    const restored = loadMessagesFromTranscript(workdir, 'sess3');
    expect(restored).toEqual([{ role: 'assistant', content: 'plain text response' }]);
  });

  it('skips entries with empty content', () => {
    writeJsonl('sess4', [
      { id: 'm1', role: 'user', content: '', createdAt: '2026-05-17T15:00:00Z' },
      {
        id: 'm2',
        role: 'assistant',
        content: { sessionId: 'x' },
        createdAt: '2026-05-17T15:00:01Z',
      },
      { id: 'm3', role: 'user', content: 'real', createdAt: '2026-05-17T15:00:02Z' },
    ]);

    const restored = loadMessagesFromTranscript(workdir, 'sess4');
    expect(restored).toEqual([{ role: 'user', content: 'real' }]);
  });

  it('does not include tool_calls or images in restored messages', () => {
    writeJsonl('sess5', [
      { id: 'm1', role: 'user', content: 'hi', createdAt: '2026-05-17T15:00:00Z' },
    ]);
    const restored = loadMessagesFromTranscript(workdir, 'sess5');
    expect(restored[0].toolCalls).toBeUndefined();
    expect(restored[0].images).toBeUndefined();
  });
});

describe('local-llm runner: idempotent tool cache', () => {
  function makeSession(): import('../src/local-llm/runner.js').Session {
    return {
      messages: [],
      updatedAt: Date.now(),
      activeToolNames: new Set(),
      recentToolCallSigs: [],
      idempotentResultCache: new Map(),
    };
  }

  describe('isIdempotentToolCall', () => {
    it('returns true for wc -c command', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', { command: 'echo "test" | wc -c' })).toBe(true);
    });

    it('returns true for base64 encode', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', { command: 'echo "test" | base64' })).toBe(true);
    });

    it('returns true for sha256sum and md5sum', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', { command: 'echo "test" | sha256sum' })).toBe(true);
      expect(isIdempotentToolCall('exec', { command: 'echo "test" | md5sum' })).toBe(true);
    });

    it('returns true for python urllib.parse.quote', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(
        isIdempotentToolCall('exec', {
          command: `python3 -c "import urllib.parse; print(urllib.parse.quote('test'))"`,
        })
      ).toBe(true);
    });

    it('returns true for python hashlib usage', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(
        isIdempotentToolCall('exec', {
          command: `python3 -c "import hashlib; print(hashlib.md5(b'x').hexdigest())"`,
        })
      ).toBe(true);
    });

    it('handles script field (bash tool)', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('bash', { script: 'echo "x" | wc -c' })).toBe(true);
    });

    it('handles code field (python tool)', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(
        isIdempotentToolCall('python', {
          code: `import hashlib\nprint(hashlib.md5(b'x').hexdigest())`,
        })
      ).toBe(true);
    });

    it('returns false for git push (side effect)', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', { command: 'git push origin main' })).toBe(false);
    });

    it('returns false for curl (network)', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', { command: 'curl https://example.com' })).toBe(false);
    });

    it('returns false for redirect to file (>)', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', { command: 'echo "test" > /tmp/file' })).toBe(false);
    });

    it('returns false for append to file (>>)', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', { command: 'echo "test" >> /tmp/file' })).toBe(false);
    });

    it('returns false for rm', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', { command: 'rm /tmp/foo' })).toBe(false);
    });

    it('returns false for docker', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', { command: 'docker compose up -d' })).toBe(false);
    });

    it('returns false for empty/null/non-object args', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', {})).toBe(false);
      expect(isIdempotentToolCall('exec', null)).toBe(false);
      expect(isIdempotentToolCall('exec', 'string')).toBe(false);
      expect(isIdempotentToolCall('exec', undefined)).toBe(false);
    });

    it('returns false for unrelated command (no idempotent pattern)', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      expect(isIdempotentToolCall('exec', { command: 'ls -la /tmp' })).toBe(false);
    });

    it('prioritizes side-effect over idempotent pattern (mixed)', async () => {
      const { isIdempotentToolCall } = await import('../src/local-llm/runner.js');
      // wc -c は冪等パターンだが、>> redirect 混じりなので副作用優先で false
      expect(
        isIdempotentToolCall('exec', { command: 'echo "test" | wc -c >> /tmp/count.log' })
      ).toBe(false);
    });
  });

  describe('cacheIdempotentResult / getCachedIdempotentResult', () => {
    it('returns undefined on cache miss', async () => {
      const { getCachedIdempotentResult } = await import('../src/local-llm/runner.js');
      const session = makeSession();
      expect(getCachedIdempotentResult(session, 'unknown::{}')).toBeUndefined();
    });

    it('stores and retrieves result by signature', async () => {
      const { cacheIdempotentResult, getCachedIdempotentResult, toolCallSignature } =
        await import('../src/local-llm/runner.js');
      const session = makeSession();
      const sig = toolCallSignature('exec', { command: 'echo "x" | wc -c' });
      cacheIdempotentResult(session, sig, '2\n');
      expect(getCachedIdempotentResult(session, sig)).toBe('2\n');
    });

    it('evicts oldest entry (FIFO) when cache exceeds limit (32)', async () => {
      const { cacheIdempotentResult, getCachedIdempotentResult, toolCallSignature } =
        await import('../src/local-llm/runner.js');
      const session = makeSession();
      for (let i = 0; i < 33; i++) {
        const sig = toolCallSignature('exec', { command: `echo "${i}" | wc -c` });
        cacheIdempotentResult(session, sig, `out${i}`);
      }
      const firstSig = toolCallSignature('exec', { command: 'echo "0" | wc -c' });
      expect(getCachedIdempotentResult(session, firstSig)).toBeUndefined();
      const lastSig = toolCallSignature('exec', { command: 'echo "32" | wc -c' });
      expect(getCachedIdempotentResult(session, lastSig)).toBe('out32');
    });

    it('handles missing idempotentResultCache (backward compat for restored sessions)', async () => {
      const { cacheIdempotentResult, getCachedIdempotentResult } = await import(
        '../src/local-llm/runner.js'
      );
      const session = {
        messages: [],
        updatedAt: Date.now(),
        activeToolNames: new Set(),
        recentToolCallSigs: [],
        recentNormSigs: [],
        idempotentResultCache: undefined as unknown as Map<string, string>,
      } as import('../src/local-llm/runner.js').Session;
      expect(getCachedIdempotentResult(session, 'sig')).toBeUndefined();
      cacheIdempotentResult(session, 'sig', 'out');
      expect(getCachedIdempotentResult(session, 'sig')).toBe('out');
    });
  });
});

describe('local-llm runner: normalized signature + similarity loop detection (PR-A)', () => {
  function makeSession(): import('../src/local-llm/runner.js').Session {
    return {
      messages: [],
      updatedAt: Date.now(),
      activeToolNames: new Set(),
      recentToolCallSigs: [],
      recentNormSigs: [],
      idempotentResultCache: new Map(),
    };
  }

  describe('normalizeSignature', () => {
    it('lowercases the input', async () => {
      const { normalizeSignature } = await import('../src/local-llm/runner.js');
      expect(normalizeSignature('Tool_search::{"query":"ArXiv"}')).toBe('tool search query arxiv');
    });

    it('replaces digits with n (integers and decimals)', async () => {
      const { normalizeSignature } = await import('../src/local-llm/runner.js');
      expect(normalizeSignature('search::{"k":42,"r":3.14}')).toBe('search k n r n');
    });

    it('collapses ASCII punctuation to spaces and compresses whitespace', async () => {
      const { normalizeSignature } = await import('../src/local-llm/runner.js');
      expect(normalizeSignature('a,b,,c   d')).toBe('a b c d');
    });

    it('keeps non-ASCII characters as-is', async () => {
      const { normalizeSignature } = await import('../src/local-llm/runner.js');
      expect(normalizeSignature('検索::"arxiv 論文"')).toContain('arxiv 論文');
      expect(normalizeSignature('検索::"arxiv 論文"')).toContain('検索');
    });

    it('returns empty string for empty input', async () => {
      const { normalizeSignature } = await import('../src/local-llm/runner.js');
      expect(normalizeSignature('')).toBe('');
    });
  });

  describe('trigrams', () => {
    it('returns trigram set with space padding', async () => {
      const { trigrams } = await import('../src/local-llm/runner.js');
      const grams = trigrams('abc');
      // padded ' abc ', trigrams: ' ab', 'abc', 'bc '
      expect(grams.has(' ab')).toBe(true);
      expect(grams.has('abc')).toBe(true);
      expect(grams.has('bc ')).toBe(true);
    });

    it('returns empty Set for empty string', async () => {
      const { trigrams } = await import('../src/local-llm/runner.js');
      expect(trigrams('').size).toBe(0);
    });

    it('handles single character', async () => {
      const { trigrams } = await import('../src/local-llm/runner.js');
      // padded ' a ', single trigram ' a '
      expect(trigrams('a').size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('jaccardSimilarity', () => {
    it('returns 1 for identical strings', async () => {
      const { jaccardSimilarity } = await import('../src/local-llm/runner.js');
      expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
    });

    it('returns 1 for both empty strings', async () => {
      const { jaccardSimilarity } = await import('../src/local-llm/runner.js');
      expect(jaccardSimilarity('', '')).toBe(1);
    });

    it('returns high similarity for near-duplicate strings', async () => {
      const { jaccardSimilarity } = await import('../src/local-llm/runner.js');
      const sim = jaccardSimilarity(
        'tool_search query arxiv paper',
        'tool_search query arxiv papers'
      );
      expect(sim).toBeGreaterThan(0.8);
    });

    it('returns low similarity for unrelated strings', async () => {
      const { jaccardSimilarity } = await import('../src/local-llm/runner.js');
      const sim = jaccardSimilarity('abcdef', 'xyzwvu');
      expect(sim).toBeLessThan(0.2);
    });

    it('is symmetric', async () => {
      const { jaccardSimilarity } = await import('../src/local-llm/runner.js');
      const a = 'foo bar baz';
      const b = 'foo bar qux';
      expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
    });
  });

  describe('countSimilarMatches', () => {
    it('counts entries meeting the threshold', async () => {
      const { countSimilarMatches } = await import('../src/local-llm/runner.js');
      const sigs = [
        'tool search query arxiv paper',
        'tool search query arxiv papers',
        'tool search query arxiv articles',
        'unrelated stuff foo bar',
      ];
      const target = 'tool search query arxiv paper';
      const count = countSimilarMatches(sigs, target, 0.6);
      // First 3 should match (arxiv variants), unrelated should not
      expect(count).toBeGreaterThanOrEqual(3);
    });

    it('returns 0 when no entries meet the threshold', async () => {
      const { countSimilarMatches } = await import('../src/local-llm/runner.js');
      expect(countSimilarMatches(['abc', 'def'], 'xyz', 0.9)).toBe(0);
    });

    it('uses default threshold (0.85) when omitted', async () => {
      const { countSimilarMatches } = await import('../src/local-llm/runner.js');
      const sigs = ['hello world', 'hello world'];
      expect(countSimilarMatches(sigs, 'hello world')).toBe(2);
    });
  });

  describe('recordToolCallAndDetectLoop', () => {
    it('returns kind=none for the first call', async () => {
      const { recordToolCallAndDetectLoop, toolCallSignature } = await import(
        '../src/local-llm/runner.js'
      );
      const session = makeSession();
      const sig = toolCallSignature('exec', { command: 'ls' });
      expect(recordToolCallAndDetectLoop(session, sig).kind).toBe('none');
    });

    it('detects exact loop after 3 identical calls', async () => {
      const { recordToolCallAndDetectLoop, toolCallSignature } = await import(
        '../src/local-llm/runner.js'
      );
      const session = makeSession();
      const sig = toolCallSignature('tool_search', { query: 'arxiv' });
      const r1 = recordToolCallAndDetectLoop(session, sig);
      const r2 = recordToolCallAndDetectLoop(session, sig);
      const r3 = recordToolCallAndDetectLoop(session, sig);
      expect(r1.kind).toBe('none');
      expect(r2.kind).toBe('none');
      expect(r3.kind).toBe('exact');
      expect(r3.repeats).toBe(3);
    });

    it('detects similar loop with near-duplicate args (3rd call)', async () => {
      const { recordToolCallAndDetectLoop, toolCallSignature } = await import(
        '../src/local-llm/runner.js'
      );
      const session = makeSession();
      // 3 different but very similar queries (Jaccard >= 0.85 each pair)
      const s1 = toolCallSignature('tool_search', { query: 'arxiv recent papers' });
      const s2 = toolCallSignature('tool_search', { query: 'arxiv recent papers!' });
      const s3 = toolCallSignature('tool_search', { query: 'arxiv recent paper' });
      const r1 = recordToolCallAndDetectLoop(session, s1);
      const r2 = recordToolCallAndDetectLoop(session, s2);
      const r3 = recordToolCallAndDetectLoop(session, s3);
      expect(r1.kind).toBe('none');
      // r2 may or may not fire similar (depends on threshold). 3rd should fire.
      expect(r3.kind).toBe('similar');
      expect(r3.repeats ?? 0).toBeGreaterThanOrEqual(3);
    });

    it('does not fire similar for unrelated calls', async () => {
      const { recordToolCallAndDetectLoop, toolCallSignature } = await import(
        '../src/local-llm/runner.js'
      );
      const session = makeSession();
      const calls = [
        toolCallSignature('exec', { command: 'ls -la' }),
        toolCallSignature('read', { path: '/foo' }),
        toolCallSignature('write', { path: '/bar', content: 'xyz' }),
      ];
      for (const sig of calls) {
        expect(recordToolCallAndDetectLoop(session, sig).kind).toBe('none');
      }
    });

    it('exact detection takes precedence over similar', async () => {
      const { recordToolCallAndDetectLoop, toolCallSignature } = await import(
        '../src/local-llm/runner.js'
      );
      const session = makeSession();
      const sig = toolCallSignature('exec', { command: 'echo test | wc -c' });
      recordToolCallAndDetectLoop(session, sig);
      recordToolCallAndDetectLoop(session, sig);
      const r3 = recordToolCallAndDetectLoop(session, sig);
      expect(r3.kind).toBe('exact');
    });

    it('returns boolean true via recordToolCallAndCheckLoop wrapper on either kind', async () => {
      const { recordToolCallAndCheckLoop, toolCallSignature } = await import(
        '../src/local-llm/runner.js'
      );
      const session = makeSession();
      const sig = toolCallSignature('tool_search', { query: 'foo' });
      recordToolCallAndCheckLoop(session, sig);
      recordToolCallAndCheckLoop(session, sig);
      expect(recordToolCallAndCheckLoop(session, sig)).toBe(true);
    });
  });
});

describe('local-llm runner: compactOldToolResults (Prune)', () => {
  function makeSessionWith(messages: Array<Record<string, unknown>>): import('../src/local-llm/runner.js').Session {
    return {
      messages: messages as never,
      updatedAt: Date.now(),
      activeToolNames: new Set(),
      recentToolCallSigs: [],
      recentNormSigs: [],
      idempotentResultCache: new Map(),
    };
  }

  const bigBody = (n: number, fill: string = 'x') => fill.repeat(n);

  it('returns 0 compacted when message count <= recentKeepCount', async () => {
    const { compactOldToolResults } = await import('../src/local-llm/runner.js');
    const session = makeSessionWith([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
    const result = compactOldToolResults(session, 10);
    expect(result.compactedCount).toBe(0);
    expect(result.bytesReclaimed).toBe(0);
  });

  it('preserves recent N tool results (within recentKeepCount)', async () => {
    const { compactOldToolResults } = await import('../src/local-llm/runner.js');
    // 直近 2 件は保護、それ以前の tool 結果のみ圧縮対象
    const session = makeSessionWith([
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'exec', arguments: { command: 'ls' } }],
      },
      { role: 'tool', content: bigBody(1000), toolCallId: 't1' }, // 古い、圧縮対象
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'q2' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't2', name: 'exec', arguments: { command: 'pwd' } }],
      },
      { role: 'tool', content: bigBody(1000), toolCallId: 't2' }, // 直近、保護
    ]);
    const result = compactOldToolResults(session, 2);
    expect(result.compactedCount).toBe(1);
    expect((session.messages[2] as { content: string }).content).toContain('[exec]');
    expect((session.messages[2] as { content: string }).content).toContain('pruned from old turn');
    expect((session.messages[6] as { content: string }).content.length).toBe(1000); // 直近保護
  });

  it('skips tool results shorter than 200 chars (already cheap)', async () => {
    const { compactOldToolResults } = await import('../src/local-llm/runner.js');
    const session = makeSessionWith([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'exec', arguments: { command: 'echo' } }],
      },
      { role: 'tool', content: 'short result', toolCallId: 't1' }, // 短い、スキップ
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
      { role: 'user', content: 'q4' },
      { role: 'user', content: 'q5' },
      { role: 'user', content: 'q6' },
      { role: 'user', content: 'q7' },
      { role: 'user', content: 'q8' },
      { role: 'user', content: 'q9' },
      { role: 'user', content: 'q10' },
      { role: 'user', content: 'q11' },
    ]);
    const result = compactOldToolResults(session, 2);
    expect(result.compactedCount).toBe(0); // 短すぎてスキップ
    expect((session.messages[1] as { content: string }).content).toBe('short result');
  });

  it('dedups same-path read tool results, keeping the latest', async () => {
    const { compactOldToolResults } = await import('../src/local-llm/runner.js');
    const path = '/tmp/foo.md';
    const session = makeSessionWith([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'r1', name: 'read', arguments: { path } }],
      },
      { role: 'tool', content: bigBody(1500, 'a'), toolCallId: 'r1' }, // 1 回目、deduped 候補
      { role: 'user', content: 'reread' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'r2', name: 'read', arguments: { path } }],
      },
      { role: 'tool', content: bigBody(1500, 'b'), toolCallId: 'r2' }, // 2 回目、最新 (古い範囲内ならこっちが残る)
      // 直近 2 件保護で oldIndexEnd = 7 - 2 = 5、index 5 以降は保護
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'done' },
    ]);
    const result = compactOldToolResults(session, 2);
    // r1 は deduped、r2 は古い範囲内の最新なので [read] (M chars, pruned from old turn) になる
    expect(result.compactedCount).toBe(2);
    expect((session.messages[1] as { content: string }).content).toContain('deduped');
    expect((session.messages[1] as { content: string }).content).toContain(path);
    expect((session.messages[4] as { content: string }).content).toContain('[read]');
    expect((session.messages[4] as { content: string }).content).toContain('pruned from old turn');
  });

  it('is idempotent (already pruned messages are skipped on second pass)', async () => {
    const { compactOldToolResults } = await import('../src/local-llm/runner.js');
    const session = makeSessionWith([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'exec', arguments: { command: 'ls' } }],
      },
      { role: 'tool', content: bigBody(500), toolCallId: 't1' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    const first = compactOldToolResults(session, 2);
    expect(first.compactedCount).toBe(1);
    const firstContent = (session.messages[1] as { content: string }).content;
    const second = compactOldToolResults(session, 2);
    expect(second.compactedCount).toBe(0); // 既に pruned、再度スキップ
    expect((session.messages[1] as { content: string }).content).toBe(firstContent);
  });

  it('handles tool message without toolCallId gracefully', async () => {
    const { compactOldToolResults } = await import('../src/local-llm/runner.js');
    const session = makeSessionWith([
      { role: 'tool', content: bigBody(1000) }, // toolCallId なし
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
    ]);
    const result = compactOldToolResults(session, 2);
    expect(result.compactedCount).toBe(1);
    expect((session.messages[0] as { content: string }).content).toContain('[tool]');
  });
});

describe('non-streaming path drift strip (executeAgentLoop / run)', () => {
  // scheduler / slash 経路は run() = 非ストリーミングループ (executeAgentLoop) を通る。
  // このループは drift strip を持たず、`<|channel>thought<channel|>` 等の擬似テキストが
  // 出力に漏れていた。executeStreamLoop と対称に finalizeNonStreamContent で
  // strip するようにした回帰テスト。
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'xangi-drift-'));
    mkdirSync(join(workdir, 'logs', 'sessions'), { recursive: true });
    process.env.LOCAL_LLM_MODE = 'chat'; // enableTools=false → lite 単発 chat 経路
  });

  afterEach(() => {
    delete process.env.LOCAL_LLM_MODE;
    rmSync(workdir, { recursive: true, force: true });
  });

  function makeRunnerReturning(content: string): LocalLlmRunner {
    const runner = new LocalLlmRunner({ workdir, model: 'test' });
    // 実ネットワークを使わず固定応答を返す mock に差し替える
    (runner as unknown as { llm: { chat: () => Promise<unknown> } }).llm = {
      chat: async () => ({ content, finishReason: 'stop', toolCalls: [] }),
    };
    return runner;
  }

  it('strips Harmony channel drift leaked on the non-streaming path', async () => {
    const drift = '<|channel>thought\n<channel|>今日の予定を確認したにゃ🐾\n\n📅 予定はXX';
    const runner = makeRunnerReturning(drift);
    const { result } = await runner.run('予定教えて', { sessionId: 's1', channelId: 'c1' });
    expect(result).not.toContain('<|channel>');
    expect(result).not.toContain('<channel|>');
    expect(result).toContain('今日の予定を確認したにゃ');
  });

  it('replaces drift-only output with friendly fallback (not empty → no misleading ✅)', async () => {
    const runner = makeRunnerReturning('<|channel>thought\n<channel|>');
    const { result } = await runner.run('q', { sessionId: 's2', channelId: 'c2' });
    expect(result).toBe(FRIENDLY_FALLBACK_MESSAGE);
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('leaves clean content untouched', async () => {
    const runner = makeRunnerReturning('明日は晴れ、最高25℃だよ');
    const { result } = await runner.run('天気は？', { sessionId: 's3', channelId: 'c3' });
    expect(result).toBe('明日は晴れ、最高25℃だよ');
  });
});

describe('streaming drift-dropped-to-empty recovery (executeStreamLoop / runStream)', () => {
  // StreamingDriftBuffer が最終応答の strict drift を stream 途中で drop すると fullText が
  // 空になり、containsPseudoToolCall も false になるため rescue ループも fallback も発火せず、
  // 呼び出し側の空応答 fallback（誤った成功マーク）に落ちていた。
  // drift drop を下流に伝え、(1) plain text 再生成を促す (2) 最終的に空なら友好的 fallback。
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'xangi-streamdrift-'));
    mkdirSync(join(workdir, 'logs', 'sessions'), { recursive: true });
    delete process.env.LOCAL_LLM_MODE; // 既定: enableTools=true → tool ループ → final stream
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  // chatStream を呼び出し回数ごとに別シーケンスで返す mock を仕込んだ runner を作る
  function makeStreamRunner(streamsPerCall: string[][]): LocalLlmRunner {
    const runner = new LocalLlmRunner({ workdir, model: 'test' });
    let streamCall = 0;
    (
      runner as unknown as {
        llm: {
          chat: () => Promise<unknown>;
          chatStream: (m: unknown, o?: unknown) => AsyncGenerator<string>;
        };
      }
    ).llm = {
      // tool ループは即 break させる（toolCalls 無し）
      chat: async () => ({ content: '', toolCalls: [], finishReason: 'stop' }),
      chatStream: async function* () {
        const chunks = streamsPerCall[Math.min(streamCall, streamsPerCall.length - 1)];
        streamCall++;
        for (const c of chunks) yield c;
      },
    };
    return runner;
  }

  it('falls back to a friendly message (not empty → no ✅) when every stream is drift-only', async () => {
    // 毎回 strict drift だけを吐く → hold buffer が drop → 空 → retry 上限 → 友好的 fallback
    const runner = makeStreamRunner([['<|channel>thought\n<channel|>']]);
    const { result } = await runner.runStream('明日の天気合ってる？', {}, {
      sessionId: 'st1',
      channelId: 'ch1',
    });
    expect(result).toBe(FRIENDLY_FALLBACK_MESSAGE);
    expect(result).not.toBe('');
  });

  it('recovers the real answer when a retry produces clean plain text', async () => {
    // 1 回目: drift-only（drop → 空）→ 再生成プロンプト → 2 回目: クリーンな本文
    const runner = makeStreamRunner([
      ['<|channel>thought\n<channel|>'],
      ['明日は晴れ時々曇り、最高20℃だよ🐾'],
    ]);
    const { result } = await runner.runStream('明日の天気合ってる？', {}, {
      sessionId: 'st2',
      channelId: 'ch2',
    });
    expect(result).toBe('明日は晴れ時々曇り、最高20℃だよ🐾');
  });
});
