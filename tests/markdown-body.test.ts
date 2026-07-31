import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import MarkdownBody from '../web-ui/src/MarkdownBody.js';

describe('MarkdownBody code blocks', () => {
  it('keeps the copy button outside the horizontally scrolling pre element', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '```\nabcdefghijklmnopqrstuvwxyz\n```',
      })
    );

    expect(html).toContain('<div class="code-block"><button');
    expect(html).toContain('</button><pre><code>abcdefghijklmnopqrstuvwxyz');
  });

  it('preserves the language class used to keep highlighted code unwrapped', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '```typescript\nconst answer = 42;\n```',
      })
    );

    expect(html).toContain('<code class="language-typescript">const answer = 42;');
  });
});
