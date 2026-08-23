import type { ChildProcess } from 'child_process';

/**
 * チャンネルごとの実行中プロセスを管理
 */
class ProcessManager {
  private processes = new Map<string, ChildProcess>();

  private hasExited(proc: ChildProcess): boolean {
    return proc.exitCode != null || proc.signalCode != null;
  }

  private waitForClose(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (this.hasExited(proc)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let settled = false;
      const onClose = () => finish();
      const timer = setTimeout(
        () => finish(new Error(`Process did not exit within ${timeoutMs}ms`)),
        timeoutMs
      );
      timer.unref?.();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.off('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      proc.once('close', onClose);

      if (this.hasExited(proc)) finish();
    });
  }

  /**
   * プロセスを登録
   */
  register(channelId: string, proc: ChildProcess): void {
    const existing = this.processes.get(channelId);
    if (existing && !this.hasExited(existing)) {
      proc.kill('SIGTERM');
      throw new Error(`Process is still running for channel ${channelId}`);
    }
    this.processes.set(channelId, proc);

    // プロセス終了時に自動削除
    proc.on('close', () => {
      if (this.processes.get(channelId) === proc) {
        this.processes.delete(channelId);
      }
    });
  }

  /**
   * プロセスを停止
   * @returns true if process was running and stopped
   */
  stop(channelId: string): boolean {
    const proc = this.processes.get(channelId);
    if (proc && !this.hasExited(proc)) {
      if (!proc.killed) proc.kill('SIGTERM');
      return true;
    }
    if (proc && this.processes.get(channelId) === proc) {
      this.processes.delete(channelId);
    }
    return false;
  }

  /** SIGTERM後、実際の終了まで待つ。期限超過時はSIGKILLへ昇格する。 */
  async stopAndWait(channelId: string, timeoutMs = 5_000): Promise<boolean> {
    const proc = this.processes.get(channelId);
    if (!proc) return false;

    if (!this.hasExited(proc) && !proc.killed) {
      proc.kill('SIGTERM');
    }

    try {
      await this.waitForClose(proc, timeoutMs);
    } catch {
      if (!this.hasExited(proc)) proc.kill('SIGKILL');
      await this.waitForClose(proc, 1_000);
    }

    if (this.processes.get(channelId) === proc) {
      this.processes.delete(channelId);
    }
    return true;
  }

  /**
   * プロセスが実行中かどうか
   */
  isRunning(channelId: string): boolean {
    const proc = this.processes.get(channelId);
    return proc != null && !this.hasExited(proc);
  }

  /**
   * すべてのプロセスを停止
   */
  stopAll(): void {
    for (const [channelId] of this.processes) {
      this.stop(channelId);
    }
  }

  async stopAllAndWait(timeoutMs = 5_000): Promise<void> {
    const channelIds = [...this.processes.keys()];
    await Promise.all(channelIds.map((channelId) => this.stopAndWait(channelId, timeoutMs)));
  }
}

// シングルトン
export const processManager = new ProcessManager();
