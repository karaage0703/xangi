import { useEffect, useState, type FormEvent } from 'react';
import { getJson, requestJson } from './api';

export interface ChannelBackendSnapshot {
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
}: {
  platform: string;
  channelId: string;
  snapshot: ChannelBackendSnapshot;
  backends: string[];
  enabled: boolean;
}) {
  const [current, setCurrent] = useState(snapshot);
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
      await requestJson('/api/runtime-settings', {
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
      setCurrent(result);
      setNotice('保存しました。次のturnから適用されます。');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <fieldset disabled={!enabled || saving} style={{ border: 0, padding: 0, margin: 0 }}>
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
        <p role="status">{notice}</p>
      </fieldset>
    </form>
  );
}
