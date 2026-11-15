import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionDevelopmentPrompt } from '../src/extension-development.js';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

describe('extension development resources', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([true, false])(
    'guides template creation and verification (local template: %s)',
    async (localTemplate) => {
      vi.mocked(readFile).mockResolvedValueOnce('host guide');
      if (localTemplate) vi.mocked(readFile).mockResolvedValueOnce('template guide');
      else
        vi.mocked(readFile).mockRejectedValueOnce(
          Object.assign(new Error('missing'), { code: 'ENOENT' })
        );

      const prompt = await extensionDevelopmentPrompt();
      expect(prompt).toContain('use the requested template or the latest published template');
      expect(prompt).toContain('gh repo create OWNER/NEW_REPO --template');
      expect(prompt).toContain('When GitHub repository creation is requested');
      expect(prompt).toContain('For local-only work, copy the template files');
      expect(prompt).toContain('npm run configure -- --id NEW_ID');
      expect(prompt).toContain('npm test, and npm run build');
      expect(prompt).toContain('Reuse the template configuration, startup/authentication');
      expect(prompt).toContain('Compare changes with the template');
    }
  );

  it('includes the development template README when the source package is present', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('host guide').mockResolvedValueOnce('template guide');
    const prompt = await extensionDevelopmentPrompt();
    expect(prompt).toContain('packages/extension-template/');
    expect(prompt).toContain('template guide');
    expect(prompt).toContain('host guide');
    expect(prompt).not.toContain('not included in this xangi release');
  });

  it('works in a released host without the independently published template', async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce('installed host contract')
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const prompt = await extensionDevelopmentPrompt();
    expect(prompt).toContain('https://github.com/karaage0703/xangi-extension-template');
    expect(prompt).toContain('not included in this xangi release');
    expect(prompt).toContain('Check that the publication target is available');
    expect(prompt).toContain('installed host contract');
    expect(prompt).not.toContain('Local development template directory:');
    expect(prompt).not.toContain('## Local template instructions');
  });

  it('reports a missing host guide and template read errors instead of hiding them', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('missing host guide'));
    await expect(extensionDevelopmentPrompt()).rejects.toThrow('guide is missing');
    vi.mocked(readFile)
      .mockResolvedValueOnce('host guide')
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(extensionDevelopmentPrompt()).rejects.toThrow('denied');
  });
});
