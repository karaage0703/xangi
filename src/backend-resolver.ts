import { readFileSync, writeFileSync } from 'fs';
import type { AgentBackend, Config, EffortLevel } from './config.js';
import { getBackendDisplayName } from './agent-runner.js';
import { resolveEnvFilePath } from './env-persist.js';
import { validateChannelOverrides } from './config-validate.js';

/**
 * Local LLM の動作モード
 * - agent: 全機能ON（tools/skills/xangi-commands、triggers OFF）
 * - lite: tools/xangi-commands/triggers ON、skills OFF（軽量、Discord 操作向け）
 * - chat: 全機能 OFF（純粋な会話）
 */
export type LocalLlmMode = 'agent' | 'lite' | 'chat';

/**
 * チャンネルごとのオーバーライド設定
 */
export interface ChannelOverride {
  backend?: AgentBackend;
  model?: string;
  effort?: EffortLevel;
  /** Local LLM のみ有効。バックエンドが local-llm の時に動作モードを切替 */
  localLlmMode?: LocalLlmMode;
}

/**
 * チャンネルごとに解決されたバックエンド設定
 */
export interface ResolvedBackend {
  backend: AgentBackend;
  model?: string;
  effort?: EffortLevel;
  /** Local LLM mode override（local-llm backend の時のみ意味あり） */
  localLlmMode?: LocalLlmMode;
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
  private allowedBackends: AgentBackend[];
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

    // CHANNEL_OVERRIDES 環境変数から初期値を読み込み（スキーマ検証付き。
    // 不正なエントリは警告して除外し、有効なエントリだけ読み込む）
    this.channelOverrides = new Map();
    const envOverrides = process.env.CHANNEL_OVERRIDES;
    if (envOverrides) {
      const { overrides, issues } = validateChannelOverrides(envOverrides);
      for (const issue of issues) {
        console.error(`[backend-resolver] CHANNEL_OVERRIDES ${issue.channelId}: ${issue.message}`);
      }
      if (overrides) {
        for (const [channelId, override] of Object.entries(overrides)) {
          this.channelOverrides.set(channelId, override as ChannelOverride);
        }
        console.log(
          `[backend-resolver] Loaded ${this.channelOverrides.size} channel override(s) from CHANNEL_OVERRIDES`
        );
      }
    }

    // .env ファイルのパスを検出 (永続化用)。XANGI_ENV_PATH 環境変数があればそれを優先、
    // 無ければ process.cwd() の .env をデフォルトに使う。
    // 読み取れない場合は永続化しない (Docker 環境で .env ファイルが mount されていない等)。
    try {
      const candidatePath = resolveEnvFilePath();
      readFileSync(candidatePath, 'utf-8');
      this.envFilePath = candidatePath;
    } catch {
      // 永続化スキップ
    }
  }

  /**
   * 指定チャンネルのバックエンド設定を解決
   */
  resolve(channelId?: string, requestDefault?: ChannelOverride): ResolvedBackend {
    const defaultBackend = requestDefault?.backend ?? this.defaultBackend;
    const defaultModel = requestDefault?.model ?? this.defaultModel;
    const defaultLocalLlmMode = requestDefault?.localLlmMode;

    if (!channelId) {
      return {
        backend: defaultBackend,
        model: defaultModel,
        localLlmMode: defaultLocalLlmMode,
      };
    }

    const override = this.channelOverrides.get(channelId);
    if (!override) {
      return {
        backend: defaultBackend,
        model: defaultModel,
        localLlmMode: defaultLocalLlmMode,
      };
    }

    const resolvedBackend = override.backend ?? defaultBackend;
    return {
      backend: resolvedBackend,
      model: override.model ?? (override.backend ? undefined : defaultModel),
      effort: override.effort,
      localLlmMode: override.localLlmMode ?? defaultLocalLlmMode,
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
        (override.effort ? ` effort=${override.effort}` : '') +
        (override.localLlmMode ? ` mode=${override.localLlmMode}` : '')
    );
  }

  /**
   * チャンネルの localLlmMode のみを更新（既存の backend/model/effort は保持）
   */
  setChannelLocalLlmMode(channelId: string, mode: LocalLlmMode | null): void {
    const existing = this.channelOverrides.get(channelId) ?? {};
    if (mode === null) {
      delete existing.localLlmMode;
    } else {
      existing.localLlmMode = mode;
    }
    // 全フィールドが空ならエントリ削除、そうでなければ更新
    if (!existing.backend && !existing.model && !existing.effort && !existing.localLlmMode) {
      this.channelOverrides.delete(channelId);
    } else {
      this.channelOverrides.set(channelId, existing);
    }
    this.persistToEnv();
    console.log(`[backend-resolver] Set localLlmMode for ${channelId}: ${mode ?? '(cleared)'}`);
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
   * ALLOWED_BACKENDS 未設定時は config 側で全 backend 許可になる
   */
  isBackendAllowed(backend: AgentBackend): boolean {
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
   */
  getAllowedBackends(): AgentBackend[] {
    return this.allowedBackends;
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
