import { describe, expect, it } from 'vitest';
import {
  escapeTelegramHtml,
  formatTelegramChunk,
  markdownToTelegramHtml,
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

  it('balances fences across chunks and falls back to plain text when HTML expands past 4096', () => {
    const chunks = telegramTextChunks('```ts\n' + 'x'.repeat(7_000) + '\n```');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.plainText.includes('```ts'))).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= 4096)).toBe(true);

    const oversized = formatTelegramChunk('a < b && '.repeat(500));
    expect(oversized.parseMode).toBeUndefined();
    expect(oversized.text).toBe(oversized.plainText);
    expect(escapeTelegramHtml('<script>')).toBe('&lt;script&gt;');
  });
});
