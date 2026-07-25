import { describe, it, expect } from 'vitest';
import { markdownToSlackMrkdwn } from '../src/slack-mrkdwn.js';

const visibleText = (text: string): string => text.replaceAll('\u200B', '');

describe('markdownToSlackMrkdwn', () => {
  it('太字 ** / __ を * へ変換する', () => {
    expect(visibleText(markdownToSlackMrkdwn('これは **太字** です'))).toBe('これは *太字* です');
    expect(visibleText(markdownToSlackMrkdwn('__bold__ text'))).toBe('*bold* text');
  });

  it('斜体 * を _ へ変換する', () => {
    expect(visibleText(markdownToSlackMrkdwn('これは *斜体* です'))).toBe('これは _斜体_ です');
  });

  it('太字と斜体が混在しても壊れない', () => {
    expect(visibleText(markdownToSlackMrkdwn('**太字**と*斜体*'))).toBe('*太字*と_斜体_');
  });

  it('打ち消し線 ~~ を ~ へ変換する', () => {
    expect(visibleText(markdownToSlackMrkdwn('~~消す~~'))).toBe('~消す~');
  });

  it('見出しを太字に変換する', () => {
    expect(markdownToSlackMrkdwn('# 見出し')).toBe('*見出し*');
    expect(markdownToSlackMrkdwn('### 小見出し ###')).toBe('*小見出し*');
  });

  it('リンクを <url|text> へ変換する', () => {
    expect(markdownToSlackMrkdwn('[Google](https://google.com)')).toBe(
      '<https://google.com|Google>'
    );
  });

  it('画像を <url|alt> へ変換する', () => {
    expect(markdownToSlackMrkdwn('![alt](https://ex.com/a.png)')).toBe(
      '<https://ex.com/a.png|alt>'
    );
  });

  it('箇条書きを • へ変換する（インデント維持）', () => {
    expect(markdownToSlackMrkdwn('- 一つ目\n- 二つ目')).toBe('• 一つ目\n• 二つ目');
    expect(markdownToSlackMrkdwn('  - ネスト')).toBe('  • ネスト');
  });

  it('水平線を罫線に変換する', () => {
    expect(markdownToSlackMrkdwn('---')).toBe('──────────');
  });

  it('インラインコード内は変換しない', () => {
    expect(markdownToSlackMrkdwn('`**そのまま**`')).toBe('`**そのまま**`');
  });

  it('フェンスコードブロック内は変換しない', () => {
    const src = '```js\nconst a = **1**;\n# not heading\n```';
    expect(markdownToSlackMrkdwn(src)).toBe(src);
  });

  it('コードブロックの外だけ変換する', () => {
    const src = '**外**\n```\n**中**\n```\n[x](http://y)';
    expect(visibleText(markdownToSlackMrkdwn(src))).toBe('*外*\n```\n**中**\n```\n<http://y|x>');
  });

  it('表をコードブロックで囲んで整形する', () => {
    const src = '| A | B |\n|---|---|\n| 1 | 2 |';
    const out = markdownToSlackMrkdwn(src);
    expect(out.startsWith('```\n')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
    expect(out).toContain('A');
    expect(out).toContain('1');
    expect(out).toContain('─');
  });

  it('箇条書きの * を斜体と誤変換しない', () => {
    expect(markdownToSlackMrkdwn('* 項目')).toBe('• 項目');
  });

  it('括弧を含むURLを壊さない', () => {
    expect(
      markdownToSlackMrkdwn('[wiki](https://en.wikipedia.org/wiki/Function_(mathematics))')
    ).toBe('<https://en.wikipedia.org/wiki/Function_(mathematics)|wiki>');
  });

  it('山括弧で囲まれたリンク先を保持する', () => {
    expect(markdownToSlackMrkdwn('[Google](<https://google.com>)')).toBe(
      '<https://google.com|Google>'
    );
    expect(
      markdownToSlackMrkdwn('[wiki](<https://en.wikipedia.org/wiki/Function_(mathematics)>)')
    ).toBe('<https://en.wikipedia.org/wiki/Function_(mathematics)|wiki>');
  });

  it('参照形式リンクを変換する', () => {
    expect(markdownToSlackMrkdwn('[ref][id]\n\n[id]: https://example.com')).toBe(
      '<https://example.com|ref>'
    );
  });

  it('Slackの制御文字をプレーンテキストではエスケープする', () => {
    expect(markdownToSlackMrkdwn('5 > 3 & 2 < 4')).toBe('5 &gt; 3 &amp; 2 &lt; 4');
  });

  it('既存のSlackリンク・mention・日付記法を保持する', () => {
    const src =
      '<https://example.com|label> <@U123456> <#C123456> <!date^1392734382^{date}|fallback>';
    expect(markdownToSlackMrkdwn(src)).toBe(src);
  });

  it('ネストした箇条書きのインデントを保持する', () => {
    expect(markdownToSlackMrkdwn('- 親\n  - 子\n    - 孫')).toBe('• 親\n  • 子\n    • 孫');
  });

  it('空文字はそのまま返す', () => {
    expect(markdownToSlackMrkdwn('')).toBe('');
  });
});
