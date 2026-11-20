import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guidedSetupCmd } from '../src/setup/guided-onboarding.js';
import { rescueCmd } from '../src/cli/rescue-cmd.js';
import { SecretStore } from '../src/setup/secret-store.js';
import { resolveAppLayout } from '../src/installer/layout.js';
import { run } from '../src/cli/xangi.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CLI Agy environment precedence', () => {
  it.each([
    ['inherited-test-key', ''],
    ['', 'file-test-key'],
  ])('uses the .env value %s -> %s, including explicit blanks', async (inherited, fileValue) => {
    const root = await mkdtemp(join(tmpdir(), 'cli-agy-env-'));
    roots.push(root);
    const envPath = join(root, '.env');
    await writeFile(envPath, `GEMINI_API_KEY=${fileValue}\n`);
    vi.stubEnv('XANGI_INSTALLATION_KIND', 'checkout');
    vi.stubEnv('XANGI_SKIP_ENV_FILE', 'false');
    vi.stubEnv('XANGI_ENV_PATH', envPath);
    vi.stubEnv('GEMINI_API_KEY', inherited);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['node', 'xangi', 'version']);
    expect(process.env.GEMINI_API_KEY).toBe(fileValue);
  });
});

describe.each(['setup', 'rescue'] as const)('%s Agy authentication', (command) => {
  it.each(['stored', 'explicit', 'empty', 'unset'] as const)(
    'resolves %s credentials without inheriting unrelated stored secrets',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'guided-agy-auth-'));
      roots.push(root);
      vi.stubEnv('HOME', root);
      vi.stubEnv('USERPROFILE', root);
      vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
      vi.stubEnv(
        'GEMINI_API_KEY',
        mode === 'explicit' ? 'explicit-test-key' : mode === 'empty' ? '' : undefined
      );
      vi.stubEnv('DISCORD_TOKEN', undefined);
      vi.stubEnv('ANTIGRAVITY_API_MODEL', 'gemini-test-free');
      const layout = resolveAppLayout({
        platform: process.platform,
        arch: process.arch,
        homeDir: root,
        xdgConfigHome: process.env.XDG_CONFIG_HOME,
      });
      const store = new SecretStore(join(layout.configDir, 'secrets.json'));
      await store.set('DISCORD_TOKEN', 'unrelated-stored-token');
      if (mode !== 'unset') await store.set('GEMINI_API_KEY', 'stored-test-key');
      const bin = join(root, 'bin');
      await mkdir(bin);
      const executable = join(bin, 'agy');
      const capture = join(root, 'capture.json');
      await writeFile(
        executable,
        [
          '#!' + process.execPath,
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), key: process.env.GEMINI_API_KEY, unrelated: process.env.DISCORD_TOKEN }));`,
        ].join('\n'),
        { mode: 0o700 }
      );
      const options = {
        homeDir: root,
        pathEnv: bin,
        env: {},
        canExecute: async (path: string) => path === executable,
        version: async () => 'fake-agy',
        launcherCommand: 'xangi',
        documentationRoot: root,
        installationKind: 'checkout' as const,
      };
      if (command === 'setup') await guidedSetupCmd({ ...options, cwd: root });
      else await rescueCmd({ ...options, layout });
      const captured = JSON.parse(await readFile(capture, 'utf8'));
      const key =
        mode === 'stored'
          ? 'stored-test-key'
          : mode === 'explicit'
            ? 'explicit-test-key'
            : undefined;
      expect(captured.key).toBe(key);
      expect(captured.args.includes('--settings')).toBe(Boolean(key));
      expect(captured.args.includes('--model')).toBe(Boolean(key));
      if (key) {
        expect(captured.args[captured.args.indexOf('--model') + 1]).toBe('gemini-test-free');
        expect(
          JSON.parse(captured.args[1]).customModelsConfig.customModels['gemini-test-free'].modelName
        ).toBe('gemini-api://gemini-test-free');
      }
      expect(captured.unrelated).toBeUndefined();
      expect(captured.args.join(' ')).not.toContain('test-key');
      expect(process.env.GEMINI_API_KEY).toBe(
        mode === 'explicit' ? 'explicit-test-key' : mode === 'empty' ? '' : undefined
      );
    }
  );
});
