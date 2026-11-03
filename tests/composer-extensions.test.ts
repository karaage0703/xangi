import { describe, expect, it } from 'vitest';
import { selectComposerExtensions, replaceComposerText } from '../web-ui/src/composerExtensions';

describe('composer extension discovery', () => {
  const entry = {
    id: 'voice-input',
    displayName: 'Voice',
    installed: true,
    running: true,
    healthy: true,
    uiAvailable: true,
    capabilities: ['composer.input'],
  };
  it('requires an installed, running, healthy UI with the opt-in capability', () => {
    expect(selectComposerExtensions([entry])).toEqual([
      { id: entry.id, displayName: entry.displayName },
    ]);
    for (const change of [
      { installed: false },
      { running: false },
      { healthy: false },
      { uiAvailable: false },
      { capabilities: ['other'] },
      { id: '../escape' },
    ])
      expect(selectComposerExtensions([{ ...entry, ...change }])).toEqual([]);
  });
});
describe('text snapshots', () => {
  it('preserves an existing draft and replaces cumulative or revised results', () => {
    let draft = replaceComposerText('既存', '', 'この');
    draft = replaceComposerText(draft, 'この', 'このザンギ');
    draft = replaceComposerText(draft, 'このザンギ', 'このXangi');
    expect(draft).toBe('既存\nこのXangi');
    expect(replaceComposerText(draft, 'このXangi', 'このXangi')).toBe(draft);
    expect(replaceComposerText('手動編集', 'このXangi', '上書き')).toBe('手動編集');
    expect(replaceComposerText('', '', 'はい、はい')).toBe('はい、はい');
  });
});
