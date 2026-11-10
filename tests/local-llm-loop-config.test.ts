import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadToolLoopConfig,
  recordToolCallAndDetectLoop,
  toolCallSignature,
  type Session,
} from '../src/local-llm/runner.js';

const defaults = {
  similarEnabled: true,
  similarThreshold: 0.85,
  similarMatchCount: 2,
  similarWindow: 8,
};
const session = (): Session => ({
  messages: [],
  updatedAt: 0,
  activeToolNames: new Set(),
  recentToolCallSigs: [],
  recentToolLoopEntries: [],
  idempotentResultCache: new Map(),
});

describe('read target identity (#286)', () => {
  const root = '/workspace/notes/manual/procedures/equipment-loan-policy';
  it.each([
    [`${root}.md`, `${root}/02_forms.md`, `${root}/06_fees.md`],
    [`${root}/01_section.md`, `${root}/02_section.md`, `${root}/03_section.md`],
    [`${root}/Forms.md`, `${root}/forms.md`, `${root}/FORMS.md`],
    [`${root}/a-b.md`, `${root}/a_b.md`, `${root}/a.b.md`],
  ])('allows distinct files: %s, %s, %s', (...paths) => {
    const s = session();
    for (const path of paths) {
      expect(recordToolCallAndDetectLoop(s, toolCallSignature('read', { path })).kind).toBe('none');
    }
  });

  it('recognizes relative/absolute paths, dot segments and symlink aliases of the same file', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'loop-alias-'));
    try {
      writeFileSync(join(workspace, 'file.md'), 'contents');
      symlinkSync('file.md', join(workspace, 'alias.md'));
      const s = session();
      const kinds = ['file.md', join(workspace, './file.md'), 'alias.md'].map(
        (path) =>
          recordToolCallAndDetectLoop(s, toolCallSignature('read', { path }), defaults, workspace)
            .kind
      );
      expect(kinds).toEqual(['none', 'none', 'similar']);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('does not mix tools even when the remainder of their signatures is identical', () => {
    const s = session();
    const query = 'a long identical argument repeated to overwhelm the tool name';
    for (const name of ['search_one', 'search_two', 'search_three']) {
      expect(recordToolCallAndDetectLoop(s, toolCallSignature(name, { query })).kind).toBe('none');
    }
  });

  it('keeps exec similarity by default and allows an explicit off override', () => {
    const args = [1, 2, 3].map((i) =>
      toolCallSignature('exec', { command: `rg -n fee ${root}/0${i}_section.md` })
    );
    const s = session();
    expect(args.map((sig) => recordToolCallAndDetectLoop(s, sig).kind)).toEqual([
      'none',
      'none',
      'similar',
    ]);
    const off = loadToolLoopConfig({ LOCAL_LLM_LOOP_SIMILAR: 'off' });
    const disabledSession = session();
    expect(args.map((sig) => recordToolCallAndDetectLoop(disabledSession, sig, off).kind)).toEqual([
      'none',
      'none',
      'none',
    ]);
  });
});
const variants = ['arxiv recent papers', 'arxiv recent papers!', 'arxiv recent paper'].map(
  (query) => toolCallSignature('tool_search', { query })
);

describe('Local LLM loop overrides', () => {
  it('keeps defaults for unset or empty values', () => {
    expect(loadToolLoopConfig({})).toEqual(defaults);
    expect(loadToolLoopConfig({ LOCAL_LLM_LOOP_WINDOW: ' ', LOCAL_LLM_LOOP_SIMILAR: '' })).toEqual(
      defaults
    );
  });

  it('loads all overrides, trimming whitespace and the off switch', () => {
    expect(
      loadToolLoopConfig({
        LOCAL_LLM_LOOP_SIMILAR: ' OFF ',
        LOCAL_LLM_LOOP_SIMILAR_THRESHOLD: ' 0.95 ',
        LOCAL_LLM_LOOP_SIMILAR_MATCH_COUNT: '3',
        LOCAL_LLM_LOOP_WINDOW: '16',
      })
    ).toEqual({
      similarEnabled: false,
      similarThreshold: 0.95,
      similarMatchCount: 3,
      similarWindow: 16,
    });
    expect(loadToolLoopConfig({ LOCAL_LLM_LOOP_SIMILAR: 'typo' })).toEqual(defaults);
  });

  it.each([
    ['LOCAL_LLM_LOOP_SIMILAR_THRESHOLD', 'NaN'],
    ['LOCAL_LLM_LOOP_SIMILAR_THRESHOLD', 'Infinity'],
    ['LOCAL_LLM_LOOP_SIMILAR_THRESHOLD', '0'],
    ['LOCAL_LLM_LOOP_SIMILAR_THRESHOLD', '1.01'],
    ['LOCAL_LLM_LOOP_SIMILAR_THRESHOLD', '0.9oops'],
    ['LOCAL_LLM_LOOP_SIMILAR_THRESHOLD', '0x1'],
    ['LOCAL_LLM_LOOP_SIMILAR_MATCH_COUNT', '0'],
    ['LOCAL_LLM_LOOP_SIMILAR_MATCH_COUNT', '-1'],
    ['LOCAL_LLM_LOOP_SIMILAR_MATCH_COUNT', '2.5'],
    ['LOCAL_LLM_LOOP_WINDOW', '0'],
    ['LOCAL_LLM_LOOP_WINDOW', '-1'],
    ['LOCAL_LLM_LOOP_WINDOW', '1.5'],
    ['LOCAL_LLM_LOOP_WINDOW', 'Infinity'],
    ['LOCAL_LLM_LOOP_WINDOW', '1025'],
  ])('falls back for invalid %s=%s while preserving off', (key, value) => {
    expect(loadToolLoopConfig({ [key]: value, LOCAL_LLM_LOOP_SIMILAR: 'off' })).toEqual({
      ...defaults,
      similarEnabled: false,
    });
  });

  it('rejects unreachable match counts and accepts window boundaries', () => {
    expect(loadToolLoopConfig({ LOCAL_LLM_LOOP_WINDOW: '1' })).toEqual(defaults);
    expect(
      loadToolLoopConfig({ LOCAL_LLM_LOOP_WINDOW: '1', LOCAL_LLM_LOOP_SIMILAR_MATCH_COUNT: '1' })
        .similarWindow
    ).toBe(1);
    expect(loadToolLoopConfig({ LOCAL_LLM_LOOP_WINDOW: '1024' }).similarWindow).toBe(1024);
  });

  it('disables only similar, leaving exact protection even with a window of one', () => {
    const config = loadToolLoopConfig({
      LOCAL_LLM_LOOP_SIMILAR: 'off',
      LOCAL_LLM_LOOP_WINDOW: '1',
      LOCAL_LLM_LOOP_SIMILAR_MATCH_COUNT: '1',
    });
    const s = session();
    for (const sig of variants)
      expect(recordToolCallAndDetectLoop(s, sig, config).kind).toBe('none');
    expect(recordToolCallAndDetectLoop(s, variants[2], config).kind).toBe('none');
    expect(recordToolCallAndDetectLoop(s, variants[2], config).kind).toBe('exact');
  });

  it('honors threshold=1 and the inclusive boundary', () => {
    const config = loadToolLoopConfig({ LOCAL_LLM_LOOP_SIMILAR_THRESHOLD: '1' });
    const s = session();
    expect(variants.map((sig) => recordToolCallAndDetectLoop(s, sig, config).kind)).toEqual([
      'none',
      'none',
      'none',
    ]);
    const sameNorm = [
      variants[0],
      variants[1],
      toolCallSignature('tool_search', { query: 'Arxiv recent papers' }),
    ];
    const sessionForBoundary = session();
    expect(
      sameNorm.map((sig) => recordToolCallAndDetectLoop(sessionForBoundary, sig, config).kind)
    ).toEqual(['none', 'none', 'similar']);
  });

  it('uses the configured match count including counts above the old eight-entry window', () => {
    const config = loadToolLoopConfig({
      LOCAL_LLM_LOOP_SIMILAR_MATCH_COUNT: '9',
      LOCAL_LLM_LOOP_WINDOW: '9',
    });
    const s = session();
    for (let i = 0; i < 9; i++)
      expect(recordToolCallAndDetectLoop(s, variants[i % 2], config).kind).toBe('none');
    expect(recordToolCallAndDetectLoop(s, variants[1], config).kind).toBe('similar');
  });

  it('evicts old similar matches while retaining exact detection', () => {
    const config = loadToolLoopConfig({
      LOCAL_LLM_LOOP_SIMILAR_MATCH_COUNT: '1',
      LOCAL_LLM_LOOP_WINDOW: '1',
    });
    const s = session();
    recordToolCallAndDetectLoop(s, variants[0], config);
    recordToolCallAndDetectLoop(s, toolCallSignature('exec', { command: 'pwd' }), config);
    expect(recordToolCallAndDetectLoop(s, variants[1], config).kind).toBe('none');
    expect(s.recentToolLoopEntries).toHaveLength(1);
    recordToolCallAndDetectLoop(s, variants[1], config);
    expect(recordToolCallAndDetectLoop(s, variants[1], config).kind).toBe('exact');
  });
});
