import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertRuntimeStateCanStart,
  validateRuntimeState,
} from '../src/runtime-state-validation.js';

describe('runtime state validation', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('blocks restart read-only when Web Project state is incompatible', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'xangi-runtime-state-'));
    directories.push(workspace);
    const dataDir = join(workspace, '.xangi');
    mkdirSync(dataDir);
    const statePath = join(dataDir, 'web-projects.json');
    const raw = `${JSON.stringify({
      version: 1,
      projects: [
        {
          id: 'legacy',
          name: 'Legacy',
          prompt: '',
          backend: 'removed-backend',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      ],
    })}\n`;
    writeFileSync(statePath, raw);
    const options = {
      cwd: workspace,
      env: { WEB_CHAT_ENABLED: 'true', WORKSPACE_PATH: workspace },
    };

    expect(validateRuntimeState(options)).toEqual([
      expect.stringContaining('Project "Legacy": Projectのバックエンドが不正です'),
    ]);
    expect(() => assertRuntimeStateCanStart(options)).toThrow('再起動前のstate検証に失敗しました');
    expect(readFileSync(statePath, 'utf8')).toBe(raw);
  });

  it('does not validate Web Project state when Web Chat is disabled', () => {
    expect(validateRuntimeState({ env: { WEB_CHAT_ENABLED: 'false' }, cwd: '/not-used' })).toEqual(
      []
    );
  });
});
