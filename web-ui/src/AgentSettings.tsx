import { useEffect, useState, type FormEvent } from 'react';
import { requestJson } from './api';
import { jsonInit } from './chatPresentation';
import { ConfirmDialog } from './ConfirmDialog';
import { CatalogFilter } from './CatalogFilter';

interface Agent {
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
  }>;
  message?: string;
  supportedEfforts: string[];
}

export function AgentSettings({ workspaces }: { workspaces: RegisteredWorkspace[] }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [config, setConfig] = useState<{ allowedBackends: string[] }>({ allowedBackends: [] });
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [agentToDelete, setAgentToDelete] = useState<string>();
  const [deletingAgent, setDeletingAgent] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const catalogVisible = (agent: Agent) =>
    `${agent.name} ${agent.role || ''}`
      .toLocaleLowerCase()
      .includes(catalogQuery.trim().toLocaleLowerCase());
  const [agentRole, setAgentRole] = useState('');
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
    setAgentRole('');
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
    setAgentRole(agent.role || '');
    setAgentName(agent.name);
    setAgentPrompt(agent.prompt);
    setAgentBackend(agent.backend || '');
    setAgentModel(agent.model || '');
    setAgentEffort(agent.effort || '');
    setAgentWorkspaceId(agent.workspaceId || 'default');
    setAgentLlmMode(agent.localLlmMode || '');
    setAgentReasoning(agent.localLlmReasoningEffort || '');
    setAgentFormOpen(true);
  }

  async function saveAgent(event: FormEvent) {
    event.preventDefault();
    if (!agentName.trim() || savingAgent) return;
    setSavingAgent(true);
    try {
      const body = {
        name: agentName.trim(),
        prompt: agentPrompt.trim(),
        backend: agentBackend || null,
        model: agentBackend && agentModel ? agentModel : null,
        effort: agentBackend && agentEffort ? agentEffort : null,
        workspaceId: agentWorkspaceId,
        localLlmMode: agentBackend === 'local-llm' ? agentLlmMode || null : null,
        localLlmReasoningEffort: agentBackend === 'local-llm' ? agentReasoning || null : null,
        role: agentRole,
      };
      const base = '/api/agents';
      const endpoint = editingAgentId ? `${base}/${encodeURIComponent(editingAgentId)}` : base;
      await requestJson(endpoint, jsonInit(editingAgentId ? 'PATCH' : 'POST', body));
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
          <button
            type="button"
            className="project-view-new"
            onClick={openNewAgentForm}
            disabled={loading}
          >
            ＋ 新規エージェント
          </button>
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
        <form className="project-form" onSubmit={(event) => void saveAgent(event)}>
          <label>
            <span>名前</span>
            <input
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              maxLength={80}
              required
            />
          </label>
          <label>
            <span>個別指示</span>
            <textarea
              value={agentPrompt}
              onChange={(event) => setAgentPrompt(event.target.value)}
              maxLength={20_000}
              rows={5}
              placeholder="この担当に守ってほしい指示"
            />
          </label>
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
          <small>このエージェントは、会話でも委譲された作業でも、この場所で動きます。</small>
          <label>
            得意なことを一言
            <input value={agentRole} onChange={(e) => setAgentRole(e.target.value)} />
          </label>
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
                <option value="">xangiのデフォルト</option>
                {config.allowedBackends.map((backend) => (
                  <option key={backend} value={backend}>
                    {backend}
                  </option>
                ))}
              </select>
            </label>
            {agentBackend === 'local-llm' && (
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
                  <span>Local LLMの推論強度</span>
                  <select
                    aria-label="Local LLMの推論強度"
                    value={agentReasoning}
                    onChange={(e) => setAgentReasoning(e.target.value)}
                  >
                    <option value="">xangiの既定設定</option>
                    {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  <small>モデルが対応している値を選んでください。</small>
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
                    {agentModel && !agentModelOptions.some((model) => model.id === agentModel) && (
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
          <div className="project-form-actions">
            {editingAgentId && (
              <button
                type="button"
                className="danger"
                onClick={() => setAgentToDelete(editingAgentId)}
              >
                エージェントを削除
              </button>
            )}
            <button type="button" disabled={savingAgent} onClick={() => setAgentFormOpen(false)}>
              キャンセル
            </button>
            <button type="submit" className="primary" disabled={savingAgent}>
              {savingAgent ? '保存中…' : editingAgentId ? '更新' : '作成'}
            </button>
          </div>
        </form>
      ) : (
        <nav className="project-view-list" aria-label="エージェント一覧">
          {agents.filter(catalogVisible).map((agent) => (
            <div className="project-view-row agent-view-row" key={agent.id}>
              <button
                type="button"
                className="project-view-main"
                aria-label={`${agent.name}を編集`}
                onClick={() => openAgentEditor(agent)}
              >
                <span className="project-view-icon" aria-hidden="true">
                  ◇
                </span>
                <span className="project-view-copy">
                  <strong title={agent.name}>{agent.name}</strong>
                  <small>
                    {[agent.role, agent.backend, agent.model].filter(Boolean).join(' · ') ||
                      'xangiの既定設定'}
                  </small>
                </span>
              </button>
              <button
                type="button"
                className="project-view-edit agent-view-delete"
                aria-label={`${agent.name}を削除`}
                onClick={() => setAgentToDelete(agent.id)}
              >
                削除
              </button>
            </div>
          ))}
          {!agents.length && <p>新規エージェントから役割と使用モデルを登録してください。</p>}
        </nav>
      )}
      <ConfirmDialog
        open={Boolean(agentToDelete)}
        title="エージェントを削除"
        description={`「${agents.find((agent) => agent.id === agentToDelete)?.name || ''}」を削除します。未完了・実行中の会話で使用するエージェントは削除できません。`}
        confirmLabel="削除"
        busyLabel="削除中…"
        busy={deletingAgent}
        variant="danger"
        onCancel={() => {
          if (!deletingAgent) setAgentToDelete(undefined);
        }}
        onConfirm={() => {
          if (!agentToDelete || deletingAgent) return;
          setDeletingAgent(true);
          void requestJson(`/api/agents/${encodeURIComponent(agentToDelete)}`, { method: 'DELETE' })
            .then(async () => {
              setAgents((await requestJson<{ agents: Agent[] }>('/api/agents')).agents);
              setAgentFormOpen(false);
              setNotice('');
            })
            .catch((e) => setNotice(e.message))
            .finally(() => {
              setDeletingAgent(false);
              setAgentToDelete(undefined);
            });
        }}
      />
    </section>
  );
}
