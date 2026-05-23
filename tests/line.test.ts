import { describe, it, expect } from 'vitest';
import { snapLoadingSeconds, isResetCommand, hasSessionGoneIdle } from '../src/line.js';

describe('snapLoadingSeconds', () => {
  it('returns default (60) when undefined', () => {
    expect(snapLoadingSeconds(undefined)).toBe(60);
  });

  it('returns default (60) when 0 or negative', () => {
    expect(snapLoadingSeconds(0)).toBe(60);
    expect(snapLoadingSeconds(-10)).toBe(60);
  });

  it('returns default (60) when NaN or Infinity', () => {
    expect(snapLoadingSeconds(NaN)).toBe(60);
    expect(snapLoadingSeconds(Infinity)).toBe(60);
  });

  it('returns the value as-is when it is a valid LINE API value', () => {
    expect(snapLoadingSeconds(5)).toBe(5);
    expect(snapLoadingSeconds(10)).toBe(10);
    expect(snapLoadingSeconds(15)).toBe(15);
    expect(snapLoadingSeconds(20)).toBe(20);
    expect(snapLoadingSeconds(25)).toBe(25);
    expect(snapLoadingSeconds(30)).toBe(30);
    expect(snapLoadingSeconds(40)).toBe(40);
    expect(snapLoadingSeconds(50)).toBe(50);
    expect(snapLoadingSeconds(60)).toBe(60);
  });

  it('clips values above 60 to 60', () => {
    expect(snapLoadingSeconds(100)).toBe(60);
    expect(snapLoadingSeconds(65)).toBe(60);
  });

  it('rounds values below 5 up to 5', () => {
    expect(snapLoadingSeconds(1)).toBe(5);
    expect(snapLoadingSeconds(3)).toBe(5);
  });

  it('snaps in-between values to the nearest valid value', () => {
    // 35 → 30 or 40 で近いほう (どちらも diff 5、Math.min 順序で先に見つかった 30 を採用する想定)
    expect([30, 40]).toContain(snapLoadingSeconds(35));
    // 17 → 15 (diff 2) or 20 (diff 3) → 15
    expect(snapLoadingSeconds(17)).toBe(15);
    // 42 → 40 (diff 2) or 50 (diff 8) → 40
    expect(snapLoadingSeconds(42)).toBe(40);
    // 7 → 5 (diff 2) or 10 (diff 3) → 5
    expect(snapLoadingSeconds(7)).toBe(5);
  });

  it('handles fractional values by flooring before snap', () => {
    expect(snapLoadingSeconds(60.5)).toBe(60);
    expect(snapLoadingSeconds(9.9)).toBe(10); // floor 9 → 10 (diff 1) or 5 (diff 4)
  });
});

describe('isResetCommand', () => {
  // default パターン (slash 3 つだけ) を想定したテスト
  const defaultPatterns = ['/reset', '/new', '/clear'] as const;

  it('matches exact slash commands case-insensitively', () => {
    expect(isResetCommand('/reset', defaultPatterns)).toBe(true);
    expect(isResetCommand('/RESET', defaultPatterns)).toBe(true);
    expect(isResetCommand('/Reset', defaultPatterns)).toBe(true);
    expect(isResetCommand('/new', defaultPatterns)).toBe(true);
    expect(isResetCommand('/clear', defaultPatterns)).toBe(true);
  });

  it('strips surrounding whitespace', () => {
    expect(isResetCommand('  /reset  ', defaultPatterns)).toBe(true);
    expect(isResetCommand('/new\n', defaultPatterns)).toBe(true);
    expect(isResetCommand('\t/clear ', defaultPatterns)).toBe(true);
  });

  it('does NOT match partial / substring text', () => {
    expect(isResetCommand('/reset please', defaultPatterns)).toBe(false);
    expect(isResetCommand('please /reset', defaultPatterns)).toBe(false);
    expect(isResetCommand('リセットしたい', defaultPatterns)).toBe(false);
    expect(isResetCommand('最初からお話したい', defaultPatterns)).toBe(false);
  });

  it('does NOT match Japanese natural language by default', () => {
    // 日本語自然言語は default に含めない (誤発火境界が曖昧なため)。
    // 必要なら LINE_RESET_TEXT_PATTERNS で個別追加する運用。
    expect(isResetCommand('リセット', defaultPatterns)).toBe(false);
    expect(isResetCommand('最初から', defaultPatterns)).toBe(false);
    expect(isResetCommand('やり直し', defaultPatterns)).toBe(false);
  });

  it('returns false for empty / whitespace-only text', () => {
    expect(isResetCommand('', defaultPatterns)).toBe(false);
    expect(isResetCommand('   ', defaultPatterns)).toBe(false);
    expect(isResetCommand('\n', defaultPatterns)).toBe(false);
  });

  it('returns false when patterns array is empty', () => {
    expect(isResetCommand('/reset', [])).toBe(false);
    expect(isResetCommand('リセット', [])).toBe(false);
  });

  it('ignores empty/whitespace entries in patterns', () => {
    expect(isResetCommand('/reset', ['', '  ', '/reset'])).toBe(true);
    expect(isResetCommand('anything', ['', '  '])).toBe(false);
  });

  it('supports user-supplied Japanese patterns via override', () => {
    // env で日本語パターンを足したい場合は明示的に渡せば動く
    const overridden = ['/reset', 'リセット', '最初から'] as const;
    expect(isResetCommand('リセット', overridden)).toBe(true);
    expect(isResetCommand('最初から', overridden)).toBe(true);
    // 部分一致は依然として誤発火しない
    expect(isResetCommand('リセットしたい', overridden)).toBe(false);
    expect(isResetCommand('最初からお話したい', overridden)).toBe(false);
  });
});

describe('hasSessionGoneIdle', () => {
  // 固定の now で計算しやすくする
  const now = Date.parse('2026-05-23T12:00:00.000Z');
  const FOUR_HOURS_MS = 4 * 3600 * 1000;

  it('returns true when elapsed >= idleMs', () => {
    const fourHoursAgo = new Date(now - FOUR_HOURS_MS).toISOString();
    expect(hasSessionGoneIdle(fourHoursAgo, FOUR_HOURS_MS, now)).toBe(true);

    const eightHoursAgo = new Date(now - FOUR_HOURS_MS * 2).toISOString();
    expect(hasSessionGoneIdle(eightHoursAgo, FOUR_HOURS_MS, now)).toBe(true);
  });

  it('returns false when elapsed < idleMs', () => {
    const oneHourAgo = new Date(now - 3600 * 1000).toISOString();
    expect(hasSessionGoneIdle(oneHourAgo, FOUR_HOURS_MS, now)).toBe(false);

    const justNow = new Date(now - 1000).toISOString();
    expect(hasSessionGoneIdle(justNow, FOUR_HOURS_MS, now)).toBe(false);
  });

  it('returns false when lastActivityIso is undefined or empty', () => {
    expect(hasSessionGoneIdle(undefined, FOUR_HOURS_MS, now)).toBe(false);
    expect(hasSessionGoneIdle('', FOUR_HOURS_MS, now)).toBe(false);
  });

  it('returns false when lastActivityIso is unparseable', () => {
    expect(hasSessionGoneIdle('not-a-date', FOUR_HOURS_MS, now)).toBe(false);
    expect(hasSessionGoneIdle('2026-99-99', FOUR_HOURS_MS, now)).toBe(false);
  });

  it('returns false when idleMs <= 0 (disabled)', () => {
    const oldIso = new Date(now - FOUR_HOURS_MS * 10).toISOString();
    expect(hasSessionGoneIdle(oldIso, 0, now)).toBe(false);
    expect(hasSessionGoneIdle(oldIso, -1000, now)).toBe(false);
  });

  it('handles exactly threshold boundary as true (>= semantics)', () => {
    const exactly = new Date(now - FOUR_HOURS_MS).toISOString();
    expect(hasSessionGoneIdle(exactly, FOUR_HOURS_MS, now)).toBe(true);
  });
});
