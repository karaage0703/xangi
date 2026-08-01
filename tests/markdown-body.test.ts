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

describe('MarkdownBody links', () => {
  it('opens external and file-style links without replacing the chat document', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '[external](https://example.test/docs) [file](/workspace/notes/example.md:12)',
      })
    );

    expect(html).toContain(
      '<a href="https://example.test/docs" target="_blank" rel="noopener noreferrer">external</a>'
    );
    expect(html).toContain(
      '<a href="/api/workspace-file?path=%2Fworkspace%2Fnotes%2Fexample.md" target="_blank" rel="noopener noreferrer">file</a>'
    );
  });

  it('maps encoded and relative source paths to the workspace file endpoint', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '[encoded](/workspace/My%20Project/scheduler.ts:42:7) [relative](src/index.ts#L8)',
      })
    );

    expect(html).toContain(
      '<a href="/api/workspace-file?path=%2Fworkspace%2FMy%20Project%2Fscheduler.ts" target="_blank" rel="noopener noreferrer">encoded</a>'
    );
    expect(html).toContain(
      '<a href="/api/workspace-file?path=src%2Findex.ts" target="_blank" rel="noopener noreferrer">relative</a>'
    );
  });

  it('keeps Web Chat application routes and explicit URI schemes intact', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '[workspace](/workspace) [mail](mailto:test@example.test)',
      })
    );

    expect(html).toContain(
      '<a href="/workspace" target="_blank" rel="noopener noreferrer">workspace</a>'
    );
    expect(html).toContain(
      '<a href="mailto:test@example.test" target="_blank" rel="noopener noreferrer">mail</a>'
    );
  });

  it('keeps in-document fragment links in the current document', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '[section](#details)',
      })
    );

    expect(html).toContain('<a href="#details">section</a>');
    expect(html).not.toContain('target="_blank"');
  });
});
