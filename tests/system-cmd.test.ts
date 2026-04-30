import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import { systemCmd } from '../src/cli/system-cmd.js';

/**
 * src/cli/system-cmd.ts のリグレッションテスト。
 *
 * - PR #199 (system_restart): PIDファイル方式の各分岐 + SIGTERM 送信
 * - PR #189 (WORKSPACE_PATH): DATA_DIR 未設定時に WORKSPACE_PATH/.xangi を使う
 *
 * .xangi の場所と autoRestart デフォルトが退行しないことを保証する。
 */
describe('system-cmd', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let spawnedProcs: ChildProcess[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'system-cmd-test-'));
    originalEnv = { ...process.env };
    delete process.env.DATA_DIR;
    process.env.WORKSPACE_PATH = tmpDir;
    spawnedProcs = [];
  });

  afterEach(() => {
    for (const p of spawnedProcs) {
      try {
        if (p.pid && !p.killed) p.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('system_settings (PR #189)', () => {
    it('writes settings.json under WORKSPACE_PATH/.xangi when DATA_DIR is unset', async () => {
      const result = await systemCmd('system_settings', { key: 'autoRestart', value: 'false' });
      expect(result).toContain('autoRestart');

      const expectedPath = join(tmpDir, '.xangi', 'settings.json');
      expect(existsSync(expectedPath)).toBe(true);
      const data = JSON.parse(readFileSync(expectedPath, 'utf-8'));
      expect(data.autoRestart).toBe(false);
    });

    it('respects DATA_DIR over WORKSPACE_PATH', async () => {
      const dataDir = join(tmpDir, 'custom-data');
      mkdirSync(dataDir, { recursive: true });
      process.env.DATA_DIR = dataDir;

      await systemCmd('system_settings', { key: 'foo', value: 'bar' });

      expect(existsSync(join(dataDir, 'settings.json'))).toBe(true);
      // WORKSPACE_PATH/.xangi 側には書かれない
      expect(existsSync(join(tmpDir, '.xangi', 'settings.json'))).toBe(false);
    });

    it('returns autoRestart=true by default when settings.json does not exist', async () => {
      const result = await systemCmd('system_settings', {});
      expect(result).toContain('autoRestart');
      expect(result).toContain('true');
    });
  });

  describe('system_restart (PR #199)', () => {
    it('refuses when autoRestart is false', async () => {
      // settings.json を autoRestart=false で先に作る
      await systemCmd('system_settings', { key: 'autoRestart', value: 'false' });

      const result = await systemCmd('system_restart', {});
      expect(result).toContain('自動再起動が無効');
    });

    it('warns when PID file is missing', async () => {
      // autoRestart デフォルト=true、PIDファイルなし
      const result = await systemCmd('system_restart', {});
      expect(result).toContain('PIDファイルが見つかりません');
    });

    it('warns when PID file content is invalid', async () => {
      const dataDir = join(tmpDir, '.xangi');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'xangi.pid'), 'not-a-number');

      const result = await systemCmd('system_restart', {});
      expect(result).toContain('内容が不正');
    });

    it('warns when PID points to a non-existent process (stale)', async () => {
      const dataDir = join(tmpDir, '.xangi');
      mkdirSync(dataDir, { recursive: true });
      // ほぼ確実に存在しないPID（OSの上限近傍）
      writeFileSync(join(dataDir, 'xangi.pid'), '99999999');

      const result = await systemCmd('system_restart', {});
      expect(result).toContain('プロセスが存在しません');
    });

    it('sends SIGTERM to the live process and returns success', async () => {
      // SIGTERM ハンドラを持つ子プロセスを spawn
      const child = spawn(
        'node',
        [
          '-e',
          `
          process.on('SIGTERM', () => { process.exit(0); });
          setInterval(() => {}, 1000);
          `,
        ],
        { stdio: 'ignore' }
      );
      spawnedProcs.push(child);

      // 起動を待つ
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(child.pid).toBeGreaterThan(0);

      // PIDファイルを書く
      const dataDir = join(tmpDir, '.xangi');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'xangi.pid'), String(child.pid));

      // 子プロセスの exit を待つ Promise
      const exited = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code));
      });

      const result = await systemCmd('system_restart', {});
      expect(result).toContain('再起動をリクエスト');

      // SIGTERM で graceful shutdown → exit code 0
      const exitCode = await Promise.race([
        exited,
        new Promise<number | null>((resolve) => setTimeout(() => resolve(-1), 2000)),
      ]);
      expect(exitCode).toBe(0);
    });
  });
});
