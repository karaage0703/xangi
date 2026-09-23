import { describe, expect, it } from 'vitest';
import {
  escapeTelegramHtml,
  formatTelegramChunk,
  markdownToTelegramHtml,
  telegramHtmlVisibleLength,
  telegramTextChunks,
} from '../src/telegram-format.js';

describe('Telegram HTML formatting', () => {
  it('renders supported Markdown and escapes literal HTML', () => {
    const result = markdownToTelegramHtml(
      '# Title\n\n**bold** __strong__ *italic* _em_ ~~strike~~ `a < b`\n\na < b && c <script>'
    );
    expect(result).toContain('<b>Title</b>');
    expect(result).toContain('<b>bold</b>');
    expect(result).toContain('<b>strong</b>');
    expect(result).toContain('<i>italic</i>');
    expect(result).toContain('<i>em</i>');
    expect(result).toContain('<s>strike</s>');
    expect(result).toContain('<code>a &lt; b</code>');
    expect(result).toContain('a &lt; b &amp;&amp; c &lt;script&gt;');
  });

  it('supports nested formatting, links, lists, quotes, and fenced code', () => {
    const result = markdownToTelegramHtml(
      '**bold _and italic_**\n\n[site](https://example.com/?a=1&b=2) [unsafe](javascript:alert(1))\n\n- one\n- two\n\n3. third\n4. fourth\n\n> quoted\n\n```ts\nconst x = "<tag>";\n```'
    );
    expect(result).toContain('<b>bold <i>and italic</i></b>');
    expect(result).toContain('<a href="https://example.com/?a=1&amp;b=2">site</a>');
    expect(result).toContain('unsafe');
    expect(result).not.toContain('javascript:');
    expect(result).toContain('• one\n• two');
    expect(result).toContain('3. third\n4. fourth');
    expect(result).toContain('<blockquote>quoted</blockquote>');
    expect(result).toContain(
      '<pre><code class="language-ts">const x = &quot;&lt;tag&gt;&quot;;</code></pre>'
    );
  });

  it('renders tables in a fixed-width pre block', () => {
    const result = markdownToTelegramHtml('| Name | Value |\n| --- | --- |\n| A | 10 |');
    expect(result).toMatch(/^<pre>Name\s+Value\n/);
    expect(result).toMatch(/A\s+10/);
    expect(result).toContain('</pre>');
  });

  it('keeps reference links, unresolved labels, and footnotes', () => {
    const result = markdownToTelegramHtml(
      'See the [official docs][1], [missing][nope], and a note[^n].\n\n[1]: https://example.com/docs?a=1&b=2\n[^n]: footnote **body**'
    );
    expect(result).toContain('<a href="https://example.com/docs?a=1&amp;b=2">official docs</a>');
    expect(result).toContain('missing');
    expect(result).toContain('note[n]');
    expect(result).toMatch(/\[n\] footnote <b>body<\/b>$/);
  });

  it('preserves task checkboxes and nested list indentation', () => {
    const result = markdownToTelegramHtml('- [x] done\n  - nested\n- [ ] todo');
    expect(result).toContain('• [x] done');
    expect(result).toContain('  • nested');
    expect(result).toContain('• [ ] todo');
  });

  it('resolves references across chunks and leaves footnote bodies at the end', () => {
    const markdown =
      'Read [source][ref] and note[^n].\n\n' +
      'a'.repeat(6000) +
      '\n\n[ref]: https://example.com/source\n[^n]: final footnote';
    const chunks = telegramTextChunks(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain('<a href="https://example.com/source">source</a>');
    expect(chunks.at(-1)?.text).toContain('[n] final footnote');
  });

  it('packs footnotes into the final long-answer chunk when they fit', () => {
    const references = Array.from({ length: 6 }, (_, index) => `note[^${index + 1}]`).join(' ');
    const definitions = Array.from(
      { length: 6 },
      (_, index) => `[^${index + 1}]: source number ${index + 1}`
    ).join('\n');
    const chunks = telegramTextChunks(`${references}\n\n${'a'.repeat(6000)}\n\n${definitions}`);

    expect(chunks.length).toBeLessThanOrEqual(3);
    const lastText = chunks.at(-1)?.text ?? '';
    for (let index = 1; index <= 6; index++) {
      expect(lastText).toContain(`[${index}] source number ${index}`);
    }
    expect(
      chunks.every((chunk) =>
        chunk.parseMode === 'HTML'
          ? telegramHtmlVisibleLength(chunk.text) <= 4096
          : chunk.text.length <= 4096
      )
    ).toBe(true);
  });

  it('starts another chunk only when the next footnote exceeds the visible limit', () => {
    const markdown =
      'See note[^a] and note[^b].\n\n' +
      'a'.repeat(6000) +
      '\n\n[^a]: ' +
      'b'.repeat(2400) +
      '\n[^b]: ' +
      'c'.repeat(2400);
    const chunks = telegramTextChunks(markdown);

    expect(chunks.length).toBe(5);
    expect(chunks.at(-2)?.text).toContain('[a] ' + 'b'.repeat(2400));
    expect(chunks.at(-1)?.text).toContain('[b] ' + 'c'.repeat(2400));
    expect(chunks.every((chunk) => telegramHtmlVisibleLength(chunk.text) <= 4096)).toBe(true);
  });

  it('balances fences across chunks and falls back to plain text when HTML expands past 4096', () => {
    const chunks = telegramTextChunks('```ts\n' + 'x'.repeat(7_000) + '\n```');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.plainText.includes('```ts'))).toBe(true);
    expect(
      chunks.every((chunk) =>
        chunk.parseMode === 'HTML'
          ? telegramHtmlVisibleLength(chunk.text) <= 4096
          : chunk.text.length <= 4096
      )
    ).toBe(true);

    const oversized = formatTelegramChunk('a < b && '.repeat(500));
    expect(oversized.parseMode).toBeUndefined();
    expect(oversized.text).toBe(oversized.plainText);
    expect(escapeTelegramHtml('<script>')).toBe('&lt;script&gt;');

    const expanded = formatTelegramChunk('a < b && '.repeat(380));
    expect(expanded.text.length).toBeGreaterThan(4096);
    expect(telegramHtmlVisibleLength(expanded.text)).toBeLessThan(4096);
    expect(expanded.parseMode).toBe('HTML');
    const longAnswer = telegramTextChunks('a < b && '.repeat(740));
    expect(longAnswer.length).toBeGreaterThan(1);
    expect(longAnswer[0].text.length).toBeGreaterThan(4096);
    expect(longAnswer[0].parseMode).toBe('HTML');
    expect(formatTelegramChunk('x'.repeat(4097)).parseMode).toBeUndefined();
  });
});
