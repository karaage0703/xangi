import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryControls } from '../web-ui/src/HistoryControls.js';

afterEach(() => vi.unstubAllGlobals());

describe('history controls with child-frame entries', () => {
  it('keeps native traversal available when the top navigation API reports no entries', () => {
    vi.stubGlobal('window', { navigation: { canGoBack: false, canGoForward: false } });
    const ordinary = renderToStaticMarkup(createElement(HistoryControls));
    const embedded = renderToStaticMarkup(
      createElement(HistoryControls, { includeFrameHistory: true })
    );
    expect(ordinary.match(/disabled=""/g)).toHaveLength(2);
    expect(embedded).not.toContain('disabled=');
    expect(embedded).toContain('aria-label="戻る"');
    expect(embedded).toContain('aria-label="進む"');
  });

  it('leaves controls usable when the browser cannot report history boundaries', () => {
    vi.stubGlobal('window', {});
    expect(renderToStaticMarkup(createElement(HistoryControls))).not.toContain('disabled=');
  });
});
