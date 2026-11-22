import { useEffect, useState, type FormEvent } from 'react';
import { getJson, requestJson } from './api';

export interface ChannelBackendSnapshot {
  workspace?: {
    enabled: boolean;
    value: string;
    effective?: { id: string; name: string; path: string };
  };
  team?: { id: string; name: string; leadership?: string } | null;
  agent?: { id: string; name: string; workspaceId: string; backendEditable?: boolean } | null;
  backend: {
    value: string;
    model?: string;
    effort?: string;
    localLlmReasoningEffort?: string;
    effective: {
      backend: string;
      model?: string;
      effort?: string;
      localLlmReasoningEffort?: string;
    };
  };
  llmMode: { value: string; effective: string };
}
interface Models {
  status: string;
  message?: string;
  models: Array<{ id: string; displayName?: string; supportedEfforts?: string[] }>;
  supportedEfforts: string[];
}

export function ChannelBackendSettings({
  platform,
  channelId,
  snapshot,
  backends,
  enabled,
  workspaces,
}: {
  platform: string;
  channelId: string;
  snapshot: ChannelBackendSnapshot;
  backends: string[];
  enabled: boolean;
  workspaces: Array<{ id: string; name: string; path: string }>;
}) {
  const [current, setCurrent] = useState(snapshot);
  const [workspaceId, setWorkspaceId] = useState(snapshot.workspace?.value ?? 'inherit');
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agentId, setAgentId] = useState(snapshot.agent?.id || '');
  useEffect(() => {
    requestJson<{ agents: typeof agents }>('/api/agents')
      .then((r) => setAgents(r.agents))
      .catch((e) => setNotice(String(e)));
  }, []);
  async function saveAgent() {
    setSaving(true);
    setNotice('');
    try {
      await requestJson('/api/runtime-settings', {
        method: 'POST',
        body: JSON.stringify({
          name: 'agent',
          action: agentId ? 'set' : 'reset',
          value: agentId,
          platform,
          channelId,
        }),
      });
      const next = await requestJson<ChannelBackendSnapshot>(
        `/api/runtime-settings/channel?platform=${encodeURIComponent(platform)}&channelId=${encodeURIComponent(channelId)}`
      );
      applySnapshot(next);
      setNotice('担当を保存しました。次の投稿から新しいセッションで開始します。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }
  const [backend, setBackend] = useState(snapshot.backend.value);
  const [model, setModel] = useState(snapshot.backend.model || '');
  const [effort, setEffort] = useState(snapshot.backend.effort || '');
  const [reasoning, setReasoning] = useState(snapshot.backend.localLlmReasoningEffort || '');
  const [mode, setMode] = useState(
    snapshot.llmMode.value === 'inherit' ? '' : snapshot.llmMode.value
  );
  const [models, setModels] = useState<Models>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  function applySnapshot(next: ChannelBackendSnapshot) {
    setCurrent(next);
    setWorkspaceId(next.workspace?.value ?? 'inherit');
    setBackend(next.backend.value);
    setModel(next.backend.model || '');
    setEffort(next.backend.effort || '');
    setReasoning(next.backend.localLlmReasoningEffort || '');
    setMode(next.llmMode.value === 'inherit' ? '' : next.llmMode.value);
  }
  const local = backend === 'openrouter' || backend === 'local-llm';
  const selected = models?.models.find((entry) => entry.id === model);
  const efforts =
    backend === 'openrouter'
      ? selected?.supportedEfforts || []
      : backend === 'local-llm'
        ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        : (models?.supportedEfforts || []).filter(
            (entry) => !selected?.supportedEfforts || selected.supportedEfforts.includes(entry)
          );
  const value = local ? reasoning : effort;
  const invalid = Boolean(value) && !efforts.includes(value);
  async function saveWorkspace() {
    setSaving(true);
    setNotice('');
    try {
      const result = await requestJson<{ message: string }>('/api/runtime-settings', {
        method: 'POST',
        body: JSON.stringify({
          name: 'workspace',
          action: workspaceId === 'inherit' ? 'reset' : 'set',
          value: workspaceId,
          platform,
          channelId,
        }),
      });
      const next = await getJson<ChannelBackendSnapshot>(
        `/api/runtime-settings/channel?platform=${encodeURIComponent(platform)}&channelId=${encodeURIComponent(channelId)}`
      );
      setCurrent(next);
      setWorkspaceId(next.workspace?.value ?? 'inherit');
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }
  useEffect(() => {
    let cancelled = false;
    setModels(undefined);
    if (backend === 'inherit') {
      setLoading(false);
      return;
    }
    setLoading(true);
    getJson<Models>(`/api/models?backend=${encodeURIComponent(backend)}`)
      .then((result) => {
        if (!cancelled) setModels(result);
      })
      .catch(() => {
        if (!cancelled)
          setModels({
            status: 'unavailable',
            models: [],
            supportedEfforts: [],
            message: 'モデル一覧を取得できません。再読み込みしてください。',
          });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [backend, reload]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice('');
    try {
      const saved = await requestJson<{ message: string }>('/api/runtime-settings', {
        method: 'POST',
        body: JSON.stringify({
          name: 'backend',
          scope: 'channel',
          platform,
          channelId,
          action: backend === 'inherit' ? 'reset' : 'set',
          ...(backend !== 'inherit'
            ? {
                backend,
                model,
                effort: local ? '' : effort,
                localLlmMode: local ? mode : '',
                localLlmReasoningEffort: local ? reasoning : '',
              }
            : {}),
        }),
      });
      const result = await getJson<ChannelBackendSnapshot>(
        `/api/runtime-settings/channel?platform=${platform}&channelId=${encodeURIComponent(channelId)}`
      );
      applySnapshot(result);
      setNotice(saved.message);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <div className="settings-runtime-grid">
        <label>
          <span>担当エージェント</span>
          <select
            aria-label="エージェント"
            value={agentId}
            disabled={!enabled || saving}
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="">指定なし（チャンネルの個別設定）</option>
            <optgroup label="エージェント">
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <div className="settings-channel-status">
          <button type="button" disabled={!enabled || saving} onClick={() => void saveAgent()}>
            {saving ? '保存中…' : '担当を保存'}
          </button>
        </div>
      </div>
      <p>
        Agentを設定できるチャンネルは最大1つです。依頼はこのチャンネルの専用スレッドで確認・追加指示できます。
      </p>
      {current.agent && (
        <p>
          担当: {current.agent.name}。
          {current.agent.backendEditable === false
            ? 'AI設定はエージェント設定で変更できます。'
            : 'ここで保存したAI設定と作業場所は担当Agentに反映されます。'}
        </p>
      )}
      {current.workspace && (
        <>
          <fieldset
            disabled={saving || !current.workspace.enabled}
            style={{ border: 0, padding: 0, margin: 0 }}
          >
            <div className="settings-runtime-grid">
              <label>
                <span>
                  ワークスペース{' '}
                  <span className="settings-apply-badge">
                    {current.agent ? '次のターンから' : '次の /new から'}
                  </span>
                </span>
                <select
                  aria-label="チャンネルのワークスペース"
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  {!current.agent && <option value="inherit">既定のワークスペースを継承</option>}
                  {workspaceId !== 'inherit' &&
                    !workspaces.some((entry) => entry.id === workspaceId) && (
                      <option value={workspaceId}>保存済み（一覧未取得）</option>
                    )}
                  {workspaces.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="settings-channel-status">
              <button type="button" onClick={() => void saveWorkspace()}>
                {saving ? '保存中…' : 'チャンネルのワークスペースを保存'}
              </button>
            </div>
          </fieldset>
          <p style={{ overflowWrap: 'anywhere' }}>
            現在の作業場所: {current.workspace.effective?.name || '取得できません'}
            {current.workspace.effective && (
              <>
                <br />
                {current.workspace.effective.path}
              </>
            )}
          </p>
        </>
      )}
      <fieldset
        disabled={!enabled || saving || current.agent?.backendEditable === false}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        <div className="settings-runtime-grid channel-backend-grid">
          <label>
            <span>
              バックエンド <span className="settings-apply-badge next-turn">次のturnから</span>
            </span>
            <select
              aria-label="バックエンド"
              value={backend}
              onChange={(event) => {
                setBackend(event.target.value);
                setModel('');
                setEffort('');
                setReasoning('');
                setMode('');
                setNotice('');
              }}
            >
              <option value="inherit">全体設定を継承</option>
              {backends.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          {backend !== 'inherit' && (
            <>
              <label>
                <span>モデル</span>
                <select
                  aria-label="モデル"
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    setEffort('');
                    setReasoning('');
                  }}
                  disabled={loading}
                >
                  <option value="">既定のモデル</option>
                  {model && !models?.models.some((entry) => entry.id === model) && (
                    <option value={model}>{model}（保存済み・一覧未確認）</option>
                  )}
                  {models?.models.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.displayName && entry.displayName !== entry.id
                        ? `${entry.displayName} (${entry.id})`
                        : entry.id}
                    </option>
                  ))}
                </select>
                <small>
                  {loading
                    ? '読み込み中…'
                    : models?.status === 'available'
                      ? `${models.models.length}件のモデルから選択できます`
                      : models?.message || 'モデル一覧を取得できません'}
                </small>
              </label>
              <label>
                <span>Effort（推論強度）</span>
                <select
                  aria-label="Effort（推論強度）"
                  value={value}
                  disabled={loading}
                  onChange={(event) =>
                    local ? setReasoning(event.target.value) : setEffort(event.target.value)
                  }
                >
                  <option value="">既定設定</option>
                  {invalid && (
                    <option value={value} disabled>
                      {value}（非対応または未確認）
                    </option>
                  )}
                  {efforts.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
                {invalid && (
                  <small role="alert">対応する値を選ぶか、既定設定に戻してください。</small>
                )}
              </label>
              {local && (
                <label>
                  <span>動作モード</span>
                  <select value={mode} onChange={(event) => setMode(event.target.value)}>
                    <option value="">起動時設定を継承</option>
                    <option value="agent">agent</option>
                    <option value="chat">chat</option>
                  </select>
                </label>
              )}
            </>
          )}
        </div>
        <p>
          現在: {current.backend.effective.backend} /{' '}
          {current.backend.effective.model || '既定のモデル'} / Effort:{' '}
          {current.backend.effective.localLlmReasoningEffort ||
            current.backend.effective.effort ||
            '既定設定'}
        </p>
        <div className="settings-channel-status">
          <button type="submit" disabled={loading || (backend !== 'inherit' && invalid)}>
            {saving ? '保存中…' : 'チャンネルのモデル設定を保存'}
          </button>
          {backend !== 'inherit' && (
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => setReload((value) => value + 1)}
            >
              モデル一覧を再読み込み
            </button>
          )}
        </div>
      </fieldset>
      <p role="status">{notice}</p>
    </form>
  );
}
