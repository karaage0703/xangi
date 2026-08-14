import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prependWebProjectPrompt,
  validateWebProjectsState,
  WebProjectStore,
} from '../src/web-projects.js';

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

  it('keeps starting when one persisted Project uses an unavailable backend', () => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-web-projects-'));
    directories.push(root);
    const filePath = join(root, 'web-projects.json');
    const persisted = {
      version: 1,
      projects: [
        {
          id: 'legacy-search',
          name: 'Legacy Search',
          prompt: '',
          backend: 'removed-backend',
          model: 'old-model',
          effort: 'high',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
        {
          id: 'valid',
          name: 'Valid',
          prompt: '',
          backend: 'codex',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      ],
    };
    writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = WebProjectStore.fromDataDir(root);

    expect(store.get('legacy-search')).toMatchObject({ name: 'Legacy Search', prompt: '' });
    expect(store.get('legacy-search')?.backend).toBeUndefined();
    expect(store.get('valid')?.backend).toBe('codex');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('backend/model/effortを無効化'));
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(persisted);
  });

  it('skips one malformed persisted Project and keeps the remaining Projects', () => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-web-projects-'));
    directories.push(root);
    writeFileSync(
      join(root, 'web-projects.json'),
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: 'broken',
            name: 'Broken',
            createdAt: '2026-08-12T00:00:00.000Z',
            updatedAt: '2026-08-12T00:00:00.000Z',
          },
          {
            id: 'valid',
            name: 'Valid',
            prompt: '',
            createdAt: '2026-08-12T00:00:00.000Z',
            updatedAt: '2026-08-12T00:00:00.000Z',
          },
        ],
      })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = WebProjectStore.fromDataDir(root);

    expect(store.get('broken')).toBeUndefined();
    expect(store.get('valid')?.name).toBe('Valid');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('このProjectをスキップ'));
  });

  it('reports persisted Project issues without changing the state file', () => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-web-projects-'));
    directories.push(root);
    const filePath = join(root, 'web-projects.json');
    const raw = `${JSON.stringify({
      version: 1,
      projects: [
        {
          id: 'legacy-search',
          name: 'Legacy Search',
          prompt: '',
          backend: 'removed-backend',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      ],
    })}\n`;
    writeFileSync(filePath, raw);

    expect(validateWebProjectsState(root)).toEqual([
      expect.objectContaining({
        projectId: 'legacy-search',
        recovery: 'disable-backend-settings',
      }),
    ]);
    expect(readFileSync(filePath, 'utf8')).toBe(raw);
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
