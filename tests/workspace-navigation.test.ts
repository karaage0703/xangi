import { describe, expect, it } from 'vitest';
import {
  lineSelection,
  workspaceParentPath,
  workspaceTargetFromHref,
  workspaceTargetFromSearch,
  workspaceViewerUrl,
} from '../web-ui/src/workspace-navigation.js';

describe('workspace navigation', () => {
  it('parses relative, viewer-style, hash, and absolute file references', () => {
    expect(workspaceTargetFromHref('AGENTS.md:12')).toEqual({ path: 'AGENTS.md', line: 12 });
    expect(workspaceTargetFromHref('/workspace/notes/example.md#L8')).toEqual({
      path: 'notes/example.md',
      line: 8,
    });
    expect(workspaceTargetFromHref('src/index.ts#L8:4')).toEqual({
      path: 'src/index.ts',
      line: 8,
      column: 4,
    });
    expect(workspaceTargetFromHref('/home/user/workspace/README.md:3')).toEqual({
      path: '/home/user/workspace/README.md',
      line: 3,
    });
  });

  it('does not rewrite application routes, fragments, APIs, or external URLs', () => {
    for (const href of [
      '/workspace',
      '/workspace?path=README.md',
      '/monitor',
      '/api/workspace/file',
      '#section',
      'https://example.test/file.md',
      'mailto:test@example.test',
    ]) {
      expect(workspaceTargetFromHref(href)).toBeUndefined();
    }
  });

  it('round-trips a viewer deep link', () => {
    const target = { path: 'notes/My Note.md', line: 12, column: 3 };
    const url = workspaceViewerUrl(target);

    expect(url).toBe('/workspace?path=notes%2FMy+Note.md&line=12&column=3');
    expect(workspaceTargetFromSearch(url.slice(url.indexOf('?')))).toEqual(target);
    expect(workspaceParentPath(target.path)).toBe('notes');
  });

  it('clamps a requested line and column to the file content', () => {
    expect(lineSelection('one\ntwo\nthree', 2, 2)).toEqual({
      start: 5,
      end: 7,
      line: 2,
      column: 2,
    });
    expect(lineSelection('one\ntwo', 99, 99)).toEqual({
      start: 7,
      end: 7,
      line: 2,
      column: 4,
    });
  });
});
