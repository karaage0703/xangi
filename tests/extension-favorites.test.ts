import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionFavorites, parseFavoriteAction, defaultExtensionName } from '../src/extension-favorites.js';

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

it('migrates legacy favorites, preserves names while sorting, and resets names', () => {
  const { path, store } = fixture();
  writeFileSync(path, JSON.stringify(['xangi-mail', 'xangi-tasks']));
  store.update('xangi-mail', 'rename', '  メール  ');
  store.update('xangi-mail', 'down');
  const other = new ExtensionFavorites(path);
  expect(other.entries()).toEqual([{id: 'xangi-tasks'}, {id: 'xangi-mail', displayName: 'メール'}]);
  other.update('xangi-mail', 'add');
  expect(store.entries()[1].displayName).toBe('メール');
  other.update('xangi-mail', 'rename', '  ');
  expect(store.entries()[1]).toEqual({id: 'xangi-mail'});
  expect(defaultExtensionName('xangi-mail')).toBe('mail');
  expect(defaultExtensionName('My xangi-mail')).toBe('My xangi-mail');
  expect(() => store.update('absent', 'rename', 'name')).toThrow();
});
it.each([undefined, null, 1, 'x'.repeat(81), 'line\nbreak', 'tab\tname'])('rejects invalid names without modifying the saved file: %j', (displayName) => {
  const { path, store } = fixture();
  store.update('xangi-mail', 'add');
  const before = readFileSync(path, 'utf8');
  expect(() => parseFavoriteAction({id:'xangi-mail', action:'rename', displayName})).toThrow();
  expect(readFileSync(path, 'utf8')).toBe(before);
});

it('persists sidebar visibility independently of names, order and membership', () => {
  const { path, store } = fixture();
  writeFileSync(path, JSON.stringify(['mail', { id: 'tasks', displayName: 'Tasks' }]));
  store.update('mail', 'set-sidebar', undefined, false);
  store.update('mail', 'rename', 'Mail');
  store.update('mail', 'down');
  store.update('mail', 'add');
  const other = new ExtensionFavorites(path);
  expect(other.list()).toEqual(['tasks', 'mail']);
  expect(other.entries()[1]).toEqual({ id: 'mail', displayName: 'Mail', showInSidebar: false });
  other.update('mail', 'rename', '');
  expect(store.entries()[1]).toEqual({ id: 'mail', showInSidebar: false });
  other.update('mail', 'set-sidebar', undefined, true);
  expect(store.entries()[1].showInSidebar).toBe(true);
  expect(() => store.update('missing', 'set-sidebar', undefined, false)).toThrow();
});
it.each([undefined, null, 'false', 0, {}])('rejects invalid sidebar flags without overwriting: %j', (showInSidebar) => {
  const { path, store } = fixture();
  store.update('mail', 'add');
  const before = readFileSync(path, 'utf8');
  expect(() => parseFavoriteAction({ id: 'mail', action: 'set-sidebar', showInSidebar })).toThrow();
  expect(readFileSync(path, 'utf8')).toBe(before);
  writeFileSync(path, JSON.stringify([{ id: 'mail', showInSidebar }]));
  if (showInSidebar !== undefined) {
    expect(() => store.update('mail', 'add')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify([{ id: 'mail', showInSidebar }]));
  }
});
