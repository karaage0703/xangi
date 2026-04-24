import { PersistentRunner } from './persistent-runner.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import type { AgentConfig } from './config.js';
import {
  getChannelModelConfig,
  setChannelModelConfig,
  deleteChannelModelConfig,
  isOpusModel,
  type ChannelModelConfig,
} from './channel-models.js';
import { deleteSession } from './sessions.js';

/**
 * プール内のランナー情報
 */
interface PoolEntry {
  runner: PersistentRunner;
  lastUsed: number;
  model?: string;
  effort?: string;
}

/**
 * 複数チャンネル同時処理を実現するランナーマネージャー
 *
 * チャンネルごとに独立した PersistentRunner を管理し、
 * LRU eviction とアイドルタイムアウトでリソースを制御する。
 */
export class RunnerManager implements AgentRunner {
  private pool = new Map<string, PoolEntry>();
  private maxProcesses: number;
  private idleTimeoutMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private agentConfig: AgentConfig;

  /** デフォルトのチャンネルID（channelIdが未指定の場合に使用） */
  private static readonly DEFAULT_CHANNEL = '__default__';
  /** クリーンアップ実行間隔 */
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5分

  constructor(
    agentConfig: AgentConfig,
    options?: {
      maxProcesses?: number;
      idleTimeoutMs?: number;
    }
  ) {
    this.agentConfig = agentConfig;
    this.maxProcesses = options?.maxProcesses ?? 10;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? 4 * 60 * 60 * 1000; // 4時間

    // 定期クリーンアップ開始
    this.cleanupInterval = setInterval(() => this.cleanupIdle(), RunnerManager.CLEANUP_INTERVAL_MS);

    console.log(
      `[runner-manager] Initialized (maxProcesses: ${this.maxProcesses}, idleTimeout: ${this.idleTimeoutMs / 1000}s)`
    );
  }

  /**
   * Resolve the effective model and effort for a channel
   */
  private resolveChannelConfig(channelId: string): { model?: string; effort?: string } {
    const channelConfig = getChannelModelConfig(channelId);
    const model = channelConfig?.model ?? this.agentConfig.model;
    // effort is only applied if the effective model is Opus
    const rawEffort = channelConfig?.effort ?? this.agentConfig.effort;
    const effort = isOpusModel(model) ? rawEffort : undefined;
    return { model, effort };
  }

  /**
   * チャンネルに対応する PersistentRunner を取得（なければ作成）
   */
  private getOrCreateRunner(channelId: string): PersistentRunner {
    const { model, effort } = this.resolveChannelConfig(channelId);
    const entry = this.pool.get(channelId);

    if (entry) {
      // Check if model/effort changed — if so, shutdown and recreate
      if (entry.model !== model || entry.effort !== effort) {
        console.log(
          `[runner-manager] Config changed for channel ${channelId}: ` +
            `${entry.model}/${entry.effort} -> ${model}/${effort}. Recreating runner.`
        );
        entry.runner.shutdown();
        this.pool.delete(channelId);
      } else {
        entry.lastUsed = Date.now();
        return entry.runner;
      }
    }

    // 上限チェック → LRU eviction
    if (this.pool.size >= this.maxProcesses) {
      this.evictLRU();
    }

    // 新しい PersistentRunner を作成（チャンネル固有設定をマージ）
    const runner = new PersistentRunner({
      ...this.agentConfig,
      model,
      effort,
      channelId,
    });

    // セッション無効化イベント: sessions.json からも削除して永続的にリセット
    runner.on('session-invalidated', (ch: string, oldSessionId: string) => {
      if (ch) {
        deleteSession(ch);
        console.log(
          `[runner-manager] Session invalidated for channel ${ch} (was: ${oldSessionId?.slice(0, 8) ?? 'none'}). Deleted from sessions.json.`
        );
      }
    });

    this.pool.set(channelId, {
      runner,
      lastUsed: Date.now(),
      model,
      effort,
    });

    console.log(
      `[runner-manager] Created runner for channel ${channelId} ` +
        `(model: ${model || 'default'}, effort: ${effort || 'none'}, pool: ${this.pool.size}/${this.maxProcesses})`
    );

    return runner;
  }

  /**
   * Update channel model config and shutdown existing runner
   * The runner will be recreated with the new config on next request.
   */
  updateChannelConfig(channelId: string, config: ChannelModelConfig): void {
    setChannelModelConfig(channelId, config);

    // Shutdown existing runner so it gets recreated with new config
    const entry = this.pool.get(channelId);
    if (entry) {
      console.log(`[runner-manager] Shutting down runner for channel ${channelId} (config update)`);
      entry.runner.shutdown();
      this.pool.delete(channelId);
    }
  }

  /**
   * Reset channel model config to default
   */
  resetChannelConfig(channelId: string): boolean {
    const deleted = deleteChannelModelConfig(channelId);

    // Shutdown existing runner so it gets recreated with default config
    const entry = this.pool.get(channelId);
    if (entry) {
      console.log(`[runner-manager] Shutting down runner for channel ${channelId} (config reset)`);
      entry.runner.shutdown();
      this.pool.delete(channelId);
    }

    return deleted;
  }

  /**
   * 最も古い（LRU）ランナーを evict する
   */
  private evictLRU(): void {
    let oldestChannel: string | null = null;
    let oldestTime = Infinity;

    for (const [channelId, entry] of this.pool.entries()) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestChannel = channelId;
      }
    }

    if (oldestChannel) {
      const entry = this.pool.get(oldestChannel)!;
      console.log(
        `[runner-manager] Evicting LRU runner for channel ${oldestChannel} (idle ${Math.round((Date.now() - entry.lastUsed) / 1000)}s)`
      );
      entry.runner.shutdown();
      this.pool.delete(oldestChannel);
    }
  }

  /**
   * アイドル状態のランナーをクリーンアップ
   */
  private cleanupIdle(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [channelId, entry] of this.pool.entries()) {
      // Skip runners that are currently processing a request
      if (entry.runner.getQueueLength() > 0 || entry.runner.isBusy()) {
        continue;
      }
      if (now - entry.lastUsed > this.idleTimeoutMs) {
        toRemove.push(channelId);
      }
    }

    for (const channelId of toRemove) {
      const entry = this.pool.get(channelId)!;
      console.log(
        `[runner-manager] Cleaning up idle runner for channel ${channelId} (idle ${Math.round((now - entry.lastUsed) / 1000)}s)`
      );
      entry.runner.shutdown();
      this.pool.delete(channelId);
    }

    if (toRemove.length > 0) {
      console.log(
        `[runner-manager] Cleaned up ${toRemove.length} idle runner(s) (pool: ${this.pool.size}/${this.maxProcesses})`
      );
    }
  }

  /**
   * リクエストを実行
   */
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const channelId = options?.channelId ?? RunnerManager.DEFAULT_CHANNEL;
    const runner = this.getOrCreateRunner(channelId);
    // セッションIDが渡されていればランナーに設定（プロセス再起動時の復元用）
    if (options?.sessionId) {
      runner.setSessionId(options.sessionId);
    }
    return runner.run(prompt, options);
  }

  /**
   * ストリーミング実行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const channelId = options?.channelId ?? RunnerManager.DEFAULT_CHANNEL;
    const runner = this.getOrCreateRunner(channelId);
    // セッションIDが渡されていればランナーに設定（プロセス再起動時の復元用）
    if (options?.sessionId) {
      runner.setSessionId(options.sessionId);
    }
    return runner.runStream(prompt, callbacks, options);
  }

  /**
   * 指定チャンネルのリクエストをキャンセル
   * channelId なしの場合は全チャンネルを試す
   */
  cancel(channelId?: string): boolean {
    if (channelId) {
      const entry = this.pool.get(channelId);
      if (entry) {
        return entry.runner.cancel();
      }
      return false;
    }

    // channelId 未指定: 全ランナーを試す
    for (const entry of this.pool.values()) {
      if (entry.runner.cancel()) {
        return true;
      }
    }
    return false;
  }

  /**
   * 指定チャンネルのランナーを完全に破棄（/new用）
   */
  destroy(channelId: string): boolean {
    const entry = this.pool.get(channelId);
    if (entry) {
      entry.runner.shutdown();
      this.pool.delete(channelId);
      console.log(
        `[runner-manager] Destroyed runner for channel ${channelId} (pool: ${this.pool.size}/${this.maxProcesses})`
      );
      return true;
    }
    return false;
  }

  /**
   * 全ランナーをシャットダウン
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const [channelId, entry] of this.pool.entries()) {
      console.log(`[runner-manager] Shutting down runner for channel ${channelId}`);
      entry.runner.shutdown();
    }
    this.pool.clear();
    console.log('[runner-manager] All runners shut down');
  }

  /**
   * プール状態の取得（デバッグ・ステータス表示用）
   */
  getStatus(): {
    poolSize: number;
    maxProcesses: number;
    channels: Array<{ channelId: string; idleSeconds: number; alive: boolean }>;
  } {
    const now = Date.now();
    const channels = Array.from(this.pool.entries()).map(([channelId, entry]) => ({
      channelId,
      idleSeconds: Math.round((now - entry.lastUsed) / 1000),
      alive: entry.runner.isAlive(),
    }));

    return {
      poolSize: this.pool.size,
      maxProcesses: this.maxProcesses,
      channels,
    };
  }
}
