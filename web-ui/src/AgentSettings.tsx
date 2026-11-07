import {
  CatalogCreateButton,
  CatalogRow,
  CatalogFormActions,
  useCatalogFormFocus,
} from './CatalogControls';
import { useEffect, useState, type FormEvent } from 'react';
import { requestJson } from './api';
import { jsonInit } from './chatPresentation';
import { ConfirmDialog } from './ConfirmDialog';
import { CatalogFilter } from './CatalogFilter';

interface Agent {
  workChannel?: { platform: string; channelId: string } | null;
  role?: string;
  id: string;
  name: string;
  prompt: string;
  backend?: string;
  model?: string;
  effort?: string;
  workspaceId?: string;
  localLlmMode?: string;
  localLlmReasoningEffort?: string;
}

interface RegisteredWorkspace {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
}

interface ModelDiscoveryResponse {
  status: 'available' | 'unsupported' | 'unavailable';
  models: Array<{
    id: string;
    displayName?: string;
    isDefault?: boolean;
    supportedEfforts?: string[];
    defaultEffort?: string;
    reasoningMandatory?: boolean;
    reasoningDefaultEnabled?: boolean;
  }>;
  message?: string;
  supportedEfforts: string[];
}

export function AgentSettings({
  workspaces,
  defaultAI,
  onDefaultAISaved,
}: {
  workspaces: RegisteredWorkspace[];
  defaultAI?: {
    enabled: boolean;
    value: { backend: string; model?: string; effort?: string };
    options: string[];
  };
  onDefaultAISaved?: () => Promise<void>;
}) {
  const formRef = useCatalogFormFocus();
  const [channels, setChannels] = useState<
    Array<{ platform: string; id: string; name: string; group?: string }>
  >([]);
  const [channelNotice, setChannelNotice] = useState('');
  const [channelTarget, setChannelTarget] = useState('');
  const [savingChannel, setSavingChannel] = useState(false);
  const channelLabel = (binding: Agent['workChannel']) => {
    if (!binding) return '未設定';
    const channel = channels.find(
      (c) => c.platform === binding.platform && c.id === binding.channelId
    );
    return `${binding.platform === 'discord' ? 'Discord' : 'Slack'} / ${channel ? [channel.group, '#' + channel.name.replace(/^#/, '')].filter(Boolean).join(' / ') : binding.channelId}`;
  };
  const [agents, setAgents] = useState<Agent[]>([]);
  const [config, setConfig] = useState<{ allowedBackends: string[] }>({ allowedBackends: [] });
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [agentToDelete, setAgentToDelete] = useState<string>();
  const [deletingAgent, setDeletingAgent] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const catalogVisible = (agent: Agent) =>
    `${agent.name} ${agent.role || ''}`
      .toLocaleLowerCase()
      .includes(catalogQuery.trim().toLocaleLowerCase());
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string>();
  const [agentName, setAgentName] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentBackend, setAgentBackend] = useState('');
  const [agentModel, setAgentModel] = useState('');
  const [agentEffort, setAgentEffort] = useState('');
  const [agentWorkspaceId, setAgentWorkspaceId] = useState('default');
  const [agentLlmMode, setAgentLlmMode] = useState('');
  const [agentReasoning, setAgentReasoning] = useState('');
  const [agentModelOptions, setAgentModelOptions] = useState<ModelDiscoveryResponse['models']>([]);
  const [agentEffortOptions, setAgentEffortOptions] = useState<string[]>([]);
  const [agentModelStatus, setAgentModelStatus] = useState('');
  const [loadingAgentModels, setLoadingAgentModels] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);

  useEffect(() => {
    for (const platform of ['discord', 'slack']) {
      void requestJson<{
        channels: Array<{ id: string; name: string; group?: string }>;
        message?: string;
      }>(`/api/runtime-settings/channels?platform=${platform}`)
        .then((r) => {
          setChannels((previous) => [
            ...previous.filter((c) => c.platform !== platform),
            ...r.channels.map((c) => ({ ...c, platform })),
          ]);
          if (r.message) setChannelNotice(r.message);
        })
        .catch((e) => setChannelNotice(String(e)));
    }
    void Promise.all([
      requestJson<{ agents: Agent[] }>('/api/agents').then((result) => setAgents(result.agents)),
      requestJson<{ allowedBackends: string[] }>('/api/config').then(setConfig),
    ])
      .catch((cause) => setNotice(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!agentFormOpen || !agentBackend) {
      setAgentModelOptions([]);
      setAgentEffortOptions([]);
      setAgentModelStatus('');
      setLoadingAgentModels(false);
      return;
    }
    let cancelled = false;
    setLoadingAgentModels(true);
    setAgentModelOptions([]);
    setAgentModelStatus('');
    requestJson<ModelDiscoveryResponse>(`/api/models?backend=${encodeURIComponent(agentBackend)}`)
      .then((result) => {
        if (cancelled) return;
        setAgentModelOptions(result.models);
        setAgentEffortOptions(result.supportedEfforts);
        setAgentModelStatus(
          result.status === 'available'
            ? `${result.models.length}件のモデルを取得しました`
            : result.message || 'モデル一覧を取得できません'
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setAgentModelOptions([]);
        setAgentEffortOptions([]);
        setAgentModelStatus(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingAgentModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentBackend, agentFormOpen]);
  function openNewAgentForm() {
    setNotice('');
    setEditingAgentId(undefined);
    setAgentName('');
    setAgentPrompt('');
    setAgentBackend('');
    setAgentModel('');
    setAgentEffort('');
    setAgentWorkspaceId('default');
    setAgentLlmMode('');
    setAgentReasoning('');
    setAgentFormOpen(true);
  }

  function openAgentEditor(agent: Agent) {
    if (!agent) return;
    setNotice('');
    setEditingAgentId(agent.id);
    setChannelTarget('');
    setAgentName(agent.name);
    setAgentPrompt(agent.prompt);
    const ai = agent.id === 'xangi:default' ? defaultAI?.value : agent;
    setAgentBackend(ai?.backend || '');
    setAgentModel(ai?.model || '');
    setAgentEffort(ai?.effort || '');
    setAgentWorkspaceId(agent.workspaceId || 'default');
    setAgentLlmMode(agent.localLlmMode || '');
    setAgentReasoning(agent.localLlmReasoningEffort || '');
    setAgentFormOpen(true);
  }

  async function changeWorkChannel(action: 'set' | 'reset') {
    if (!editingAgentId || savingChannel) return;
    setSavingChannel(true);
    setChannelNotice('');
    try {
      const target = channels.find((c) => `${c.platform}:${c.id}` === channelTarget);
      const result = await requestJson<{ workChannel: Agent['workChannel'] }>(
        `/api/agents/${encodeURIComponent(editingAgentId)}/channel`,
        jsonInit('PUT', { action, platform: target?.platform, channelId: target?.id })
      );
      setAgents((previous) =>
        previous.map((a) =>
          a.id === editingAgentId ? { ...a, workChannel: result.workChannel } : a
        )
      );
      setChannelTarget('');
      setChannelNotice(
        action === 'reset' ? 'チャンネルの紐づきを解除しました。' : 'チャンネルを設定しました。'
      );
    } catch (error) {
      setChannelNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingChannel(false);
    }
  }
  const editingDefault = editingAgentId === 'xangi:default';
  const currentBinding = agents.find((a) => a.id === editingAgentId)?.workChannel;
  const openRouterModel =
    agentBackend === 'openrouter'
      ? agentModelOptions.find((model) => model.id === agentModel)
      : undefined;
  const reasoningOptions =
    agentBackend === 'openrouter'
      ? (openRouterModel?.supportedEfforts ?? [])
      : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const invalidOpenRouterEffort =
    agentBackend === 'openrouter' &&
    Boolean(agentReasoning) &&
    !reasoningOptions.includes(agentReasoning);

  async function saveAgent(event: FormEvent) {
    event.preventDefault();
    if (
      !agentName.trim() ||
      savingAgent ||
      invalidOpenRouterEffort ||
      (editingDefault && (!defaultAI?.enabled || !agentBackend))
    )
      return;
    setSavingAgent(true);
    try {
      const body = {
        name: agentName.trim(),
        prompt: agentPrompt.trim(),
        backend: agentBackend || null,
        model: agentBackend && agentModel ? agentModel : null,
        effort: agentBackend && agentEffort ? agentEffort : null,
        workspaceId: agentWorkspaceId,
        localLlmMode: ['local-llm', 'openrouter'].includes(agentBackend)
          ? agentLlmMode || null
          : null,
        localLlmReasoningEffort: ['local-llm', 'openrouter'].includes(agentBackend)
          ? agentReasoning || null
          : null,
      };
      const base = '/api/agents';
      const endpoint = editingAgentId ? `${base}/${encodeURIComponent(editingAgentId)}` : base;
      await requestJson(
        endpoint,
        jsonInit(
          editingAgentId ? 'PATCH' : 'POST',
          editingDefault ? { name: body.name, workspaceId: body.workspaceId } : body
        )
      );
      if (editingDefault) {
        try {
          await requestJson(
            '/api/runtime-settings',
            jsonInit('POST', {
              name: 'backend',
              action: 'set',
              backend: agentBackend,
              ...(agentModel && { model: agentModel }),
              ...(agentEffort && { effort: agentEffort }),
            })
          );
          await onDefaultAISaved?.();
        } catch (cause) {
          throw new Error(
            '名前と作業場所は保存済みですが、AI設定を保存できませんでした。入力を確認して再度保存してください。 ' +
              String(cause)
          );
        }
      }
      setAgents((await requestJson<{ agents: Agent[] }>('/api/agents')).agents);
      setAgentFormOpen(false);
      setEditingAgentId(undefined);
      setAgentName('');
      setAgentPrompt('');
      setAgentBackend('');
      setAgentModel('');
      setAgentEffort('');
      setAgentWorkspaceId('default');
      setAgentLlmMode('');
      setAgentReasoning('');
      setNotice('');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingAgent(false);
    }
  }

  return (
    <section
      id="agents"
      className="settings-card"
      aria-labelledby="settings-agents-title"
      tabIndex={-1}
    >
      <div className="settings-card-heading">
        <div>
          <h2 id="settings-agents-title">エージェント</h2>
          <p>担当ごとの指示、作業場所、使用するAIを設定します。</p>
        </div>
        {!agentFormOpen && (
          <CatalogCreateButton label="エージェント" onClick={openNewAgentForm} disabled={loading} />
        )}
      </div>
      {notice && (
        <p className="settings-status error" role="alert">
          {notice}
        </p>
      )}
      {loading && <p role="status">エージェントを読み込んでいます…</p>}
      <CatalogFilter
        editing={agentFormOpen}
        agentMode={true}
        query={catalogQuery}
        onChange={setCatalogQuery}
      />
      {agentFormOpen ? (
        <>
          <form
            ref={formRef}
            tabIndex={-1}
            className="project-form"
            onSubmit={(event) => void saveAgent(event)}
          >
            <h3>{editingAgentId ? 'エージェントを編集' : '新しいエージェント'}</h3>
            {editingAgentId && (
              <fieldset disabled={savingChannel || savingAgent}>
                <legend>作業チャンネル</legend>
                <p>現在の設定先: {channelLabel(currentBinding)}</p>
                {currentBinding ? (
                  <>
                    <p>別のチャンネルに変更する場合は、先に解除してください。</p>
                    <button type="button" onClick={() => void changeWorkChannel('reset')}>
                      チャンネルの紐づきを解除
                    </button>
                  </>
                ) : (
                  <>
                    <label htmlFor="agent-work-channel">
                      <span>設定先チャンネル</span>
                      <select
                        id="agent-work-channel"
                        aria-label="設定先チャンネル"
                        value={channelTarget}
                        onChange={(e) => setChannelTarget(e.target.value)}
                      >
                        <option value="">チャンネルを選択</option>
                        {channels.map((c) => (
                          <option
                            key={`${c.platform}:${c.id}`}
                            value={`${c.platform}:${c.id}`}
                            disabled={agents.some(
                              (a) =>
                                a.id !== editingAgentId &&
                                a.workChannel?.platform === c.platform &&
                                a.workChannel.channelId === c.id
                            )}
                          >
                            {channelLabel({ platform: c.platform, channelId: c.id })}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={!channelTarget}
                      onClick={() => void changeWorkChannel('set')}
                    >
                      チャンネルを設定
                    </button>
                  </>
                )}
                <p className="muted">チャンネルの操作はすぐに保存されます。設定先は最大1つです。</p>
                {channelNotice && <p role="status">{channelNotice}</p>}
              </fieldset>
            )}
            <>
              {editingDefault && (
                <p>既定の担当です。名前を変えても会話やチャンネルの紐付けは維持されます。</p>
              )}
              <label>
                <span>名前</span>
                <input
                  value={agentName}
                  onChange={(event) => setAgentName(event.target.value)}
                  maxLength={80}
                  required
                />
              </label>
              {!editingDefault && (
                <label>
                  <span>基本指示</span>
                  <textarea
                    value={agentPrompt}
                    onChange={(event) => setAgentPrompt(event.target.value)}
                    maxLength={20_000}
                    rows={5}
                    placeholder="この担当に守ってほしい指示"
                  />
                </label>
              )}
              <label>
                <span>ワークスペース</span>
                <select
                  aria-label="ワークスペース"
                  value={agentWorkspaceId}
                  onChange={(event) => setAgentWorkspaceId(event.target.value)}
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                      {workspace.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <small>
                作業場所は新しい会話から適用されます。既存の会話は現在の作業場所を保持します。
              </small>
              <fieldset className="project-model-settings">
                <legend>使用するAI</legend>
                <label>
                  <span>バックエンド</span>
                  <select
                    aria-label="バックエンド"
                    value={agentBackend}
                    onChange={(event) => {
                      setAgentBackend(event.target.value);
                      setAgentModel('');
                      setAgentEffort('');
                      setAgentLlmMode('');
                      setAgentReasoning('');
                    }}
                  >
                    {!editingDefault && <option value="">デフォルト担当の設定を使う</option>}
                    {(editingDefault ? defaultAI?.options || [] : config.allowedBackends).map(
                      (backend) => (
                        <option key={backend} value={backend}>
                          {backend === 'openrouter' ? 'OpenRouter' : backend}
                        </option>
                      )
                    )}
                  </select>
                </label>
                {agentBackend === 'openrouter' && (
                  <small role="note">
                    モデルごとに別のエージェントを作れます。学習利用禁止・ZDRは既定ONです。起動設定で個別に変更でき、選んだ条件に合う提供先がなければ停止します。接続設定にAPIキーを保存してください。OpenRouter側のデータ利用・ログ保存はアカウント設定で管理します。
                  </small>
                )}
                {!editingDefault && ['local-llm', 'openrouter'].includes(agentBackend) && (
                  <>
                    <label>
                      <span>動作モード</span>
                      <select
                        aria-label="動作モード"
                        value={agentLlmMode}
                        onChange={(e) => setAgentLlmMode(e.target.value)}
                      >
                        <option value="">xangiの既定設定</option>
                        <option value="agent">Agent（ツールを使って作業）</option>
                        <option value="chat">Chat（会話のみ）</option>
                      </select>
                    </label>
                    <label>
                      <span>
                        {agentBackend === 'openrouter'
                          ? 'OpenRouterの推論強度'
                          : 'Local LLMの推論強度'}
                      </span>
                      <select
                        aria-label={
                          agentBackend === 'openrouter'
                            ? 'OpenRouterの推論強度'
                            : 'Local LLMの推論強度'
                        }
                        disabled={agentBackend === 'openrouter' && loadingAgentModels}
                        value={agentReasoning}
                        onChange={(e) => setAgentReasoning(e.target.value)}
                      >
                        <option value="">xangiの既定設定</option>
                        {invalidOpenRouterEffort && (
                          <option value={agentReasoning} disabled>
                            {agentReasoning}（対応未確認・選び直してください）
                          </option>
                        )}
                        {reasoningOptions.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                      {agentBackend === 'openrouter' ? (
                        <small>
                          {openRouterModel
                            ? `モデル既定: ${openRouterModel.defaultEffort || '非公開'}${openRouterModel.reasoningDefaultEnabled === false ? '（推論OFF）' : ''}。${openRouterModel.reasoningMandatory ? '推論は必須です。' : ''}対応する値だけを表示します。`
                            : 'モデル情報を確認できるまで、推論強度は指定できません。'}{' '}
                          未指定時はxangiの共通設定、共通設定もなければモデル既定を使用します。
                          {invalidOpenRouterEffort &&
                            ' 現在の値を確認できません。既定設定または対応値を選び直してください。'}
                        </small>
                      ) : (
                        <small>モデルが対応している値を選んでください。</small>
                      )}
                    </label>
                  </>
                )}
                {agentBackend && (
                  <>
                    <label>
                      <span>モデル</span>
                      <select
                        aria-label="モデル"
                        value={agentModel}
                        disabled={loadingAgentModels}
                        onChange={(event) => {
                          setAgentModel(event.target.value);
                          const model = agentModelOptions.find(
                            (candidate) => candidate.id === event.target.value
                          );
                          if (
                            agentBackend === 'openrouter' &&
                            agentReasoning &&
                            !model?.supportedEfforts?.includes(agentReasoning)
                          ) {
                            setAgentReasoning('');
                          }
                          if (
                            agentEffort &&
                            model?.supportedEfforts?.length &&
                            !model.supportedEfforts.includes(agentEffort)
                          ) {
                            setAgentEffort('');
                            setAgentLlmMode('');
                            setAgentReasoning('');
                          }
                        }}
                      >
                        <option value="">バックエンドのデフォルト</option>
                        {agentModel &&
                          !agentModelOptions.some((model) => model.id === agentModel) && (
                            <option value={agentModel}>{agentModel}</option>
                          )}
                        {agentModelOptions.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName && model.displayName !== model.id
                              ? `${model.displayName} (${model.id})`
                              : model.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <details>
                      <summary>詳細設定</summary>
                      <label>
                        <span>effort</span>
                        <select
                          aria-label="effort"
                          value={agentEffort}
                          disabled={agentEffortOptions.length === 0}
                          onChange={(event) => setAgentEffort(event.target.value)}
                        >
                          <option value="">デフォルト</option>
                          {(
                            (agentModel
                              ? agentModelOptions.find((model) => model.id === agentModel)
                              : agentModelOptions.find((model) => model.isDefault)
                            )?.supportedEfforts?.filter((effort) =>
                              agentEffortOptions.includes(effort)
                            ) || agentEffortOptions
                          ).map((effort) => (
                            <option key={effort} value={effort}>
                              {effort}
                            </option>
                          ))}
                        </select>
                      </label>
                    </details>
                    {(loadingAgentModels || agentModelStatus) && (
                      <small className="project-model-status" role="status">
                        {loadingAgentModels ? 'モデルを取得中…' : agentModelStatus}
                      </small>
                    )}
                  </>
                )}
              </fieldset>
              <p>どの会話からも使える設定です。変更は次の作業から反映されます。</p>
            </>
            <CatalogFormActions
              creating={!editingAgentId}
              saving={savingAgent}
              disabled={
                (editingDefault && (!defaultAI?.enabled || !agentBackend)) ||
                invalidOpenRouterEffort ||
                (agentBackend === 'openrouter' && loadingAgentModels)
              }
              onCancel={() => setAgentFormOpen(false)}
            />
          </form>
        </>
      ) : (
        <nav className="project-view-list" aria-label="エージェント一覧">
          {agents.filter(catalogVisible).map((agent) => (
            <CatalogRow
              key={agent.id}
              name={agent.name}
              disabled={agent.id === 'xangi:default' && !defaultAI}
              onEdit={() => openAgentEditor(agent)}
              onDelete={
                agent.id === 'xangi:default'
                  ? undefined
                  : () => {
                      setDeleteError('');
                      setAgentToDelete(agent.id);
                    }
              }
            >
              {agent.id === 'xangi:default' && <small>既定</small>}
              <small>
                {[agent.role, agent.backend, agent.model].filter(Boolean).join(' · ') ||
                  'xangiの既定設定'}
              </small>
              <small>作業チャンネル: {channelLabel(agent.workChannel)}</small>
            </CatalogRow>
          ))}
          {!agents.length && <p>「＋ 作成」から基本指示と使用モデルを登録してください。</p>}
        </nav>
      )}
      <ConfirmDialog
        open={Boolean(agentToDelete)}
        title="エージェントを削除"
        description={`「${agents.find((agent) => agent.id === agentToDelete)?.name || ''}」を削除します。未完了・実行中の会話で使用するエージェントは削除できません。`}
        confirmLabel="削除"
        busyLabel="削除中…"
        busy={deletingAgent}
        error={deleteError}
        variant="danger"
        onCancel={() => {
          if (!deletingAgent) {
            setAgentToDelete(undefined);
            setDeleteError('');
          }
        }}
        onConfirm={() => {
          if (!agentToDelete || deletingAgent) return;
          setDeletingAgent(true);
          setDeleteError('');
          void requestJson(`/api/agents/${encodeURIComponent(agentToDelete)}`, { method: 'DELETE' })
            .then(() => {
              setAgents((previous) => previous.filter((agent) => agent.id !== agentToDelete));
              setAgentFormOpen(false);
              setNotice('');
              setAgentToDelete(undefined);
            })
            .catch((e) => setDeleteError(e instanceof Error ? e.message : String(e)))
            .finally(() => {
              setDeletingAgent(false);
            });
        }}
      />
    </section>
  );
}
