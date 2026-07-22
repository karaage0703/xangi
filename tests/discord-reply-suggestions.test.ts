import { describe, expect, it } from 'vitest';
import {
  appendReplySuggestionInstruction,
  extractReplySuggestions,
  fallbackReplySuggestions,
  formatNumberedSuggestions,
  resolveReplySuggestionSkipPermissions,
  sanitizeReplySuggestionOutput,
  stripReplySuggestionMarkup,
} from '../src/reply-suggestions.js';

describe('Discord reply suggestions', () => {
  it('adds a machine-readable generation instruction', () => {
    const prompt = appendReplySuggestionInstruction('質問', 3);
    expect(prompt).toContain('<xangi_reply_suggestions>');
    expect(prompt).toContain('3件');
  });

  it('extracts suggestions and removes the private block', () => {
    const output =
      '回答です。\n<xangi_reply_suggestions>["詳しく教えて","進めて","別案は？"]</xangi_reply_suggestions>';
    expect(extractReplySuggestions(output)).toEqual({
      text: '回答です。',
      suggestions: ['詳しく教えて', '進めて', '別案は？'],
    });
  });

  it('hides malformed blocks and provides a deterministic fallback', () => {
    const output = '回答\n<xangi_reply_suggestions>broken</xangi_reply_suggestions>';
    expect(extractReplySuggestions(output)).toEqual({ text: '回答', suggestions: [] });
    expect(fallbackReplySuggestions()).toHaveLength(3);
  });

  it('removes stale suggestion markup even when suggestions are disabled', () => {
    const output =
      '回答です。\n<xangi_reply_suggestions>["古い候補1","古い候補2"]</xangi_reply_suggestions>';
    expect(sanitizeReplySuggestionOutput(output, false)).toEqual({
      text: '回答です。',
      suggestions: [],
    });
  });

  it('hides a stale partial tag before it reaches streaming output', () => {
    expect(stripReplySuggestionMarkup('回答です。\n<xangi_reply_suggestions>["途中')).toBe(
      '回答です。'
    );
  });

  it('hides a completed candidate array before the closer arrives', () => {
    expect(stripReplySuggestionMarkup('回答です。\n<xangi_reply_suggestions>["秘密"]')).toBe(
      '回答です。'
    );
  });

  it('hides a completed candidate array while the closer is still partial', () => {
    expect(
      stripReplySuggestionMarkup('回答です。\n<xangi_reply_suggestions>["秘密"]</xangi_')
    ).toBe('回答です。');
  });

  it('keeps body text that merely mentions the marker prefix in prose', () => {
    // 実際に途中切れを起こした本文パターン。マーカー名を引用しただけで以降が消えていた。
    const output = "切り取り基準を `indexOf('<xangi_reply')` に広げた副作用。この後の文も残る。";
    expect(stripReplySuggestionMarkup(output)).toBe(output);
  });

  it('keeps a fully-quoted opener tag when normal prose follows it', () => {
    const output = '`<xangi_reply_suggestions>` について説明する。この後の文も残る。';
    expect(stripReplySuggestionMarkup(output)).toBe(output);
  });

  it('keeps an inline candidate example when normal prose follows it', () => {
    const output =
      '説明: <xangi_reply_suggestions>["例"] と書きます。この後の文も残る。';
    expect(stripReplySuggestionMarkup(output)).toBe(output);
  });

  it('keeps inline opener and closer tags quoted as prose', () => {
    const output =
      '開始は <xangi_reply_suggestions>、終了は </xangi_reply_suggestions> です。';
    expect(stripReplySuggestionMarkup(output)).toBe(output);
  });

  it('keeps a line-leading candidate example when prose follows on the same line', () => {
    const output =
      '回答\n<xangi_reply_suggestions>["例"]</xangi_reply_suggestions> は候補例です。\n続き';
    expect(stripReplySuggestionMarkup(output)).toBe(output);
  });

  it('hides an unclosed standalone candidate even when malformed text follows', () => {
    expect(
      stripReplySuggestionMarkup('回答\n<xangi_reply_suggestions>["秘密"] trailing')
    ).toBe('回答');
  });

  it('hides a completed block that sits at the very end', () => {
    expect(
      stripReplySuggestionMarkup(
        '回答です。\n<xangi_reply_suggestions>["a"]</xangi_reply_suggestions>'
      )
    ).toBe('回答です。');
  });

  it('hides a completed block while preserving prose that follows it', () => {
    expect(
      stripReplySuggestionMarkup(
        '回答です。\n<xangi_reply_suggestions>["a"]</xangi_reply_suggestions>\n追記です。'
      )
    ).toBe('回答です。\n追記です。');
  });

  it('hides multiple completed blocks without deleting surrounding prose', () => {
    expect(
      stripReplySuggestionMarkup(
        '回答1\n<xangi_reply_suggestions>["a"]</xangi_reply_suggestions>\n回答2\n<xangi_reply_suggestions>["b"]</xangi_reply_suggestions>'
      )
    ).toBe('回答1\n回答2');
  });

  it('extracts a suggestion that quotes the closer tag', () => {
    expect(
      extractReplySuggestions(
        '回答です。\n<xangi_reply_suggestions>["終了タグ </xangi_reply_suggestions> を説明"]</xangi_reply_suggestions>'
      )
    ).toEqual({
      text: '回答です。',
      suggestions: ['終了タグ </xangi_reply_suggestions> を説明'],
    });
  });

  it('fully hides a malformed block containing the closer tag in a string', () => {
    expect(
      extractReplySuggestions(
        '回答\n<xangi_reply_suggestions>["秘密 </xangi_reply_suggestions>"] trailing</xangi_reply_suggestions>\n追記'
      )
    ).toEqual({ text: '回答\n追記', suggestions: [] });
  });

  it('uses the last standalone closer for a malformed JSON string', () => {
    expect(
      stripReplySuggestionMarkup(
        '回答\n<xangi_reply_suggestions>["秘密 </xangi_reply_suggestions>\n内部秘密\n</xangi_reply_suggestions>\n追記'
      )
    ).toBe('回答\n追記');
  });

  it('hides a multiline malformed block with non-JSON content', () => {
    expect(
      stripReplySuggestionMarkup(
        '回答\n<xangi_reply_suggestions>broken\n内部秘密\n</xangi_reply_suggestions>\n追記'
      )
    ).toBe('回答\n追記');
  });

  it('does not let a malformed block consume a following valid block or prose', () => {
    expect(
      stripReplySuggestionMarkup(
        '回答1\n<xangi_reply_suggestions>["壊れ"\n</xangi_reply_suggestions>\n回答2\n<xangi_reply_suggestions>["b"]</xangi_reply_suggestions>\n回答3'
      )
    ).toBe('回答1\n回答2\n回答3');
  });

  it('hides from the first of multiple incomplete blocks', () => {
    expect(
      stripReplySuggestionMarkup(
        '回答\n<xangi_reply_suggestions>["秘密1"\n<xangi_reply_suggestions>["秘密2"'
      )
    ).toBe('回答');
  });

  it('removes trailing spaces and a CRLF with the internal block line', () => {
    expect(
      stripReplySuggestionMarkup(
        '回答\r\n<xangi_reply_suggestions>["a"]</xangi_reply_suggestions>  \r\n追記'
      )
    ).toBe('回答\r\n追記');
  });

  it('hides a trailing opener fragment during streaming', () => {
    expect(stripReplySuggestionMarkup('回答です。\n<xangi_reply_sugg')).toBe('回答です。');
  });

  it('hides a trailing opener fragment followed by whitespace or line breaks', () => {
    expect(stripReplySuggestionMarkup('回答です。\n<xangi_reply_sugg  \r\n')).toBe('回答です。');
  });

  it('appends numbered suggestions to the visible response', () => {
    expect(formatNumberedSuggestions(['はい', 'いいえ'])).toBe('1. はい\n2. いいえ');
  });

  it('inherits the configured permission mode for suggestion turns', () => {
    expect(resolveReplySuggestionSkipPermissions(true)).toBe(true);
    expect(resolveReplySuggestionSkipPermissions(false)).toBe(false);
    expect(resolveReplySuggestionSkipPermissions(undefined)).toBe(false);
  });
});
