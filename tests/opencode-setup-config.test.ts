import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppLayout } from '../src/installer/layout.js';
import { configureOpenCodeSetup } from '../src/setup/opencode-config.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), 'xangi-opencode-config-'));
  roots.push(homeDir);
  return resolveAppLayout({ platform: 'linux', arch: 'x64', homeDir });
}

describe('OpenCode guided setup config', () => {
  it('writes a private xangi-owned OpenAI-compatible config with effort variants', async () => {
    const layout = await fixture();
    const answers = ['2', '', 'qwen3.8-27b', '', ''];
    const result = await configureOpenCodeSetup({
      layout,
      question: async () => answers.shift() ?? '',
    });

    expect(result).toEqual({
      configPath: join(layout.configDir, 'opencode.json'),
      model: 'xangi-local/qwen3.8-27b',
    });
    const config = JSON.parse(await readFile(result.configPath!, 'utf8'));
    expect(config.provider['xangi-local'].options.baseURL).toBe('http://127.0.0.1:8001/v1');
    expect(config.provider['xangi-local'].models['qwen3.8-27b']).toMatchObject({
      limit: { context: 262144, output: 8192 },
      variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
    });
    expect((await stat(result.configPath!)).mode & 0o777).toBe(0o600);
  });

  it('keeps existing OpenCode configuration untouched', async () => {
    const layout = await fixture();
    await expect(
      configureOpenCodeSetup({ layout, question: async () => '' })
    ).resolves.toEqual({});
    await expect(readFile(join(layout.configDir, 'opencode.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects unsafe provider URLs before writing', async () => {
    const layout = await fixture();
    const answers = ['2', 'https://user:secret@example.com/v1', 'qwen'];
    await expect(
      configureOpenCodeSetup({ layout, question: async () => answers.shift() ?? '' })
    ).rejects.toThrow('認証情報');
  });
});
