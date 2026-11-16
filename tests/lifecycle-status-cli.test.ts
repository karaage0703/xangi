import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { resolveAppLayout } from '../src/installer/layout.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const entry = fileURLToPath(new URL('../src/cli/xangi-main.ts', import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
it.each([
  ['accepted', 2],
  ['running', 2],
  ['failed', 1],
  ['completed', 0],
] as const)(
  'the actual CLI status dispatcher prints %s and exits %i without controlling services',
  (state, code) => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-status-cli-'));
    roots.push(root);
    const layout = resolveAppLayout({
      platform: process.platform,
      arch: process.arch,
      homeDir: root,
      xdgDataHome: join(root, 'data'),
      xdgStateHome: join(root, 'state'),
      xdgConfigHome: join(root, 'config'),
    });
    const id = '00000000-0000-0000-0000-000000000001';
    const result = join(layout.stateDir, 'lifecycle', id, 'result.json');
    mkdirSync(dirname(result), { recursive: true });
    writeFileSync(
      result,
      JSON.stringify({ operation: 'restart', state, detail: 'fixture outcome' })
    );
    const child = spawnSync(
      process.execPath,
      ['--import', tsx, entry, 'restart', 'status', id, '--managed'],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: '/nonexistent',
          HOME: root,
          XDG_DATA_HOME: join(root, 'data'),
          XDG_STATE_HOME: join(root, 'state'),
          XDG_CONFIG_HOME: join(root, 'config'),
        },
      }
    );
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    expect(child.stdout).toContain(`restart: ${state}\nfixture outcome`);
    expect(child.status).toBe(code);
  }
);
