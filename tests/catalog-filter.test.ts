import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CatalogFilter } from '../web-ui/src/CatalogFilter';

describe('catalog search controls', () => {
  it.each([false, true])('shows no list filter when editing (agent=%s)', (agentMode) => {
    expect(
      renderToStaticMarkup(
        React.createElement(CatalogFilter, {
          editing: true,
          agentMode,
          query: '',
          onChange: () => {},
        })
      )
    ).toBe('');
  });
  it.each([false, true])(
    'labels the selected list and has no Avatar exclusion control (agent=%s)',
    (agentMode) => {
      const html = renderToStaticMarkup(
        React.createElement(CatalogFilter, {
          editing: false,
          agentMode,
          query: 'test',
          onChange: () => {},
        })
      );
      expect(html).toContain(agentMode ? 'エージェントを検索' : 'プロジェクトを検索');
      expect(html).not.toContain('Avatar');
      expect(html).not.toContain('checkbox');
      expect(html).toContain('value="test"');
    }
  );
});
