import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { MessageContent, splitMedia } from '../web-ui/src/MessageContent.js';

describe('MessageContent', () => {
  it('renders mixed text and media parts without missing-key warnings', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    renderToStaticMarkup(
      createElement(MessageContent, {
        content: 'before MEDIA:/tmp/example.png after',
        markdown: true,
      })
    );

    expect(error.mock.calls.flat().join(' ')).not.toContain(
      'Each child in a list should have a unique "key" prop.'
    );
    error.mockRestore();
  });

  it('keeps media notation inside fenced and indented code as text', () => {
    const content = [
      'before',
      '```text',
      'MEDIA:/tmp/fenced.png',
      '```',
      '    MEDIA:/tmp/indented.png',
      'after',
    ].join('\n');

    expect(splitMedia(content)).toEqual([{ kind: 'text', value: content }]);
  });

  it('does not close a fence when a code line starts with backticks and more text', () => {
    const content = ['````text', '```not-a-closing-fence', 'MEDIA:/tmp/fenced.png', '````'].join(
      '\n'
    );

    expect(splitMedia(content)).toEqual([{ kind: 'text', value: content }]);
  });

  it('keeps media notation inside inline code as text', () => {
    const content = 'Use `MEDIA:/tmp/example.png` in the response.';

    expect(splitMedia(content)).toEqual([{ kind: 'text', value: content }]);
  });

  it('stops media paths before prose punctuation', () => {
    expect(splitMedia('画像 MEDIA:/tmp/example.png）。 次へ')).toEqual([
      { kind: 'text', value: '画像 ' },
      { kind: 'media', value: '/tmp/example.png' },
      { kind: 'text', value: '）。 次へ' },
    ]);
  });

  it('still extracts media notation outside code', () => {
    const parts = splitMedia('`MEDIA:/tmp/code.png`\nMEDIA:/tmp/real.png');

    expect(parts).toEqual([
      { kind: 'text', value: '`MEDIA:/tmp/code.png`\n' },
      { kind: 'media', value: '/tmp/real.png' },
    ]);
  });
});
