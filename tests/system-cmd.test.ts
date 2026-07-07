import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { systemCmd } from '../src/cli/system-cmd.js';

/**
 * src/cli/system-cmd.ts のリグレッションテスト。
 *
 * - system_restart: 自プロセスに SIGTERM を送る (PID ファイル経路は廃止、tool-server 経由で本体内実行が前提)
 * - PR #189 (WORKSPACE_PATH): DATA_DIR 未設定時に WORKSPACE_PATH/.xangi を使う
 */
describe('system-cmd', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'system-cmd-test-'));
    originalEnv = { ...process.env };
    delete process.env.DATA_DIR;
    process.env.WORKSPACE_PATH = tmpDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('system_settings (PR #189)', () => {
    it('writes settings.json under WORKSPACE_PATH/.xangi when DATA_DIR is unset', async () => {
      const result = await systemCmd('system_settings', { key: 'foo', value: 'bar' });
      expect(result).toContain('foo');

      const expectedPath = join(tmpDir, '.xangi', 'settings.json');
      expect(existsSync(expectedPath)).toBe(true);
      const data = JSON.parse(readFileSync(expectedPath, 'utf-8'));
      expect(data.foo).toBe('bar');
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

    it('returns empty settings by default when settings.json does not exist', async () => {
      const result = await systemCmd('system_settings', {});
      expect(result).toContain('(なし)');
    });

    it('rejects self lifecycle runtime setting writes', async () => {
      await expect(
        systemCmd('system_settings', { key: 'selfLifecycle', value: 'restart-only' })
      ).rejects.toThrow('selfLifecycle');
      await expect(
        systemCmd('system_settings', { key: 'XANGI_SELF_LIFECYCLE', value: 'restart-only' })
      ).rejects.toThrow('XANGI_SELF_LIFECYCLE');
    });
  });

  describe('system_restart', () => {
    it('refuses by default when XANGI_SELF_LIFECYCLE is unset', async () => {
      delete process.env.XANGI_SELF_LIFECYCLE;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        const result = await systemCmd('system_restart', {});
        expect(result).toContain('自己再起動が無効');
        // SIGTERM は飛んでないこと
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('sends SIGTERM to its own process and returns success', async () => {
      process.env.XANGI_SELF_LIFECYCLE = 'restart-only';
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        const result = await systemCmd('system_restart', {});
        expect(result).toContain('再起動をリクエスト');

        // 応答は先に返る。SIGTERM は 100ms 後に自プロセスへ送られる
        expect(killSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(150);
        expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('treats invalid XANGI_SELF_LIFECYCLE values as off', async () => {
      process.env.XANGI_SELF_LIFECYCLE = 'full';
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        const result = await systemCmd('system_restart', {});
        expect(result).toContain('自己再起動が無効');
        await vi.advanceTimersByTimeAsync(150);
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });
});
