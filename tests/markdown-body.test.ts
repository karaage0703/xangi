import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MarkdownBody from '../web-ui/src/MarkdownBody.js';
import {
  MarkdownDisplaySettings,
  MarkdownPreferencesProvider,
} from '../web-ui/src/MarkdownPreferences.js';

afterEach(() => vi.unstubAllGlobals());

function renderWithPreference(content: string, stored: string | null) {
  vi.stubGlobal('window', { localStorage: { getItem: () => stored } });
  return renderToStaticMarkup(
    createElement(MarkdownPreferencesProvider, {
      children: createElement(MarkdownBody, { content }),
    })
  );
}

describe('MarkdownBody line breaks', () => {
  it('renders a single newline as a hard break by default', () => {
    const html = renderToStaticMarkup(createElement(MarkdownBody, { content: '一行目\n二行目' }));
    expect(html).toBe('<p>一行目<br/>\n二行目</p>');
  });

  it.each([null, 'true', 'invalid'])('defaults to hard breaks for stored value %s', (stored) => {
    expect(renderWithPreference('one\ntwo', stored)).toBe('<p>one<br/>\ntwo</p>');
  });

  it('restores standard soft breaks when disabled', () => {
    expect(renderWithPreference('one\ntwo', 'false')).toBe('<p>one\ntwo</p>');
  });

  it('defaults to enabled when browser storage is unavailable', () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('Storage is blocked');
      },
    });
    const html = renderToStaticMarkup(
      createElement(MarkdownPreferencesProvider, {
        children: createElement(MarkdownBody, { content: 'one\ntwo' }),
      })
    );
    expect(html).toBe('<p>one<br/>\ntwo</p>');
  });

  it.each(['\n', '\r\n', '\r'])('supports line ending %j', (ending) => {
    expect(renderWithPreference(`one${ending}two`, null)).toBe('<p>one<br/>\ntwo</p>');
  });

  it.each(['true', 'false'])('preserves explicit breaks and paragraphs in mode %s', (stored) => {
    expect(renderWithPreference('one  \ntwo\\\nthree\n\nfour', stored)).toBe(
      '<p>one<br/>\ntwo<br/>\nthree</p>\n<p>four</p>'
    );
  });

  it.each(['true', 'false'])(
    'preserves fenced/indented code and inline code in mode %s',
    (stored) => {
      const html = renderWithPreference('```txt\na\nb\n```\n\n    c\n    d\n\n`e\nf`', stored);
      expect(html).toContain('<code class="language-txt">a\nb\n</code>');
      expect(html).toContain('<pre><code>c\nd\n</code>');
      expect(html).toContain('<code>e f</code>');
      expect(html).not.toContain('<br/>');
    }
  );

  it('keeps GFM tables and converts continuation lines inside lists and quotes', () => {
    const html = renderWithPreference(
      '| a | b |\n| - | - |\n| c | d |\n\n- one\n  two\n\n> three\n> four',
      null
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<li>one<br/>\ntwo</li>');
    expect(html).toContain('<p>three<br/>\nfour</p>');
  });

  it('offers a labeled setting independently of runtime API availability', () => {
    const html = renderToStaticMarkup(createElement(MarkdownDisplaySettings));
    expect(html).toContain('for="markdown-breaks-setting"');
    expect(html).toContain('aria-describedby="markdown-breaks-description"');
    expect(html).toContain('<option value="on" selected="">ON</option>');
  });
});

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

  it('resolves preview links beside the document and retains its workspace', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        content:
          '[git](references/git.md) [project](./references/projects/bibliocanvas.md) [parent](../README.md#L8:2) [absolute](/home/user/workspace/README.md) [viewer](/workspace/README.md) [section](#details) [web](https://example.test/docs)',
        sourcePath: 'skills/xs-dev-workflow/SKILL.md',
        workspaceId: 'other-workspace',
      })
    );

    expect(html).toContain(
      'href="/workspace?path=skills%2Fxs-dev-workflow%2Freferences%2Fgit.md&amp;workspaceId=other-workspace"'
    );
    expect(html).toContain(
      'href="/workspace?path=skills%2Fxs-dev-workflow%2Freferences%2Fprojects%2Fbibliocanvas.md&amp;workspaceId=other-workspace"'
    );
    expect(html).toContain(
      'href="/workspace?path=skills%2FREADME.md&amp;line=8&amp;column=2&amp;workspaceId=other-workspace"'
    );
    expect(html).toContain(
      'href="/workspace?path=%2Fhome%2Fuser%2Fworkspace%2FREADME.md&amp;workspaceId=other-workspace"'
    );
    expect(html).toContain('href="/workspace?path=README.md&amp;workspaceId=other-workspace"');
    expect(html).toContain('<a href="#details">section</a>');
    expect(html).toContain('href="https://example.test/docs"');
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
