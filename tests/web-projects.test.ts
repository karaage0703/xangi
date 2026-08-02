import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prependWebProjectPrompt, WebProjectStore } from '../src/web-projects.js';

describe('WebProjectStore', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists logical projects without creating a project workspace directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-web-projects-'));
    directories.push(root);
    const dataDir = join(root, 'state');
    const workspace = join(root, 'workspace');
    const store = WebProjectStore.fromDataDir(dataDir);

    const project = store.create({
      name: 'ブログ',
      prompt: '技術ブログの編集者として回答する',
    });

    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(join(root, 'projects'))).toBe(false);
    expect(WebProjectStore.fromDataDir(dataDir).get(project.id)).toMatchObject({
      name: 'ブログ',
      prompt: '技術ブログの編集者として回答する',
    });
    expect(JSON.parse(readFileSync(join(dataDir, 'web-projects.json'), 'utf8')).version).toBe(1);
  });

  it('updates names and prompts while rejecting duplicate names', () => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-web-projects-'));
    directories.push(root);
    const store = WebProjectStore.fromDataDir(root);
    const first = store.create({ name: 'Project A' });
    store.create({ name: 'Project B' });

    expect(store.update(first.id, { name: 'Project C', prompt: '追加指示' })).toMatchObject({
      name: 'Project C',
      prompt: '追加指示',
    });
    expect(() => store.update(first.id, { name: 'Project B' })).toThrow(
      '同じ名前のProjectがすでにあります'
    );
  });

  it('persists Project backend settings and preserves them on a name-only update', () => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-web-projects-'));
    directories.push(root);
    const store = WebProjectStore.fromDataDir(root);
    const project = store.create({
      name: '実装',
      backend: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });

    expect(WebProjectStore.fromDataDir(root).get(project.id)).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(store.update(project.id, { name: '実装・レビュー' })).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
  });

  it('clears Project backend settings and rejects model-only settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-web-projects-'));
    directories.push(root);
    const store = WebProjectStore.fromDataDir(root);
    const project = store.create({ name: '実装', backend: 'codex', model: 'gpt-test' });

    const cleared = store.update(project.id, { backend: null, model: null, effort: null });
    expect(cleared.backend).toBeUndefined();
    expect(cleared.model).toBeUndefined();
    expect(cleared.effort).toBeUndefined();
    expect(() => store.create({ name: '不正', model: 'gpt-test' })).toThrow(
      'モデルまたはeffortを設定するにはバックエンドが必要です'
    );
  });
});

describe('prependWebProjectPrompt', () => {
  it('adds only a configured prompt and keeps the user message intact', () => {
    const project = {
      id: 'project-1',
      name: '調査',
      prompt: '一次情報を優先する',
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
    };

    expect(prependWebProjectPrompt(project, '質問')).toContain('一次情報を優先する');
    expect(prependWebProjectPrompt(project, '質問')).toMatch(/質問$/);
    expect(prependWebProjectPrompt({ ...project, prompt: '' }, '質問')).toBe('質問');
  });
});
