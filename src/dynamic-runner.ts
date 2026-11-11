import { cancelTeamDelegation } from './team-delegation.js';
import { withPrivateDiagnostics } from './privacy-console.js';
import { setSecretTurnInput } from './transcript-logger.js';
import { isSecretSession } from './secret.js';
import { handleSecretCommand } from './secret-command.js';
import { readSessionMessages } from './transcript-logger.js';
import { runTeamTurn, cancelTeam, teamTimeoutState, extendTeamTimeout } from './team-runner.js';
import { sessionAgent, resolveAgentBackend } from './agent-selection.js';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { realpathSync } from 'fs';
import { resolve as resolvePath } from 'path';
import type {
  AgentRunner,
  RunOptions,
  RunResult,
  StreamCallbacks,
  TimeoutState,
  ExtendTimeoutResult,
} from './agent-runner.js';
import { createAgentRunner, getBackendDisplayName } from './agent-runner.js';
import type { AgentConfig, Config } from './config.js';
import { BackendResolver, type ResolvedBackend } from './backend-resolver.js';
import { RunnerManager } from './runner-manager.js';
import {
  addSessionProcessingTime,
  addSessionTokenUsage,
  deleteSession,
  getActiveSessionId,
  getSessionEntry,
  setProviderSessionId,
  setProviderSessionMode,
  recordSessionModelExecution,
} from './sessions.js';
import {
  normalizeModelId,
  observeExecutionEffort,
  observeExecutionModel,
  type ModelExecution,
} from './model-execution.js';
import { attachResponseModelExecution } from './transcript-logger.js';
import { readCodexTurnEvidence } from './codex-model-evidence.js';
import type { ChatPlatform } from './prompts/index.js';
import {
  appendUserPromptSubmitContext,
  createReloadingUserPromptSubmitHookRunner,
  type ReloadingUserPromptSubmitHookRunner,
} from './hooks.js';
import {
  loggerOptionsFromEnv,
  ToolTrajectoryLogger,
  ToolTrajectoryStreamRecorder,
} from './tool-trajectory/index.js';

const CLI_TRAJECTORY_BACKENDS = new Set([
  'claude-code',
  'codex',
  'cursor',
  'grok',
  'antigravity',
  'github-copilot',
  'opencode',
]);

/**
 * チャンネルごとにバックエンドを動的に切り替えるランナーマネージャー
 *
 * BackendResolver で解決したバックエンド設定に基づいて、
 * 適切な AgentRunner にリクエストをルーティングする。
 *
 * - claude-code (persistent): RunnerManager で管理（チャンネル別プロセス）
 * - claude-code (non-persistent): 共有 ClaudeCodeRunner
 * - codex / grok / local-llm: バックエンド種別ごとの共有インスタンス
 */
export class DynamicRunnerManager extends EventEmitter implements AgentRunner {
  private resolver: BackendResolver;
  private config: Config;
  private platform?: ChatPlatform;
  private readonly workdir: string;
  private readonly userPromptSubmitHooks: ReloadingUserPromptSubmitHookRunner | null;

  /** デフォルトのランナー（.env設定ベース） */
  private initializedDefaultRunner?: AgentRunner;
  private markDefaultRunnerReady!: () => void;
  private readonly defaultRunnerReady = new Promise<void>((resolve) => {
    this.markDefaultRunnerReady = resolve;
  });

  private get defaultRunner(): AgentRunner {
    if (!this.initializedDefaultRunner) throw new Error('Agent backends are still starting');
    return this.initializedDefaultRunner;
  }

  private set defaultRunner(runner: AgentRunner) {
    this.initializedDefaultRunner = runner;
    this.markDefaultRunnerReady();
  }

  /** チャンネル別に生成したランナー（デフォルトと異なるバックエンドの場合） */
  private channelRunners = new Map<string, { runner: AgentRunner; key: string }>();
  private activeRunnerUses = new Map<AgentRunner, number>();
  private retiredRunners = new Set<AgentRunner>();
  private activeChannelRunners = new Map<string, AgentRunner>();
  private workspaceHooks = new Map<string, ReloadingUserPromptSubmitHookRunner | null>();

  constructor(
    config: Config,
    resolver: BackendResolver,
    options: { deferDefaultRunner?: boolean } = {}
  ) {
    super();
    this.config = config;
    this.resolver = resolver;
    this.platform = config.agent.platform;
    this.workdir = config.agent.config.workdir || process.cwd();
    this.userPromptSubmitHooks = createReloadingUserPromptSubmitHookRunner(this.workdir);

    if (!options.deferDefaultRunner) this.initializeDefaultRunner();
  }

  /** Initialize after managed agent backends are available during host startup. */
  initializeDefaultRunner(): void {
    if (this.initializedDefaultRunner) return;
    this.defaultRunner = this.createRunnerFor(
      this.resolver.getDefault(),
      this.platform,
      this.workdir
    );
    this.attachTimeoutBubble(this.defaultRunner);
    console.log(
      `[dynamic-runner] Initialized with default backend: ${getBackendDisplayName(this.config.agent.backend)}`
    );
  }

  /**
   * 内部 runner が EventEmitter なら timeout-* を上位 (= web-chat の SSE) に bubble する。
   * 既に attach 済みかどうかは listener 名で判別不能なので、attach は 1 runner 1 回が前提。
   * (defaultRunner は constructor で、channelRunner は createRunnerFor 直後で attach する)
   */
  private attachTimeoutBubble(runner: AgentRunner): void {
    const emitter = runner as unknown as {
      on?: (e: string, l: (p: unknown) => void) => void;
    };
    if (typeof emitter.on !== 'function') return;
    for (const evt of ['timeout-started', 'timeout-extended', 'timeout-cleared'] as const) {
      emitter.on(evt, (payload: unknown) => this.emit(evt, payload));
    }
  }

  /**
   * チャンネルに対応するランナーを取得
   * resolvedBackendがデフォルトと同じならデフォルトランナーを返す
   */
  private getRunner(
    channelId: string | undefined,
    resolved: ResolvedBackend,
    platform?: ChatPlatform,
    workdir?: string,
    forceDedicated = false,
    secret = false
  ): AgentRunner {
    const runnerPlatform = platform ?? this.platform;
    const defaultWorkdir = canonicalizeWorkdir(this.config.agent.config.workdir ?? process.cwd());
    const requestedWorkdir = canonicalizeWorkdir(workdir ?? defaultWorkdir);
    if (!channelId) {
      if (requestedWorkdir !== defaultWorkdir) {
        throw new Error('A channelId is required when running in a non-default workspace');
      }
      return this.defaultRunner;
    }

    // デフォルトと同じなら共有ランナーを使用
    const resolverKey = this.makeKey(resolved);
    const defaultKey = this.makeKey(this.resolver.getDefault());
    const platformKey = runnerPlatform ?? 'all';
    const defaultPlatformKey = this.platform ?? 'all';

    if (
      resolverKey === defaultKey &&
      platformKey === defaultPlatformKey &&
      requestedWorkdir === defaultWorkdir &&
      !forceDedicated &&
      !secret
    ) {
      // チャンネル用の別ランナーがあれば破棄
      this.destroyChannelRunner(channelId);
      return this.defaultRunner;
    }

    // 既存のチャンネルランナーがあり、キーが一致すればそれを使う
    const existing = this.channelRunners.get(channelId);
    const channelRunnerKey = `${resolverKey}:${platformKey}:${requestedWorkdir}:${secret}`;
    if (existing && existing.key === channelRunnerKey) {
      return existing.runner;
    }

    // 既存のチャンネルランナーを破棄
    this.destroyChannelRunner(channelId);

    // 新しいランナーを作成
    const runner = this.createRunnerFor(resolved, runnerPlatform, requestedWorkdir, secret);
    this.attachTimeoutBubble(runner);
    this.channelRunners.set(channelId, {
      runner,
      key: channelRunnerKey,
    });

    console.log(
      `[dynamic-runner] Created channel runner for ${channelId}: ${getBackendDisplayName(resolved.backend)}` +
        (resolved.model ? ` (${resolved.model})` : '') +
        (resolved.effort ? ` effort=${resolved.effort}` : '') +
        ` platform=${platformKey} workdir=${requestedWorkdir}`
    );

    return runner;
  }

  /**
   * ResolvedBackendから適切なランナーを作成
   */
  private createRunnerFor(
    resolved: ResolvedBackend,
    platform?: ChatPlatform,
    workdir?: string,
    secret = false
  ): AgentRunner {
    const agentConfig: AgentConfig = {
      ...this.config.agent.config,
      model: resolved.model,
      ...(secret ? { persistent: false } : {}),
      workdir: workdir ?? this.config.agent.config.workdir,
    };

    // claude-code persistent モード: effort付きの専用RunnerManagerを作成
    if (resolved.backend === 'claude-code' && agentConfig.persistent) {
      return new RunnerManager(agentConfig, {
        maxProcesses: agentConfig.maxProcesses,
        idleTimeoutMs: agentConfig.idleTimeoutMs,
        platform,
        effort: resolved.effort,
      });
    }

    return createAgentRunner(resolved.backend, agentConfig, {
      platform,
    });
  }

  private makeKey(resolved: ResolvedBackend): string {
    return `${resolved.backend}:${resolved.model ?? 'default'}:${resolved.effort ?? 'default'}`;
  }

  private destroyChannelRunner(channelId: string): void {
    const existing = this.channelRunners.get(channelId);
    if (existing) {
      existing.runner.destroy?.(channelId);
      this.shutdownRunner(existing.runner);
      this.channelRunners.delete(channelId);
      console.log(`[dynamic-runner] Destroyed channel runner for ${channelId}`);
    }
  }

  private shutdownRunner(runner: AgentRunner): void {
    if ('shutdown' in runner && typeof (runner as RunnerManager).shutdown === 'function') {
      (runner as RunnerManager).shutdown();
    }
  }

  /**
   * リクエストを実行
   */
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    if (!this.initializedDefaultRunner) await this.defaultRunnerReady;
    const control = handleSecretCommand(options);
    if (control) {
      if (options?.channelId) this.destroy(options.channelId);
      return control;
    }
    const team =
      !options?.internalTask &&
      !isSecretSession(options?.appSessionId) &&
      sessionAgent(options?.appSessionId)?.team;
    if (team && (team.leadership !== 'caller' || team.assignments))
      return runTeamTurn(this, team, prompt, {}, options!, () =>
        this.applyUserPromptSubmitHooks(prompt, options)
      );
    const { startedAt, resolved, runner, runOptions, enrichedPrompt, execution } =
      await this.prepareExecution(prompt, options);
    this.retainRunner(runner);
    if (runOptions?.channelId) this.activeChannelRunners.set(runOptions.channelId, runner);
    if (runOptions?.runnerKey) this.activeChannelRunners.set(runOptions.runnerKey, runner);
    try {
      const result = await withPrivateDiagnostics(Boolean(runOptions?.secret), () =>
        runner.run(enrichedPrompt, runOptions)
      );
      this.recordResolvedBackend(runOptions, resolved, result);
      await this.finishModelExecution(runOptions, execution, result);
      return result;
    } catch (error) {
      if (execution.status === 'running') await this.finishModelExecution(runOptions, execution);
      throw runOptions?.secret ? privateRunError(error) : error;
    } finally {
      for (const key of [runOptions?.channelId, runOptions?.runnerKey]) {
        if (key && this.activeChannelRunners.get(key) === runner)
          this.activeChannelRunners.delete(key);
      }
      this.releaseRunner(runner);
      if (runOptions?.secret && runOptions.channelId)
        this.destroyChannelRunner(runOptions.runnerKey ?? runOptions.channelId);
      if (runOptions?.appSessionId) {
        addSessionProcessingTime(runOptions.appSessionId, Date.now() - startedAt);
      }
    }
  }

  /**
   * ストリーミング実行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    if (!this.initializedDefaultRunner) await this.defaultRunnerReady;
    options?.signal?.throwIfAborted();
    const control = handleSecretCommand(options);
    if (control) {
      if (options?.channelId) this.destroy(options.channelId);
      callbacks.onComplete?.(control);
      return control;
    }
    const team =
      !options?.internalTask &&
      !isSecretSession(options?.appSessionId) &&
      sessionAgent(options?.appSessionId)?.team;
    if (team && (team.leadership !== 'caller' || team.assignments))
      return runTeamTurn(this, team, prompt, callbacks, options!, () =>
        this.applyUserPromptSubmitHooks(prompt, options)
      );
    const { startedAt, resolved, runner, runOptions, enrichedPrompt, execution } =
      await this.prepareExecution(prompt, options);
    this.retainRunner(runner);
    if (runOptions?.channelId) this.activeChannelRunners.set(runOptions.channelId, runner);
    if (runOptions?.runnerKey) this.activeChannelRunners.set(runOptions.runnerKey, runner);
    const recorder =
      runOptions?.appSessionId && CLI_TRAJECTORY_BACKENDS.has(resolved.backend)
        ? new ToolTrajectoryStreamRecorder(
            new ToolTrajectoryLogger(loggerOptionsFromEnv(runOptions.workdir ?? this.workdir)),
            {
              appSessionId: runOptions.appSessionId,
              platform: runOptions.platform ?? this.platform,
              backend: resolved.backend,
              model: resolved.model,
              channelId: runOptions.channelId,
            }
          )
        : undefined;
    const observedCallbacks: StreamCallbacks = {
      ...callbacks,
      onUserInput: runOptions?.secret ? undefined : callbacks.onUserInput,
      onModel: (model) => {
        if (execution.status !== 'running') return;
        if (observeExecutionModel(execution, model))
          this.persistModelExecution(runOptions, execution);
        callbacks.onModel?.(model);
      },
      onModelSelection: (selection) => {
        if (execution.status !== 'running' || selection !== 'Auto') return;
        execution.modelSelection = selection;
        execution.updatedAt = new Date().toISOString();
        this.persistModelExecution(runOptions, execution);
        callbacks.onModelSelection?.(selection);
      },
      onEffort: (effort) => {
        if (execution.status !== 'running') return;
        if (observeExecutionEffort(execution, effort))
          this.persistModelExecution(runOptions, execution);
        callbacks.onEffort?.(effort);
      },
      onError: (error) => callbacks.onError?.(runOptions?.secret ? privateRunError(error) : error),
      // Complete consumers only after the result and model snapshot have been persisted.
      onComplete: undefined,
    };
    try {
      runOptions?.signal?.throwIfAborted();
      const result = await withPrivateDiagnostics(Boolean(runOptions?.secret), () =>
        runner.runStream(
          enrichedPrompt,
          recorder?.callbacks(observedCallbacks) ?? observedCallbacks,
          runOptions
        )
      );
      this.recordResolvedBackend(runOptions, resolved, result);
      await this.finishModelExecution(runOptions, execution, result);
      callbacks.onComplete?.(result);
      return result;
    } catch (error) {
      if (execution.status === 'running') await this.finishModelExecution(runOptions, execution);
      throw runOptions?.secret ? privateRunError(error) : error;
    } finally {
      for (const key of [runOptions?.channelId, runOptions?.runnerKey]) {
        if (key && this.activeChannelRunners.get(key) === runner)
          this.activeChannelRunners.delete(key);
      }
      this.releaseRunner(runner);
      if (runOptions?.secret && runOptions.channelId)
        this.destroyChannelRunner(runOptions.runnerKey ?? runOptions.channelId);
      if (runOptions?.appSessionId) {
        addSessionProcessingTime(runOptions.appSessionId, Date.now() - startedAt);
      }
    }
  }

  private async prepareExecution(prompt: string, options?: RunOptions) {
    const startedAt = Date.now();
    const secret = isSecretSession(options?.appSessionId);
    if (secret) {
      options = {
        ...options,
        channelId:
          options?.channelId ??
          getSessionEntry(options!.appSessionId!)?.contextKey ??
          options!.appSessionId,
        secret: true,
        sessionId: undefined,
        codexLineTransport: 'exec',
      };
      setSecretTurnInput(options.appSessionId!, options.userText ?? prompt);
    }
    const channelId = options?.channelId;
    const agent = options?.internalTask ? undefined : sessionAgent(options?.appSessionId);
    if (secret && agent?.team)
      throw new Error(
        'シークレットモードではチーム実行を利用できません。単体のAIを選んでください。'
      );
    const resolved =
      agent && !(agent.team?.leadership === 'caller' && agent.id.startsWith('team:'))
        ? resolveAgentBackend(this.resolver, agent)
        : this.resolver.resolve(
            options?.settingsChannelId ?? channelId,
            this.getRequestDefault(options)
          );
    const entry = options?.appSessionId ? getSessionEntry(options.appSessionId) : undefined;
    if (agent && entry?.platform !== 'web' && agent.prompt)
      prompt = `<agent-instructions>\n${agent.prompt}\n</agent-instructions>\n\n${prompt}`;
    const runner = this.getRunner(
      options?.runnerKey ?? channelId,
      resolved,
      options?.platform,
      options?.workdir,
      options?.runnerKey !== undefined && options.runnerKey !== channelId,
      secret
    );
    const runOptions = this.injectResolvedFields(
      this.dropMismatchedProviderSession(options, resolved),
      resolved
    );
    this.recordResolvedSessionMode(runOptions, resolved);
    let enrichedPrompt = runOptions?.internalTask
      ? prompt
      : await this.applyUserPromptSubmitHooks(prompt, runOptions);
    if (secret) {
      // Only plain previous messages are replayed, never a recursively expanded prompt.
      const previous = readSessionMessages(
        options?.workdir ?? this.workdir,
        options!.appSessionId!
      ).slice(-20);
      const history = previous.map((e) => ({
        role: e.role,
        content: String(typeof e.content === 'string' ? e.content : (e.content.result ?? '')).slice(
          -32_000
        ),
      }));
      while (JSON.stringify(history).length > 64_000 && history.length > 1) history.shift();
      enrichedPrompt = `<secret-history>\n${JSON.stringify(history)}\n</secret-history>\n\n${enrichedPrompt}`;
    }
    const configuredModel = normalizeModelId(resolved.model);
    const configuredEffort = runOptions?.effort ?? resolved.effort;
    const execution: ModelExecution = {
      turnId: randomUUID(),
      backend: resolved.backend,
      configuredModel,
      configuredEffort,
      effortSource: configuredEffort ? 'configuration' : undefined,
      observedModels: [],
      source: configuredModel ? 'configuration' : 'unknown',
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(startedAt).toISOString(),
      status: 'running',
      providerSessionId: runOptions?.sessionId,
    };
    this.persistModelExecution(runOptions, execution);
    return { startedAt, resolved, runner, runOptions, enrichedPrompt, execution };
  }

  private persistModelExecution(options: RunOptions | undefined, execution: ModelExecution): void {
    if (!options?.appSessionId || options.internalTask) return;
    if (!this.sessionWorkdirMatches(options, options.appSessionId)) return;
    recordSessionModelExecution(options.appSessionId, execution);
  }

  private async finishModelExecution(
    options: RunOptions | undefined,
    execution: ModelExecution,
    result?: RunResult
  ): Promise<void> {
    if (execution.backend === 'codex' && result?.sessionId && !options?.secret) {
      const evidence = await readCodexTurnEvidence({
        providerSessionId: result.sessionId,
        cwd: options?.workdir ?? this.workdir,
        startedAt: execution.startedAt,
        finishedAt: new Date().toISOString(),
      });
      for (const model of evidence.models) observeExecutionModel(execution, model);
      observeExecutionEffort(execution, evidence.effort);
    }
    if (result?.modelSelection === 'Auto') execution.modelSelection = 'Auto';
    const latestObserved = execution.effectiveModel;
    for (const model of result?.models ?? []) observeExecutionModel(execution, model);
    // A deduplicated result.models list cannot reconstruct A → B → A ordering.
    observeExecutionModel(execution, result?.model ?? latestObserved);
    observeExecutionEffort(execution, result?.effort);
    if (result && execution.effectiveModel) {
      result.model = execution.effectiveModel;
      result.models = [...execution.observedModels];
    }
    execution.status = result ? 'completed' : 'failed';
    execution.updatedAt = new Date().toISOString();
    if (result?.sessionId) execution.providerSessionId = result.sessionId;
    this.persistModelExecution(options, execution);
    if (
      options?.appSessionId &&
      !options.internalTask &&
      this.sessionWorkdirMatches(options, options.appSessionId)
    ) {
      attachResponseModelExecution(
        options.workdir ?? this.workdir,
        options.appSessionId,
        execution
      );
    }
  }

  private async applyUserPromptSubmitHooks(
    prompt: string,
    options: RunOptions | undefined
  ): Promise<string> {
    const rawUserText = options?.userText;
    if (!rawUserText) return prompt;
    const cwd = canonicalizeWorkdir(options.workdir ?? this.workdir);
    if (!this.workspaceHooks.has(cwd)) {
      this.workspaceHooks.set(
        cwd,
        cwd === canonicalizeWorkdir(this.workdir)
          ? this.userPromptSubmitHooks
          : createReloadingUserPromptSubmitHookRunner(cwd)
      );
    }
    const hooks = this.workspaceHooks.get(cwd);
    if (!hooks) return prompt;
    const contexts = await hooks.run({
      hook_event_name: 'UserPromptSubmit',
      session_id:
        options.appSessionId ||
        options.sessionId ||
        options.channelId ||
        options.settingsChannelId ||
        '',
      cwd,
      prompt: rawUserText,
      channel_id: options.channelId,
      platform: options.platform ?? this.platform,
    });
    return appendUserPromptSubmitContext(prompt, contexts);
  }

  private dropMismatchedProviderSession(
    options: RunOptions | undefined,
    resolved: ResolvedBackend
  ): RunOptions | undefined {
    if (!options?.sessionId || !options.channelId) return options;

    const appSessionId = options.appSessionId || getActiveSessionId(options.channelId);
    const entry = appSessionId ? getSessionEntry(appSessionId) : undefined;
    const storedBackend = entry?.agent?.backend;
    const defaultWorkdir = canonicalizeWorkdir(this.config.agent.config.workdir ?? process.cwd());
    const requestedWorkdir = canonicalizeWorkdir(options.workdir ?? defaultWorkdir);
    const storedWorkdir = entry
      ? canonicalizeWorkdir(entry.workspacePath ?? defaultWorkdir)
      : undefined;

    const storedModel = entry?.agent?.model;
    const storedEffort = entry?.agent?.effort;
    const backendConfigurationMatches =
      !storedBackend ||
      (storedBackend === resolved.backend &&
        storedModel === resolved.model &&
        storedEffort === resolved.effort);
    const matchesResolvedConfiguration =
      backendConfigurationMatches && (!storedWorkdir || storedWorkdir === requestedWorkdir);
    if (matchesResolvedConfiguration) return options;

    console.warn(
      `[dynamic-runner] Ignoring provider session for ${options.channelId}; ` +
        `stored=${storedBackend}:${storedModel ?? 'default'}:${storedEffort ?? 'default'}, ` +
        `resolved=${resolved.backend}:${resolved.model ?? 'default'}:${resolved.effort ?? 'default'}, ` +
        `storedWorkdir=${storedWorkdir ?? 'legacy'}, requestedWorkdir=${requestedWorkdir}`
    );
    return { ...options, sessionId: undefined };
  }

  private getRequestDefault(options: RunOptions | undefined) {
    if (
      !options?.defaultBackend &&
      !options?.defaultModel &&
      !options?.defaultEffort &&
      !options?.defaultLocalLlmMode &&
      !options?.defaultLocalLlmReasoningEffort
    ) {
      return undefined;
    }
    return {
      backend: options.defaultBackend,
      model: options.defaultModel,
      effort: options.defaultEffort,
      localLlmMode: options.defaultLocalLlmMode,
      localLlmReasoningEffort: options.defaultLocalLlmReasoningEffort,
    };
  }

  private recordResolvedBackend(
    options: RunOptions | undefined,
    resolved: ResolvedBackend,
    result: RunResult
  ): void {
    if (!options?.appSessionId || !result.sessionId || options.internalTask) return;
    if (!this.sessionWorkdirMatches(options, options.appSessionId)) {
      console.warn(
        `[dynamic-runner] Not storing provider session for ${options.appSessionId}; ` +
          'the requested workspace differs from its immutable session snapshot'
      );
      return;
    }
    setProviderSessionId(
      options.appSessionId,
      result.sessionId,
      resolved.backend,
      resolved.model,
      resolved.effort,
      result.sessionMode
    );
    if (result.usage) addSessionTokenUsage(options.appSessionId, result.usage);
  }

  private sessionWorkdirMatches(options: RunOptions, appSessionId: string): boolean {
    const entry = getSessionEntry(appSessionId);
    if (!entry) return true;
    const defaultWorkdir = canonicalizeWorkdir(this.config.agent.config.workdir ?? process.cwd());
    const requestedWorkdir = canonicalizeWorkdir(options.workdir ?? defaultWorkdir);
    const storedWorkdir = canonicalizeWorkdir(entry.workspacePath ?? defaultWorkdir);
    return storedWorkdir === requestedWorkdir;
  }

  private recordResolvedSessionMode(
    options: RunOptions | undefined,
    resolved: ResolvedBackend
  ): void {
    if (!options?.appSessionId || options.internalTask) return;
    if (!this.sessionWorkdirMatches(options, options.appSessionId)) return;
    setProviderSessionMode(
      options.appSessionId,
      resolved.backend,
      resolved.sessionMode ?? 'stateful'
    );
  }

  /**
   * resolved の effort / Local LLM設定を RunOptions にマージする
   * - 既存 options に明示的に指定があればそれを優先
   * - resolved.localLlmMode は Local LLM 以外のバックエンドでは無視されるが、害はない
   */
  private injectResolvedFields(
    options: RunOptions | undefined,
    resolved: ResolvedBackend
  ): RunOptions | undefined {
    const hasEffort = resolved.effort && (!options || options.effort === undefined);
    const hasMode = resolved.localLlmMode && (!options || options.localLlmMode === undefined);
    const hasLocalLlmReasoningEffort =
      resolved.localLlmReasoningEffort &&
      (!options || options.localLlmReasoningEffort === undefined);
    if (!hasEffort && !hasMode && !hasLocalLlmReasoningEffort) return options;
    return {
      ...options,
      ...(hasEffort && { effort: resolved.effort }),
      ...(hasMode && { localLlmMode: resolved.localLlmMode }),
      ...(hasLocalLlmReasoningEffort && {
        localLlmReasoningEffort: resolved.localLlmReasoningEffort,
      }),
    };
  }

  /**
   * キャンセル
   */
  cancel(channelId?: string): boolean {
    const delegated = channelId ? cancelTeamDelegation(channelId) : false;
    if (channelId && cancelTeam(channelId, this)) return true;
    if (channelId) {
      const active = this.activeChannelRunners.get(channelId);
      if (active) return (active.cancel?.(channelId) ?? false) || delegated;
      const channelEntry = this.channelRunners.get(channelId);
      if (channelEntry?.runner.cancel) {
        return channelEntry.runner.cancel(channelId) || delegated;
      }
    }
    return (this.initializedDefaultRunner?.cancel?.(channelId) ?? false) || delegated;
  }

  /**
   * 指定チャンネルのランナーを破棄
   */
  destroy(channelId: string): boolean {
    cancelTeamDelegation(channelId);
    if (cancelTeam(channelId, this)) return true;
    const activeDestroyed = this.activeChannelRunners.get(channelId)?.destroy?.(channelId) ?? false;
    // チャンネル専用ランナーがあれば破棄
    const hadChannelRunner = this.channelRunners.has(channelId);
    this.destroyChannelRunner(channelId);

    // デフォルトランナーにもdestroy（RunnerManagerのプール内エントリ削除）
    const defaultDestroyed = this.initializedDefaultRunner?.destroy?.(channelId) ?? false;

    return activeDestroyed || hadChannelRunner || defaultDestroyed;
  }

  /**
   * 指定チャンネルのランナーがプールに存在するか
   */
  hasRunner(channelId: string): boolean {
    if (teamTimeoutState(channelId, this)) return true;
    const active = this.activeChannelRunners.get(channelId);
    if (active) return active.hasRunner?.(channelId) ?? true;
    const channelEntry = this.channelRunners.get(channelId);
    if (channelEntry) {
      return channelEntry.runner.hasRunner?.(channelId) ?? false;
    }
    return this.initializedDefaultRunner?.hasRunner?.(channelId) ?? false;
  }

  /**
   * 指定チャンネルの現在のタイムアウト状態を取得（内部 runner にパススルー）
   */
  getTimeoutState(channelId: string): TimeoutState {
    const team = teamTimeoutState(channelId, this);
    if (team) return team;
    const active = this.activeChannelRunners.get(channelId);
    if (active) return active.getTimeoutState?.(channelId) ?? { active: false };
    const channelEntry = this.channelRunners.get(channelId);
    if (channelEntry?.runner.getTimeoutState) {
      return channelEntry.runner.getTimeoutState(channelId);
    }
    return this.initializedDefaultRunner?.getTimeoutState?.(channelId) ?? { active: false };
  }

  /**
   * 指定チャンネルのタイムアウトを延長（内部 runner にパススルー）。
   * `additionalMs` 省略時は残り時間を加算 (内部 runner 側で remainingMs を採用)。
   */
  extendTimeout(channelId: string, additionalMs?: number): ExtendTimeoutResult {
    const team = extendTeamTimeout(channelId, this, additionalMs);
    if (team) return team;
    const active = this.activeChannelRunners.get(channelId);
    if (active)
      return (
        active.extendTimeout?.(channelId, additionalMs) ?? { ok: false, reason: 'unsupported' }
      );
    const channelEntry = this.channelRunners.get(channelId);
    if (channelEntry?.runner.extendTimeout) {
      return channelEntry.runner.extendTimeout(channelId, additionalMs);
    }
    return (
      this.initializedDefaultRunner?.extendTimeout?.(channelId, additionalMs) ?? {
        ok: false,
        reason: 'unsupported',
      }
    );
  }

  /**
   * バックエンド切り替え
   * セッション削除とランナー破棄を行い、次回リクエスト時に新しいランナーが作成される
   */
  switchBackend(channelId: string): void {
    deleteSession(channelId);
    this.destroyChannelRunner(channelId);
    this.initializedDefaultRunner?.destroy?.(channelId);
    console.log(`[dynamic-runner] Backend switched for channel ${channelId}`);
  }

  /** Swap the default runner without interrupting turns already using the previous one. */
  switchDefaultBackend(): void {
    const resolved = this.resolver.getDefault();
    const previous = this.defaultRunner;
    const nextRunner = this.createRunnerFor(resolved, this.platform, this.workdir);
    this.attachTimeoutBubble(nextRunner);
    this.config.agent.backend = resolved.backend;
    this.config.agent.config.model = resolved.model;
    this.config.agent.effort = resolved.effort;
    this.defaultRunner = nextRunner;
    this.retireRunner(previous);
    console.log(
      `[dynamic-runner] Global default switched to ${getBackendDisplayName(resolved.backend)}` +
        (resolved.model ? ` (${resolved.model})` : '') +
        (resolved.effort ? ` effort=${resolved.effort}` : '')
    );
  }

  private retainRunner(runner: AgentRunner): void {
    this.activeRunnerUses.set(runner, (this.activeRunnerUses.get(runner) ?? 0) + 1);
  }

  private releaseRunner(runner: AgentRunner): void {
    const remaining = (this.activeRunnerUses.get(runner) ?? 1) - 1;
    if (remaining > 0) {
      this.activeRunnerUses.set(runner, remaining);
      return;
    }
    this.activeRunnerUses.delete(runner);
    if (this.retiredRunners.delete(runner)) this.shutdownRunner(runner);
  }

  private retireRunner(runner: AgentRunner): void {
    if ((this.activeRunnerUses.get(runner) ?? 0) > 0) this.retiredRunners.add(runner);
    else this.shutdownRunner(runner);
  }

  /**
   * チャンネルの現在のバックエンド設定を取得
   */
  resolveForChannel(channelId?: string): ResolvedBackend {
    return this.resolver.resolve(channelId);
  }

  /**
   * プール状態の取得（デバッグ・ステータス表示用）
   */
  getStatus(): {
    defaultBackend: string;
    channelRunners: Array<{ channelId: string; key: string }>;
    defaultRunnerStatus?: ReturnType<RunnerManager['getStatus']>;
  } {
    const channelInfo = Array.from(this.channelRunners.entries()).map(([channelId, entry]) => ({
      channelId,
      key: entry.key,
    }));

    return {
      defaultBackend: getBackendDisplayName(this.config.agent.backend),
      channelRunners: channelInfo,
      defaultRunnerStatus:
        this.initializedDefaultRunner && 'getStatus' in this.initializedDefaultRunner
          ? (this.defaultRunner as RunnerManager).getStatus()
          : undefined,
    };
  }

  /**
   * 全ランナーをシャットダウン
   */
  shutdown(): void {
    this.markDefaultRunnerReady();
    for (const [channelId, entry] of this.channelRunners.entries()) {
      entry.runner.destroy?.(channelId);
      this.shutdownRunner(entry.runner);
    }
    for (const runner of this.retiredRunners) this.shutdownRunner(runner);
    this.retiredRunners.clear();
    this.channelRunners.clear();
    if (this.initializedDefaultRunner) this.shutdownRunner(this.initializedDefaultRunner);
  }
}

function canonicalizeWorkdir(workdir: string): string {
  const absolute = resolvePath(workdir);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function privateRunError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel|abort/i.test(message)) return new Error('Secret request cancelled');
  if (/timeout|timed out/i.test(message)) return new Error('Secret request timed out');
  return new Error(
    'シークレット実行に失敗しました。詳細は保存しません。AIの設定・接続・CLIの対応バージョンを確認してください。'
  );
}
