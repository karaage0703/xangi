import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentBackend, Config, EffortLevel } from './config.js';
import { getBackendDisplayName } from './agent-runner.js';

/**
 * チャンネルごとのオーバーライド設定
 */
export interface ChannelOverride {
  backend?: AgentBackend;
  model?: string;
  effort?: EffortLevel;
}

/**
 * チャンネルごとに解決されたバックエンド設定
 */
export interface ResolvedBackend {
  backend: AgentBackend;
  model?: string;
  effort?: EffortLevel;
}

/**
 * チャンネルごとのバックエンド・モデル・effortを解決する
 *
 * 優先順位:
 * 1. /model set で設定されたメモリ上のオーバーライド
 * 2. CHANNEL_OVERRIDES 環境変数（.env で永続化）
 * 3. .env のデフォルト（AGENT_BACKEND, AGENT_MODEL）
 *
 * channelOverrides はメモリ上で管理。
 * 初期値は CHANNEL_OVERRIDES 環境変数から読み込む。
 * Docker環境では .env に書けばコンテナ内にファイルが存在しないため、
 * AIから変更される心配がない。
 */
export class BackendResolver {
  private defaultBackend: AgentBackend;
  private defaultModel?: string;
  private allowedBackends?: AgentBackend[];
  private allowedModels?: string[];

  /** メモリ上のチャンネルオーバーライド */
  private channelOverrides: Map<string, ChannelOverride>;
  /** .envファイルのパス（永続化用） */
  private envFilePath?: string;

  constructor(config: Config) {
    this.defaultBackend = config.agent.backend;
    this.defaultModel = config.agent.config.model;
    this.allowedBackends = config.agent.allowedBackends;
    this.allowedModels = config.agent.allowedModels;

    // CHANNEL_OVERRIDES 環境変数から初期値を読み込み
    this.channelOverrides = new Map();
    const envOverrides = process.env.CHANNEL_OVERRIDES;
    if (envOverrides) {
      try {
        const parsed = JSON.parse(envOverrides) as Record<string, ChannelOverride>;
        for (const [channelId, override] of Object.entries(parsed)) {
          this.channelOverrides.set(channelId, override);
        }
        console.log(
          `[backend-resolver] Loaded ${this.channelOverrides.size} channel override(s) from CHANNEL_OVERRIDES`
        );
      } catch (e) {
        console.error('[backend-resolver] Failed to parse CHANNEL_OVERRIDES:', e);
      }
    }

    // .envファイルのパスを検出（永続化用）
    // xangiの起動ディレクトリに.envがあればそれを使う
    try {
      const candidatePath = join(process.cwd(), '.env');
      readFileSync(candidatePath, 'utf-8');
      this.envFilePath = candidatePath;
    } catch {
      // .envが見つからない場合は永続化しない（Docker環境等）
    }
  }

  /**
   * 指定チャンネルのバックエンド設定を解決
   */
  resolve(channelId?: string): ResolvedBackend {
    if (!channelId) {
      return {
        backend: this.defaultBackend,
        model: this.defaultModel,
      };
    }

    const override = this.channelOverrides.get(channelId);
    if (!override) {
      return {
        backend: this.defaultBackend,
        model: this.defaultModel,
      };
    }

    return {
      backend: override.backend ?? this.defaultBackend,
      model: override.model ?? (override.backend ? undefined : this.defaultModel),
      effort: override.effort,
    };
  }

  /**
   * チャンネルオーバーライドを設定し、.envに永続化
   */
  setChannelOverride(channelId: string, override: ChannelOverride): void {
    this.channelOverrides.set(channelId, override);
    this.persistToEnv();
    console.log(
      `[backend-resolver] Set override for ${channelId}: ${getBackendDisplayName(override.backend ?? this.defaultBackend)}` +
        (override.model ? ` (${override.model})` : '') +
        (override.effort ? ` effort=${override.effort}` : '')
    );
  }

  /**
   * チャンネルオーバーライドを削除し、.envに永続化
   */
  deleteChannelOverride(channelId: string): boolean {
    const had = this.channelOverrides.delete(channelId);
    if (had) {
      this.persistToEnv();
      console.log(`[backend-resolver] Deleted override for ${channelId}`);
    }
    return had;
  }

  /**
   * 現在のchannelOverridesを.envのCHANNEL_OVERRIDESに永続化
   */
  private persistToEnv(): void {
    if (!this.envFilePath) return;

    try {
      let envContent = readFileSync(this.envFilePath, 'utf-8');
      const overridesObj: Record<string, ChannelOverride> = {};
      for (const [k, v] of this.channelOverrides) {
        overridesObj[k] = v;
      }

      const newValue = Object.keys(overridesObj).length > 0 ? JSON.stringify(overridesObj) : '';
      const line = newValue ? `CHANNEL_OVERRIDES=${newValue}` : '';

      if (envContent.includes('CHANNEL_OVERRIDES=')) {
        // 既存行を置換
        envContent = envContent.replace(/^CHANNEL_OVERRIDES=.*$/m, line);
        // 空行になった場合は削除
        if (!line) {
          envContent = envContent.replace(/\n\n+/g, '\n\n');
        }
      } else if (line) {
        // 新規追加
        envContent = envContent.trimEnd() + '\n\n' + line + '\n';
      }

      writeFileSync(this.envFilePath, envContent, 'utf-8');
      console.log(`[backend-resolver] Persisted CHANNEL_OVERRIDES to .env`);
    } catch (e) {
      console.warn('[backend-resolver] Failed to persist to .env:', e);
    }
  }

  /**
   * チャンネルオーバーライドを取得
   */
  getChannelOverride(channelId: string): ChannelOverride | undefined {
    return this.channelOverrides.get(channelId);
  }

  /**
   * バックエンドが許可リストに含まれるか
   * ALLOWED_BACKENDS 未設定時は false（切り替え不可）
   */
  isBackendAllowed(backend: AgentBackend): boolean {
    if (!this.allowedBackends) return false;
    return this.allowedBackends.includes(backend);
  }

  /**
   * モデルが許可リストに含まれるか
   * ALLOWED_MODELS 未設定時は true（制限なし）
   */
  isModelAllowed(model: string): boolean {
    if (!this.allowedModels) return true;
    return this.allowedModels.includes(model);
  }

  /**
   * デフォルトバックエンドを取得
   */
  getDefault(): ResolvedBackend {
    return {
      backend: this.defaultBackend,
      model: this.defaultModel,
    };
  }

  /**
   * 許可されているバックエンド一覧
   * 未設定時はデフォルトバックエンドのみ
   */
  getAllowedBackends(): AgentBackend[] {
    return this.allowedBackends ?? [this.defaultBackend];
  }

  /**
   * 許可されているモデル一覧（undefined = 制限なし）
   */
  getAllowedModels(): string[] | undefined {
    return this.allowedModels;
  }

  /**
   * 現在のチャンネルオーバーライド一覧を取得（表示用）
   */
  getChannelOverrides(): Map<string, ChannelOverride> {
    return new Map(this.channelOverrides);
  }
}
