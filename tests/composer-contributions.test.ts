import { describe, expect, it } from 'vitest';
import {
  applyComposerSnapshot,
  selectComposerContributions,
} from '../web-ui/src/composerContributions.js';

describe('composer extensions', () => {
  it('only exposes installed, running, healthy composer extensions', () => {
    const entry = {
      id: 'snippets',
      displayName: 'Snippets',
      installed: true,
      running: true,
      healthy: true,
      uiAvailable: true,
      capabilities: [],
      composer: { path: '/snippet/' },
    };
    expect(
      selectComposerContributions([
        entry,
        { ...entry, id: 'stopped', running: false },
        { ...entry, id: 'unhealthy', healthy: false },
        { ...entry, id: 'uninstalled', installed: false },
        { ...entry, id: 'other', composer: undefined },
        { ...entry, id: '../invalid' },
      ])
    ).toEqual([{ id: 'snippets', displayName: 'Snippets', path: '/snippet/' }]);
  });
  it('replaces cumulative snapshots while preserving earlier draft text', () => {
    const draft = applyComposerSnapshot('Existing draft', '', 'こんにちは');
    expect(applyComposerSnapshot(draft, 'こんにちは', 'こんにちは世界')).toBe(
      'Existing draft\nこんにちは世界'
    );
    expect(applyComposerSnapshot(draft, 'こんにちは', 'こんにちは')).toBe(draft);
  });
  it('does not overwrite manual edits or erase a draft with empty recognition', () => {
    expect(applyComposerSnapshot('Manually edited', 'Old recognition', 'Late result')).toBe(
      'Manually edited'
    );
    expect(applyComposerSnapshot('Existing draft', '', '  ')).toBe('Existing draft');
  });
});
