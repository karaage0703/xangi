import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { systemCmd } from '../src/cli/system-cmd.js';

/**
 * src/cli/system-cmd.ts のリグレッションテスト。
 *
 * - system_restart: 自プロセスに SIGTERM を送る (PID ファイル経路は廃止、tool-server 経由で本体内実行が前提)
 * - generic system_settings is intentionally unavailable
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

  describe('system_settings', () => {
    it('is unavailable and cannot write arbitrary runtime settings', async () => {
      await expect(systemCmd('system_settings', { key: 'foo', value: 'bar' })).rejects.toThrow(
        'Unknown system command: system_settings'
      );
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

    it('does not send SIGTERM when persisted runtime state is incompatible', async () => {
      process.env.XANGI_SELF_LIFECYCLE = 'restart-only';
      process.env.WEB_CHAT_ENABLED = 'true';
      const dataDir = join(tmpDir, '.xangi');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, 'web-projects.json'),
        JSON.stringify({
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
        })
      );
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await expect(systemCmd('system_restart', {})).rejects.toThrow(
        '再起動前のstate検証に失敗しました'
      );
      expect(killSpy).not.toHaveBeenCalled();
    });
  });
});
