import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { MessageContent } from '../web-ui/src/MessageContent.js';

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
});
