import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manageMacWorker, workerInstallLayout } from '../src/remote-worker/install.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

describe('launchd service removal deadline', () => {
  let root: string;
  let elapsed: number;
  let removalDelay: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xangi-launchd-wait-'));
    vi.stubEnv('XANGI_WORKER_HOME', root);
    vi.stubEnv('XANGI_WORKER_LAUNCH_AGENTS_DIR', root);
    vi.stubEnv('XANGI_WORKER_CLI', '/bin/true');
    vi.stubEnv('XANGI_WORKER_ALLOW_NON_DARWIN', 'true');
    const layout = workerInstallLayout();
    writeFileSync(layout.configPath, '{}');
    writeFileSync(layout.tokenPath, 'test-token');
    writeFileSync(layout.plistPath, 'existing plist');
    elapsed = 0;
    removalDelay = 6_000;
    vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
    // Advance the clock synchronously: Atomics.wait blocks the JS event loop,
    // so ordinary fake timer callbacks cannot drive this polling loop.
    vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
      elapsed += timeout ?? 0;
      return 'timed-out';
    });
    vi.mocked(spawnSync).mockImplementation((_command, args) => ({
      pid: 1,
      output: [null, '', ''],
      stdout: '',
      stderr: '',
      status: args?.[0] === 'print' && elapsed >= removalDelay ? 113 : 0,
      signal: null,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(spawnSync).mockReset();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('restarts only after removal taking longer than the 5s exit grace period', () => {
    expect(manageMacWorker('restart')).toContain('restarted');
    expect(elapsed).toBe(6_000);
    const commands = vi.mocked(spawnSync).mock.calls.map((call) => call[1]?.[0]);
    expect(commands[0]).toBe('bootout');
    expect(commands.at(-1)).toBe('bootstrap');
    expect(commands.filter((command) => command === 'bootstrap')).toHaveLength(1);
    expect(readFileSync(workerInstallLayout().tokenPath, 'utf8')).toBe('test-token');
  });

  it.each(['restart', 'stop', 'uninstall'] as const)(
    '%s times out without bootstrap or credential deletion when removal never completes',
    (action) => {
      removalDelay = Infinity;
      expect(() => manageMacWorker(action)).toThrow('Timed out waiting for launchd to remove');
      expect(elapsed).toBe(15_000);
      expect(vi.mocked(spawnSync).mock.calls.some((call) => call[1]?.[0] === 'bootstrap')).toBe(
        false
      );
      const layout = workerInstallLayout();
      expect(readFileSync(layout.configPath, 'utf8')).toBe('{}');
      expect(readFileSync(layout.tokenPath, 'utf8')).toBe('test-token');
      expect(existsSync(layout.plistPath)).toBe(true);
    }
  );
});
