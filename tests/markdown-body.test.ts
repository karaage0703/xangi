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
  it('opens external links separately and file-style links in the workspace viewer', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '[external](https://example.test/docs) [file](/workspace/notes/example.md:12)',
      })
    );

    expect(html).toContain(
      '<a href="https://example.test/docs" target="_blank" rel="noopener noreferrer">external</a>'
    );
    expect(html).toContain(
      '<a href="/workspace?path=notes%2Fexample.md&amp;line=12" target="_blank" rel="noopener noreferrer">file</a>'
    );
  });

  it('preserves encoded paths and source locations in workspace deep links', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '[encoded](/workspace/My%20Project/scheduler.ts:42:7) [relative](src/index.ts#L8)',
      })
    );

    expect(html).toContain(
      '<a href="/workspace?path=My+Project%2Fscheduler.ts&amp;line=42&amp;column=7" target="_blank" rel="noopener noreferrer">encoded</a>'
    );
    expect(html).toContain(
      '<a href="/workspace?path=src%2Findex.ts&amp;line=8" target="_blank" rel="noopener noreferrer">relative</a>'
    );
  });

  it('keeps absolute workspace paths available to the viewer', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '[file](/home/user/workspace/AGENTS.md:12)',
      })
    );

    expect(html).toContain(
      '<a href="/workspace?path=%2Fhome%2Fuser%2Fworkspace%2FAGENTS.md&amp;line=12" target="_blank" rel="noopener noreferrer">file</a>'
    );
  });

  it('preserves a root-level file location before react-markdown sanitization', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '[file](AGENTS.md:12)',
      })
    );

    expect(html).toContain(
      '<a href="/workspace?path=AGENTS.md&amp;line=12" target="_blank" rel="noopener noreferrer">file</a>'
    );
  });

  it('does not turn unsafe URI schemes into workspace links', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content: '[unsafe](javascript:1)',
      })
    );

    expect(html).toContain('<a href="">unsafe</a>');
    expect(html).not.toContain('/workspace?');
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
