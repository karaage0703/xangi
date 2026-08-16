import { describe, expect, it } from 'vitest';
import { buildCompletionSummary } from '../src/completion-summary.js';

describe('completion summary', () => {
  it('shows elapsed time by default', () => {
    expect(buildCompletionSummary({ elapsedMs: 61_000 }, { showElapsed: true })).toBe(
      '✅ 完了（⏱ 1分01秒）'
    );
  });

  it('can hide elapsed time', () => {
    expect(buildCompletionSummary({ elapsedMs: 1_000 }, { showElapsed: false })).toBe('✅ 完了');
  });
});
