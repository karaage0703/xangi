import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceBrowser, WorkspaceBrowserError } from '../src/workspace-browser.js';

describe('WorkspaceBrowser', () => {
  let workspace: string;
  let browser: WorkspaceBrowser;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'xangi-workspace-browser-'));
    mkdirSync(join(workspace, 'notes'));
    mkdirSync(join(workspace, '.xangi'));
    mkdirSync(join(workspace, 'node_modules'));
    writeFileSync(join(workspace, 'README.md'), '# Workspace\n');
    writeFileSync(join(workspace, 'notes', 'today.md'), 'before\n');
    writeFileSync(join(workspace, '.env'), 'SECRET=value\n');
    writeFileSync(join(workspace, '.xangi', 'state.json'), '{}');
    writeFileSync(join(workspace, 'node_modules', 'package.js'), 'hidden');
    writeFileSync(join(workspace, 'image.png'), 'not text');
    browser = new WorkspaceBrowser(workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('lists only safe directories and viewable files', async () => {
    const root = await browser.list();

    expect(root.path).toBe('');
    expect(root.parent).toBeNull();
    expect(root.entries.map((entry) => entry.name)).toEqual(['notes', 'README.md']);

    const notes = await browser.list('notes');
    expect(notes.parent).toBe('');
    expect(notes.entries.map((entry) => entry.path)).toEqual(['notes/today.md']);
  });

  it('extracts tags from Markdown frontmatter without failing on malformed YAML', async () => {
    writeFileSync(
      join(workspace, 'tagged.md'),
      '---\ntags:\n  - ai\n  - xangi\n  - ai\n---\n# Tagged\n'
    );
    writeFileSync(join(workspace, 'broken.md'), '---\ntags: [broken\n---\n# Broken\n');

    const root = await browser.list();

    expect(root.entries.find((entry) => entry.name === 'tagged.md')?.tags).toEqual([
      'ai',
      'xangi',
    ]);
    expect(root.entries.find((entry) => entry.name === 'broken.md')?.tags).toBeUndefined();
  });

  it('reads and atomically saves an existing file', async () => {
    const opened = await browser.read('notes/today.md');
    const saved = await browser.write('notes/today.md', 'after\n', opened.version);

    expect(saved.content).toBe('after\n');
    expect(saved.version).not.toBe(opened.version);
    expect(readFileSync(join(workspace, 'notes', 'today.md'), 'utf8')).toBe('after\n');
  });

  it('rejects a save when the file changed after opening', async () => {
    const opened = await browser.read('notes/today.md');
    writeFileSync(join(workspace, 'notes', 'today.md'), 'changed elsewhere\n');

    await expect(
      browser.write('notes/today.md', 'browser edit\n', opened.version)
    ).rejects.toMatchObject<Partial<WorkspaceBrowserError>>({ status: 409 });
    expect(readFileSync(join(workspace, 'notes', 'today.md'), 'utf8')).toBe(
      'changed elsewhere\n'
    );
  });

  it('rejects traversal, hidden paths, unsupported files, and symbolic links', async () => {
    const outside = join(workspace, '..', `${workspace.split('/').pop()}-outside.md`);
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(workspace, 'linked.md'));

    try {
      await expect(browser.read('../outside.md')).rejects.toMatchObject({ status: 400 });
      await expect(browser.read('.env')).rejects.toMatchObject({ status: 403 });
      await expect(browser.read('image.png')).rejects.toMatchObject({ status: 403 });
      await expect(browser.read('linked.md')).rejects.toMatchObject({ status: 403 });
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('rejects files larger than the configured editor limit', async () => {
    const limited = new WorkspaceBrowser(workspace, 8);
    writeFileSync(join(workspace, 'large.md'), '123456789');

    await expect(limited.read('large.md')).rejects.toMatchObject({ status: 413 });
    const root = await limited.list();
    expect(root.entries.some((entry) => entry.name === 'large.md')).toBe(false);
  });
});
