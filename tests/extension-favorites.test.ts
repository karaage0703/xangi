import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionFavorites, parseFavoriteAction } from '../src/extension-favorites.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'extension-favorites-'));
  roots.push(root);
  const path = join(root, 'favorites.json');
  return { path, store: new ExtensionFavorites(path) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('extension favorites', () => {
  it('persists registration, ordering, removal and idempotent additions across readers', () => {
    const { path, store } = fixture();
    expect(store.list()).toEqual([]);
    store.update('search', 'add'); store.update('studio', 'add'); store.update('search', 'add');
    const other = new ExtensionFavorites(path);
    expect(other.list()).toEqual(['search', 'studio']);
    other.update('studio', 'up');
    expect(store.list()).toEqual(['studio', 'search']);
    store.update('studio', 'down');
    expect(other.list()).toEqual(['search', 'studio']);
    store.update('search', 'up'); store.update('studio', 'down');
    expect(other.list()).toEqual(['search', 'studio']);
    other.update('search', 'remove'); other.update('search', 'remove');
    expect(store.list()).toEqual(['studio']);
  });
  it('retains corrupt settings instead of silently overwriting them', () => {
    const { path, store } = fixture();
    for (const value of ['{broken', '{}', '["same","same"]', '["../bad"]']) {
      writeFileSync(path, value);
      expect(() => store.update('search', 'add')).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(value);
    }
  });
  it('bounds the list and accepts removals at the limit', () => {
    const { path, store } = fixture();
    writeFileSync(path, JSON.stringify(Array.from({ length: 100 }, (_, i) => `item-${i}`)));
    expect(() => store.update('overflow', 'add')).toThrow();
    expect(store.update('item-0', 'remove')).toHaveLength(99);
  });
  it.each([
    { id: 'valid', action: ['add'] },null, [], {}, { id: '../bad', action: 'add' }, { id: 'valid', action: 'toggle' }, { id: 'a'.repeat(129), action: 'add' }])('rejects malformed input %j', (input) => {
    expect(() => parseFavoriteAction(input)).toThrow();
  });
});
