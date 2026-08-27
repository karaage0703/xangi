import { readFileSync, writeFileSync } from 'fs';
import type { AgentBackend, Config, EffortLevel, LocalLlmReasoningEffort } from './config.js';
import { getBackendDisplayName } from './agent-runner.js';
import { resolveEnvFilePath } from './env-persist.js';
import { validateChannelOverrides } from './config-validate.js';
import { requiresExplicitModelForEffort, supportsEffort } from './backend-effort.js';
import { resolveExtensionAgentBackend } from './extensions.js';
import { BUILTIN_AGENT_BACKENDS, getAllAgentBackends } from './config.js';

/**
 * Local LLM の動作モード
 * - agent: 全機能ON（tools/skills/xangi-commands）
 * - chat: 全機能 OFF（純粋な会話）
 */
export type LocalLlmMode = 'agent' | 'chat';

/**
 * チャンネルごとのオーバーライド設定
 */
export interface ChannelOverride {
  backend?: AgentBackend;
  model?: string;
  effort?: EffortLevel;
  /** Local LLM のみ有効。バックエンドが local-llm の時に動作モードを切替 */
  localLlmMode?: LocalLlmMode;
  /** Local LLM OpenAI互換APIへ送る reasoning_effort */
  localLlmReasoningEffort?: LocalLlmReasoningEffort;
}

/**
 * チャンネルごとに解決されたバックエンド設定
 */
export interface ResolvedBackend {
  backend: AgentBackend;
  model?: string;
  effort?: EffortLevel;
  /** Extension-backed agents currently execute independent requests without provider context. */
  sessionMode?: 'stateless';
  /** Local LLM mode override（local-llm backend の時のみ意味あり） */
  localLlmMode?: LocalLlmMode;
  /** Local LLM reasoning_effort override */
  localLlmReasoningEffort?: LocalLlmReasoningEffort;
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
  private allowAllAvailableBackends: boolean;
  private backendAvailable: (backend: AgentBackend) => boolean;

  /** メモリ上のチャンネルオーバーライド */
  private channelOverrides: Map<string, ChannelOverride>;
  /** .envファイルのパス（永続化用） */
  private envFilePath?: string;

  constructor(
    config: Config,
    options: { backendAvailable?: (backend: AgentBackend) => boolean } = {}
  ) {
    this.defaultBackend = config.agent.backend;
    this.defaultModel = config.agent.config.model;
    this.allowedBackends = config.agent.allowedBackends;
    this.allowAllAvailableBackends = !process.env.ALLOWED_BACKENDS?.trim();
    this.backendAvailable =
      options.backendAvailable ??
      ((backend) =>
        (BUILTIN_AGENT_BACKENDS as readonly string[]).includes(backend) ||
        Boolean(resolveExtensionAgentBackend(backend)));

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
          const typedOverride = override as ChannelOverride;
          const effectiveBackend = typedOverride.backend ?? this.defaultBackend;
          if (typedOverride.effort && !supportsEffort(effectiveBackend, typedOverride.effort)) {
            console.error(
              `[backend-resolver] CHANNEL_OVERRIDES ${channelId}: backend '${effectiveBackend}' は effort '${typedOverride.effort}' に対応していません。このエントリは無視します`
            );
            continue;
          }
          if (
            typedOverride.effort &&
            requiresExplicitModelForEffort(effectiveBackend) &&
            !typedOverride.model
          ) {
            console.error(
              `[backend-resolver] CHANNEL_OVERRIDES ${channelId}: backend '${effectiveBackend}' で effort を指定するには model の明示指定が必要です。このエントリは無視します`
            );
            continue;
          }
          this.channelOverrides.set(channelId, typedOverride);
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
    const defaultLocalLlmReasoningEffort = requestDefault?.localLlmReasoningEffort;

    if (!channelId) {
      return {
        backend: defaultBackend,
        model: defaultModel,
        ...(resolveExtensionAgentBackend(defaultBackend)
          ? { sessionMode: 'stateless' as const }
          : {}),
        localLlmMode: defaultLocalLlmMode,
        localLlmReasoningEffort: defaultLocalLlmReasoningEffort,
      };
    }

    const override = this.channelOverrides.get(channelId);
    if (!override) {
      return {
        backend: defaultBackend,
        model: defaultModel,
        ...(resolveExtensionAgentBackend(defaultBackend)
          ? { sessionMode: 'stateless' as const }
          : {}),
        localLlmMode: defaultLocalLlmMode,
        localLlmReasoningEffort: defaultLocalLlmReasoningEffort,
      };
    }

    const resolvedBackend = override.backend ?? defaultBackend;
    return {
      backend: resolvedBackend,
      model: override.model ?? (override.backend ? undefined : defaultModel),
      effort: override.effort,
      ...(resolveExtensionAgentBackend(resolvedBackend)
        ? { sessionMode: 'stateless' as const }
        : {}),
      localLlmMode: override.localLlmMode ?? defaultLocalLlmMode,
      localLlmReasoningEffort: override.localLlmReasoningEffort ?? defaultLocalLlmReasoningEffort,
    };
  }

  /**
   * チャンネルオーバーライドを設定し、.envに永続化
   */
  setChannelOverride(channelId: string, override: ChannelOverride): void {
    const effectiveBackend = override.backend ?? this.defaultBackend;
    if (override.effort && !supportsEffort(effectiveBackend, override.effort)) {
      throw new Error(`backend '${effectiveBackend}' does not support effort '${override.effort}'`);
    }
    if (override.effort && requiresExplicitModelForEffort(effectiveBackend) && !override.model) {
      throw new Error(`backend '${effectiveBackend}' requires an explicit model for effort`);
    }
    this.channelOverrides.set(channelId, override);
    this.persistToEnv();
    console.log(
      `[backend-resolver] Set override for ${channelId}: ${getBackendDisplayName(override.backend ?? this.defaultBackend)}` +
        (override.model ? ` (${override.model})` : '') +
        (override.effort ? ` effort=${override.effort}` : '') +
        (override.localLlmMode ? ` mode=${override.localLlmMode}` : '') +
        (override.localLlmReasoningEffort
          ? ` local-llm-effort=${override.localLlmReasoningEffort}`
          : '')
    );
  }

  /** チャンネル固有設定をすべて削除し、起動時デフォルトへ戻す。 */
  clearChannelOverride(channelId: string): void {
    this.channelOverrides.delete(channelId);
    this.persistToEnv();
    console.log(`[backend-resolver] Cleared override for ${channelId}`);
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
    if (
      !existing.backend &&
      !existing.model &&
      !existing.effort &&
      !existing.localLlmMode &&
      !existing.localLlmReasoningEffort
    ) {
      this.channelOverrides.delete(channelId);
    } else {
      this.channelOverrides.set(channelId, existing);
    }
    this.persistToEnv();
    console.log(`[backend-resolver] Set localLlmMode for ${channelId}: ${mode ?? '(cleared)'}`);
  }

  /** チャンネルの Local LLM reasoning_effort のみを更新する。 */
  setChannelLocalLlmReasoningEffort(
    channelId: string,
    effort: LocalLlmReasoningEffort | null
  ): void {
    const existing = this.channelOverrides.get(channelId) ?? {};
    if (effort === null) delete existing.localLlmReasoningEffort;
    else existing.localLlmReasoningEffort = effort;

    if (
      !existing.backend &&
      !existing.model &&
      !existing.effort &&
      !existing.localLlmMode &&
      !existing.localLlmReasoningEffort
    ) {
      this.channelOverrides.delete(channelId);
    } else {
      this.channelOverrides.set(channelId, existing);
    }
    this.persistToEnv();
    console.log(
      `[backend-resolver] Set Local LLM reasoning effort for ${channelId}: ${effort ?? '(cleared)'}`
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
   * ALLOWED_BACKENDS 未設定時は config 側で全 backend 許可になる
   */
  isBackendAllowed(backend: AgentBackend): boolean {
    return this.allowAllAvailableBackends
      ? getAllAgentBackends().includes(backend)
      : this.allowedBackends.includes(backend);
  }

  /** 設定上許可され、かつ現在利用可能なバックエンドか。 */
  isBackendSelectable(backend: AgentBackend): boolean {
    return this.isBackendAllowed(backend) && this.backendAvailable(backend);
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
    return this.allowAllAvailableBackends ? getAllAgentBackends() : this.allowedBackends;
  }

  /** UIやコマンドで新しく選択できるバックエンド一覧。 */
  getSelectableBackends(): AgentBackend[] {
    return this.getAllowedBackends().filter((backend) => this.backendAvailable(backend));
  }

  /**
   * 現在のチャンネルオーバーライド一覧を取得（表示用）
   */
  getChannelOverrides(): Map<string, ChannelOverride> {
    return new Map(this.channelOverrides);
  }
}
