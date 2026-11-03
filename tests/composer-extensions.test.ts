import { describe, expect, it } from 'vitest';
import { replaceComposerText, selectComposerExtensions } from '../web-ui/src/composerExtensions.js';

describe('composer extensions', () => {
  it('only exposes installed, running, healthy composer extensions', () => {
    const entry = {
      id: 'voice',
      displayName: 'Voice',
      installed: true,
      running: true,
      healthy: true,
      uiAvailable: true,
      capabilities: ['composer.input'],
    };
    expect(
      selectComposerExtensions([
        entry,
        { ...entry, id: 'stopped', running: false },
        { ...entry, id: 'unhealthy', healthy: false },
        { ...entry, id: 'uninstalled', installed: false },
        { ...entry, id: 'other', capabilities: ['terminal'] },
        { ...entry, id: '../invalid' },
      ])
    ).toEqual([{ id: 'voice', displayName: 'Voice' }]);
  });
  it('replaces cumulative snapshots while preserving earlier draft text', () => {
    const draft = replaceComposerText('Existing draft', '', 'こんにちは');
    expect(replaceComposerText(draft, 'こんにちは', 'こんにちは世界')).toBe(
      'Existing draft\nこんにちは世界'
    );
    expect(replaceComposerText(draft, 'こんにちは', 'こんにちは')).toBe(draft);
  });
  it('does not overwrite manual edits or erase a draft with empty recognition', () => {
    expect(replaceComposerText('Manually edited', 'Old recognition', 'Late result')).toBe(
      'Manually edited'
    );
    expect(replaceComposerText('Existing draft', '', '  ')).toBe('Existing draft');
  });
});
