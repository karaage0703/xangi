import { useEffect, useState, type FormEvent } from 'react';
import { AppTopbar } from './AppTopbar';
import { getJson, getJsonWithTimeout, requestJson } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { DirectoryPicker } from './DirectoryPicker';

type ApplyMode = 'immediate' | 'next-turn';

interface StartupSetting {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'integer' | 'number' | 'select' | 'text';
  value: string;
  options?: string[];
  min?: number;
  max?: number;
}

interface StartupGroup {
  id: string;
  label: string;
  settings: StartupSetting[];
}

interface ConnectionGroup {
  label: string;
  fields: Array<{
    key: string;
    label: string;
    configured: boolean;
    type: 'password' | 'text';
  }>;
}

interface BackendAuthenticationStatus {
  id: string;
  label: string;
  installed: boolean;
  version?: string;
  state: 'logged-in' | 'api-key' | 'not-authenticated' | 'unknown' | 'not-installed';
  apiKeyConfigured: boolean;
  updateSupported: boolean;
}

interface ConnectionSettingsResponse {
  groups: ConnectionGroup[];
  backends: BackendAuthenticationStatus[];
}

interface BackendUpdateResponse extends ConnectionSettingsResponse {
  message: string;
}

const authenticationLabels: Record<BackendAuthenticationStatus['state'], string> = {
  'logged-in': 'ログイン済み',
  'api-key': 'APIキー設定済み',
  'not-authenticated': '未認証',
  unknown: '判定不能',
  'not-installed': '未インストール',
};

interface RuntimeSettingsSnapshot {
  backend: {
    enabled: boolean;
    value: { backend: string; model?: string; effort?: string };
    options: string[];
    applyMode: ApplyMode;
  };
  replySuggestions: {
    enabled: boolean;
    value: 'inherit' | 'on' | 'off';
    effective: { discord: boolean; slack: boolean; web: boolean };
    applyMode: ApplyMode;
  };
  respondToBots: { enabled: boolean; value: boolean; applyMode: ApplyMode };
}

interface RuntimeSettingsMutation {
  message: string;
  settings: RuntimeSettingsSnapshot;
}

interface ModelsResponse {
  status: string;
  models: Array<{ id: string; displayName?: string; isDefault?: boolean }>;
  supportedEfforts: string[];
}

interface RegisteredWorkspace {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
}

interface SettingsChannel {
  id: string;
  name: string;
  group?: string;
}

interface SettingsChannelsResponse {
  status: 'available' | 'starting' | 'disabled' | 'unavailable';
  channels: SettingsChannel[];
  message?: string;
}

interface ChannelRuntimeSettings {
  backend: {
    value: string;
    effective: { backend: string; model?: string; effort?: string };
  };
  llmMode: { value: string; effective: string };
  autoReply: { value: string; effective: string };
  notify?: { value: string; effective: string };
  threadMode?: { value: string; effective: string };
}

function ApplyBadge({ mode }: { mode: ApplyMode | 'restart' }) {
  const label =
    mode === 'immediate' ? '即時反映' : mode === 'next-turn' ? '次のturnから' : '再起動後';
  return <span className={`settings-apply-badge ${mode}`}>{label}</span>;
}

function StartupField({
  setting,
  saving,
  onSave,
}: {
  setting: StartupSetting;
  saving: boolean;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(setting.value);
  useEffect(() => setValue(setting.value), [setting.value]);
  return (
    <div className="settings-startup-row">
      <div>
        <label htmlFor={`setting-${setting.key}`}>{setting.label}</label>
        <p>{setting.description}</p>
        <code>{setting.key}</code>
      </div>
      <div className="settings-startup-control">
        {setting.type === 'boolean' || setting.type === 'select' ? (
          <select
            id={`setting-${setting.key}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={saving}
          >
            {(setting.type === 'boolean' ? ['true', 'false'] : setting.options || []).map(
              (option) => (
                <option value={option} key={option}>
                  {option === 'true' ? 'ON' : option === 'false' ? 'OFF' : option}
                </option>
              )
            )}
          </select>
        ) : (
          <input
            id={`setting-${setting.key}`}
            type={setting.type === 'text' ? 'text' : 'number'}
            value={value}
            min={setting.min}
            max={setting.max}
            step={setting.type === 'number' ? 'any' : '1'}
            onChange={(event) => setValue(event.target.value)}
            disabled={saving}
          />
        )}
        <button
          type="button"
          className="secondary"
          disabled={saving || value === setting.value}
          onClick={() => onSave(value)}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

export function Settings() {
  const [settings, setSettings] = useState<RuntimeSettingsSnapshot>();
  const [startupGroups, setStartupGroups] = useState<StartupGroup[]>([]);
  const [connectionGroups, setConnectionGroups] = useState<ConnectionGroup[]>([]);
  const [backendAuthentication, setBackendAuthentication] = useState<BackendAuthenticationStatus[]>(
    []
  );
  const [backend, setBackend] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [models, setModels] = useState<ModelsResponse>();
  const [workspaces, setWorkspaces] = useState<RegisteredWorkspace[]>([]);
  const [workspacesStatus, setWorkspacesStatus] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [workspaceToRemove, setWorkspaceToRemove] = useState<RegisteredWorkspace>();
  const [platform, setPlatform] = useState<'discord' | 'slack'>('discord');
  const [channelId, setChannelId] = useState('');
  const [channels, setChannels] = useState<SettingsChannel[]>([]);
  const [channelsStatus, setChannelsStatus] = useState('');
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelSettings, setChannelSettings] = useState<ChannelRuntimeSettings>();
  const [channelSettingsLoading, setChannelSettingsLoading] = useState(false);
  const [connectionValues, setConnectionValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [updateTarget, setUpdateTarget] = useState<BackendAuthenticationStatus>();

  useEffect(() => {
    void Promise.all([
      getJson<RuntimeSettingsSnapshot>('/api/runtime-settings'),
      getJson<{ groups: StartupGroup[] }>('/api/startup-settings'),
      getJson<ConnectionSettingsResponse>('/api/connection-settings'),
    ])
      .then(([runtime, startup, connections]) => {
        setSettings(runtime);
        setBackend(runtime.backend.value.backend);
        setModel(runtime.backend.value.model || '');
        setEffort(runtime.backend.value.effort || '');
        setStartupGroups(startup.groups);
        setConnectionGroups(connections.groups);
        setBackendAuthentication(connections.backends);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  const loadWorkspaces = () => {
    setWorkspacesStatus('');
    void getJson<{ workspaces: RegisteredWorkspace[] }>('/api/workspaces')
      .then((result) => setWorkspaces(result.workspaces))
      .catch((cause) => {
        setWorkspaces([]);
        setWorkspacesStatus(cause instanceof Error ? cause.message : String(cause));
      });
  };

  useEffect(loadWorkspaces, []);

  useEffect(() => {
    if (!backend) return;
    setModels(undefined);
    void getJson<ModelsResponse>(`/api/models?backend=${encodeURIComponent(backend)}`)
      .then(setModels)
      .catch(() => setModels({ status: 'unavailable', models: [], supportedEfforts: [] }));
  }, [backend]);

  const loadChannels = () => {
    setChannelsLoading(true);
    setChannelsStatus('');
    void getJsonWithTimeout<SettingsChannelsResponse>(
      `/api/runtime-settings/channels?platform=${encodeURIComponent(platform)}`,
      15_000,
      'チャンネル一覧の読み込みがタイムアウトしました。接続を確認してから再読み込みしてください。'
    )
      .then((result) => {
        setChannels(result.channels);
        setChannelId((current) =>
          result.channels.some((channel) => channel.id === current) ? current : ''
        );
        setChannelsStatus(
          result.message || (result.channels.length === 0 ? '選択できるチャンネルがありません' : '')
        );
      })
      .catch((cause) => {
        setChannels([]);
        setChannelId('');
        setChannelsStatus(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setChannelsLoading(false));
  };

  useEffect(loadChannels, [platform]);

  const updateBackend = async () => {
    if (!updateTarget) return;
    const id = updateTarget.id;
    setSaving(`backend-update:${id}`);
    setError('');
    setMessage('');
    try {
      const result = await requestJson<BackendUpdateResponse>('/api/backend-tools/update', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      setConnectionGroups(result.groups);
      setBackendAuthentication(result.backends);
      setMessage(result.message);
      setUpdateTarget(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving('');
    }
  };

  useEffect(() => {
    if (!channelId) {
      setChannelSettings(undefined);
      return;
    }
    let cancelled = false;
    setChannelSettingsLoading(true);
    setChannelSettings(undefined);
    void getJson<ChannelRuntimeSettings>(
      `/api/runtime-settings/channel?platform=${encodeURIComponent(platform)}&channelId=${encodeURIComponent(channelId)}`
    )
      .then((result) => {
        if (!cancelled) setChannelSettings(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setChannelSettingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platform, channelId]);

  const update = async (payload: Record<string, unknown>, key: string): Promise<boolean> => {
    setSaving(key);
    setError('');
    setMessage('');
    try {
      const result = await requestJson<RuntimeSettingsMutation>('/api/runtime-settings', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setSettings(result.settings);
      setMessage(result.message.split('\n')[0]);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving('');
    }
  };

  const saveBackend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void update(
      {
        name: 'backend',
        action: 'set',
        backend,
        ...(model && { model }),
        ...(effort && { effort }),
      },
      'backend'
    );
  };

  const updateChannel = async (name: string, value: string) => {
    if (!channelId.trim()) {
      setError('チャンネルを選択してください');
      return;
    }
    const action = value === 'inherit' ? 'reset' : 'set';
    const updated = await update(
      {
        name,
        action,
        channelId: channelId.trim(),
        platform,
        ...(name === 'backend' && { scope: 'channel' }),
        ...(name === 'backend' && action === 'set' && { backend: value }),
        ...(name !== 'backend' && action === 'set' && { value }),
      },
      `channel-${name}`
    );
    if (!updated) return;
    try {
      setChannelSettings(
        await getJson<ChannelRuntimeSettings>(
          `/api/runtime-settings/channel?platform=${encodeURIComponent(platform)}&channelId=${encodeURIComponent(channelId)}`
        )
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const updateStartup = async (key: string, value: string) => {
    setSaving(key);
    setError('');
    setMessage('');
    try {
      const result = await requestJson<{ message: string; groups: StartupGroup[] }>(
        '/api/startup-settings',
        { method: 'POST', body: JSON.stringify({ key, value }) }
      );
      setStartupGroups(result.groups);
      setMessage(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving('');
    }
  };

  const updateConnection = async (key: string) => {
    const value = connectionValues[key]?.trim();
    if (!value) {
      setError('新しい値を入力してください');
      return;
    }
    setSaving(key);
    setError('');
    setMessage('');
    try {
      const result = await requestJson<ConnectionSettingsResponse & { message: string }>(
        '/api/connection-settings',
        { method: 'POST', body: JSON.stringify({ key, value }) }
      );
      setConnectionGroups(result.groups);
      setBackendAuthentication(result.backends);
      setConnectionValues((current) => ({ ...current, [key]: '' }));
      setMessage(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving('');
    }
  };

  const registerWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspaceName.trim() || !workspacePath.trim()) return;
    setSaving('workspace-add');
    setError('');
    setMessage('');
    try {
      await requestJson('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: workspaceName.trim(), path: workspacePath.trim() }),
      });
      const refreshed = await getJson<{ workspaces: RegisteredWorkspace[] }>('/api/workspaces');
      setWorkspaces(refreshed.workspaces);
      setWorkspaceName('');
      setWorkspacePath('');
      setWorkspacesStatus('');
      setMessage('Workspaceを追加しました');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving('');
    }
  };

  const unregisterWorkspace = async () => {
    if (!workspaceToRemove) return;
    setSaving('workspace-remove');
    setError('');
    setMessage('');
    try {
      await requestJson(`/api/workspaces/${encodeURIComponent(workspaceToRemove.id)}`, {
        method: 'DELETE',
      });
      const refreshed = await getJson<{ workspaces: RegisteredWorkspace[] }>('/api/workspaces');
      setWorkspaces(refreshed.workspaces);
      setMessage('Workspaceの登録を解除しました。ディレクトリとファイルは残っています');
      setWorkspaceToRemove(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving('');
    }
  };

  return (
    <div className="settings-page">
      <AppTopbar current="settings" />
      <main className="settings-content">
        <header className="settings-header">
          <p className="settings-kicker">Runtime configuration</p>
          <h1>設定</h1>
          <p>ランタイム設定と起動設定をまとめ、反映されるタイミングを明記します。</p>
        </header>

        {loading ? <p className="settings-status">設定を読み込んでいます…</p> : null}
        {error ? (
          <p className="settings-status error" role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="settings-status success" role="status">
            {message}
          </p>
        ) : null}

        {settings ? (
          <div className="settings-sections">
            <section className="settings-card" aria-labelledby="settings-ai-title">
              <div className="settings-card-heading">
                <div>
                  <h2 id="settings-ai-title">AIの既定</h2>
                  <p>チャンネル・Project固有の設定がない会話に使います。</p>
                </div>
                <ApplyBadge mode={settings.backend.applyMode} />
              </div>
              <form className="settings-backend-form" onSubmit={saveBackend}>
                <label>
                  <span>バックエンド</span>
                  <select
                    value={backend}
                    onChange={(event) => {
                      setBackend(event.target.value);
                      setModel('');
                      setEffort('');
                    }}
                    disabled={!settings.backend.enabled || saving === 'backend'}
                  >
                    {settings.backend.options.map((option) => (
                      <option value={option} key={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>モデル</span>
                  {models?.models.length ? (
                    <select
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      disabled={!settings.backend.enabled || saving === 'backend'}
                    >
                      <option value="">バックエンド既定</option>
                      {model && !models.models.some((option) => option.id === model) ? (
                        <option value={model}>{model}（現在の設定）</option>
                      ) : null}
                      {models.models.map((option) => (
                        <option value={option.id} key={option.id}>
                          {option.displayName && option.displayName !== option.id
                            ? `${option.displayName} (${option.id})`
                            : option.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      placeholder={models ? 'モデル名を入力' : 'モデルを取得中…'}
                      disabled={
                        !settings.backend.enabled || saving === 'backend' || models === undefined
                      }
                    />
                  )}
                </label>
                <label>
                  <span>effort</span>
                  <select
                    value={effort}
                    onChange={(event) => setEffort(event.target.value)}
                    disabled={!settings.backend.enabled || saving === 'backend'}
                  >
                    <option value="">バックエンド既定</option>
                    {(models?.supportedEfforts || []).map((option) => (
                      <option value={option} key={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={!settings.backend.enabled || !backend || saving === 'backend'}
                >
                  {saving === 'backend' ? '保存中…' : '既定を保存'}
                </button>
              </form>
            </section>

            <section className="settings-card" aria-labelledby="settings-workspace-title">
              <div className="settings-card-heading">
                <div>
                  <h2 id="settings-workspace-title">Workspace</h2>
                  <p>Projectや会話で使う作業ディレクトリを追加・管理します。</p>
                </div>
                <ApplyBadge mode="immediate" />
              </div>
              {workspacesStatus ? (
                <p className="settings-safe-note" role="status">
                  {workspacesStatus}
                </p>
              ) : (
                <div className="workspace-manager settings-workspace-manager">
                  <form className="workspace-register-form" onSubmit={registerWorkspace}>
                    <label>
                      <span>名前</span>
                      <input
                        value={workspaceName}
                        onChange={(event) => setWorkspaceName(event.target.value)}
                        placeholder="仕事用"
                        disabled={saving === 'workspace-add'}
                      />
                    </label>
                    <label>
                      <span>ディレクトリの絶対パス</span>
                      <div className="workspace-path-controls">
                        <input
                          value={workspacePath}
                          onChange={(event) => setWorkspacePath(event.target.value)}
                          placeholder="/path/to/workspace"
                          disabled={saving === 'workspace-add'}
                        />
                        <button
                          type="button"
                          onClick={() => setDirectoryPickerOpen(true)}
                          disabled={saving === 'workspace-add'}
                        >
                          参照…
                        </button>
                      </div>
                    </label>
                    <button
                      type="submit"
                      className="primary"
                      disabled={
                        saving === 'workspace-add' || !workspaceName.trim() || !workspacePath.trim()
                      }
                    >
                      {saving === 'workspace-add' ? '追加中…' : 'Workspaceを追加'}
                    </button>
                  </form>
                  <DirectoryPicker
                    open={directoryPickerOpen}
                    initialPath={workspacePath}
                    onCancel={() => setDirectoryPickerOpen(false)}
                    onSelect={(path) => {
                      setWorkspacePath(path);
                      setDirectoryPickerOpen(false);
                    }}
                  />
                  <div className="workspace-manager-list" aria-label="登録済みWorkspace">
                    {workspaces.map((workspace) => (
                      <div className="workspace-manager-row" key={workspace.id}>
                        <span className="workspace-manager-copy">
                          <strong>
                            {workspace.name}
                            {workspace.isDefault ? ' (default)' : ''}
                          </strong>
                          <small>{workspace.path}</small>
                        </span>
                        <button
                          type="button"
                          className="workspace-unregister"
                          disabled={workspace.isDefault || saving === 'workspace-remove'}
                          title={
                            workspace.isDefault
                              ? 'default Workspaceは登録解除できません'
                              : undefined
                          }
                          onClick={() => setWorkspaceToRemove(workspace)}
                        >
                          登録解除
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="settings-card" aria-labelledby="settings-channel-title">
              <div className="settings-card-heading">
                <div>
                  <h2 id="settings-channel-title">チャンネル固有設定</h2>
                  <p>DiscordまたはSlackのチャンネル名を選んで上書きします。</p>
                </div>
                <ApplyBadge mode="immediate" />
              </div>
              <div className="settings-target-row">
                <label>
                  <span>プラットフォーム</span>
                  <select
                    value={platform}
                    onChange={(event) => {
                      setChannelId('');
                      setPlatform(event.target.value as 'discord' | 'slack');
                    }}
                  >
                    <option value="discord">Discord</option>
                    <option value="slack">Slack</option>
                  </select>
                </label>
                <label>
                  <span>チャンネル</span>
                  <select
                    value={channelId}
                    onChange={(event) => setChannelId(event.target.value)}
                    disabled={channelsLoading || channels.length === 0}
                  >
                    <option value="">{channelsLoading ? '読み込み中…' : 'チャンネルを選択'}</option>
                    {channels.map((channel) => (
                      <option value={channel.id} key={channel.id}>
                        {channel.group ? `${channel.group} / ${channel.name}` : channel.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="settings-channel-status" aria-live="polite">
                {channelsStatus ? <span>{channelsStatus}</span> : <span />}
                <button
                  type="button"
                  className="secondary"
                  onClick={loadChannels}
                  disabled={channelsLoading}
                >
                  {channelsLoading ? '読み込み中…' : '一覧を再読み込み'}
                </button>
              </div>
              <div className="settings-runtime-grid">
                <label>
                  <span>
                    バックエンド <ApplyBadge mode="next-turn" />
                  </span>
                  <select
                    value={channelSettings?.backend.value || 'inherit'}
                    onChange={(event) => void updateChannel('backend', event.target.value)}
                    disabled={!channelId || channelSettingsLoading || saving === 'channel-backend'}
                  >
                    <option value="inherit">全体設定を継承</option>
                    {settings.backend.options.map((option) => (
                      <option value={option} key={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <small>
                    現在: {channelSettings?.backend.effective.backend || '—'}
                    {channelSettings?.backend.effective.model
                      ? ` / ${channelSettings.backend.effective.model}`
                      : ''}
                    {channelSettings?.backend.effective.effort
                      ? ` / effort ${channelSettings.backend.effective.effort}`
                      : ''}
                  </small>
                </label>
                <label>
                  <span>
                    Local LLMモード <ApplyBadge mode="next-turn" />
                  </span>
                  <select
                    value={channelSettings?.llmMode.value || 'inherit'}
                    onChange={(event) => void updateChannel('llmmode', event.target.value)}
                    disabled={!channelId || channelSettingsLoading || saving === 'channel-llmmode'}
                  >
                    <option value="inherit">起動時設定を継承</option>
                    <option value="agent">agent</option>
                    <option value="chat">chat</option>
                  </select>
                  <small>現在: {channelSettings?.llmMode.effective || '—'}</small>
                </label>
                <label>
                  <span>メンションなし応答</span>
                  <select
                    value={channelSettings?.autoReply.value || 'inherit'}
                    onChange={(event) => void updateChannel('autoreply', event.target.value)}
                    disabled={
                      !channelId || channelSettingsLoading || saving === 'channel-autoreply'
                    }
                  >
                    <option value="inherit">起動時設定を継承</option>
                    <option value="on">ON</option>
                    <option value="off">OFF</option>
                  </select>
                  <small>現在: {channelSettings?.autoReply.effective.toUpperCase() || '—'}</small>
                </label>
                {platform === 'discord' ? (
                  <>
                    <label>
                      <span>完了通知</span>
                      <select
                        value={channelSettings?.notify?.value || 'inherit'}
                        onChange={(event) => void updateChannel('notify', event.target.value)}
                        disabled={
                          !channelId || channelSettingsLoading || saving === 'channel-notify'
                        }
                      >
                        <option value="inherit">起動時設定を継承</option>
                        <option value="off">OFF</option>
                        <option value="message">メッセージ</option>
                        <option value="mention">メンション</option>
                      </select>
                      <small>現在: {channelSettings?.notify?.effective || '—'}</small>
                    </label>
                    <label>
                      <span>スレッド返信</span>
                      <select
                        value={channelSettings?.threadMode?.value || 'inherit'}
                        onChange={(event) => void updateChannel('threadmode', event.target.value)}
                        disabled={
                          !channelId || channelSettingsLoading || saving === 'channel-threadmode'
                        }
                      >
                        <option value="inherit">起動時設定を継承</option>
                        <option value="on">ON</option>
                        <option value="off">OFF</option>
                      </select>
                      <small>
                        現在: {channelSettings?.threadMode?.effective.toUpperCase() || '—'}
                      </small>
                    </label>
                  </>
                ) : null}
              </div>
            </section>

            <section className="settings-card" aria-labelledby="settings-response-title">
              <div className="settings-card-heading">
                <div>
                  <h2 id="settings-response-title">応答</h2>
                  <p>変更後の新しい応答から使われます。</p>
                </div>
                <ApplyBadge mode="immediate" />
              </div>
              <div className="settings-row">
                <div>
                  <label htmlFor="reply-suggestions-setting">返信候補</label>
                  <p>Discord・Slack・Webの回答後に短い返信候補を表示します。</p>
                  <small>
                    現在: Discord {settings.replySuggestions.effective.discord ? 'ON' : 'OFF'} /
                    Slack {settings.replySuggestions.effective.slack ? 'ON' : 'OFF'} / Web{' '}
                    {settings.replySuggestions.effective.web ? 'ON' : 'OFF'}
                  </small>
                </div>
                <select
                  id="reply-suggestions-setting"
                  value={settings.replySuggestions.value}
                  disabled={!settings.replySuggestions.enabled || saving === 'replysuggestions'}
                  onChange={(event) =>
                    void update(
                      {
                        name: 'replysuggestions',
                        action: event.target.value === 'inherit' ? 'reset' : 'set',
                        ...(event.target.value !== 'inherit' && { value: event.target.value }),
                      },
                      'replysuggestions'
                    )
                  }
                >
                  <option value="inherit">起動時設定</option>
                  <option value="on">ON</option>
                  <option value="off">OFF</option>
                </select>
              </div>
              <div className="settings-row">
                <div>
                  <label htmlFor="respond-bots-setting">Botからの投稿へ応答</label>
                  <p>許可リスト内のDiscord Botからの投稿を処理します。</p>
                </div>
                <select
                  id="respond-bots-setting"
                  value={settings.respondToBots.value ? 'on' : 'off'}
                  disabled={!settings.respondToBots.enabled || saving === 'respondtobots'}
                  onChange={(event) =>
                    void update(
                      { name: 'respondtobots', action: 'set', value: event.target.value },
                      'respondtobots'
                    )
                  }
                >
                  <option value="on">ON</option>
                  <option value="off">OFF</option>
                </select>
              </div>
            </section>

            <section
              className="settings-card settings-startup"
              aria-labelledby="settings-connection-title"
            >
              <div className="settings-card-heading">
                <div>
                  <h2 id="settings-connection-title">接続とAPIキー</h2>
                  <p>新しい値を安全な秘密情報ストアへ保存します。保存済みの値は表示しません。</p>
                </div>
                <ApplyBadge mode="restart" />
              </div>
              <div className="settings-auth-statuses" aria-label="AIサービスの認証状態">
                {backendAuthentication.map((item) => (
                  <div className="settings-auth-status" key={item.id}>
                    <div>
                      <strong>{item.label}</strong>
                      <small>
                        {item.installed
                          ? item.version || 'インストール済み'
                          : 'CLIが見つかりません'}
                        {item.state === 'logged-in' && item.apiKeyConfigured
                          ? ' · APIキーも設定済み'
                          : ''}
                      </small>
                    </div>
                    <div className="settings-auth-actions">
                      <span className={`settings-auth-badge ${item.state}`}>
                        {authenticationLabels[item.state]}
                      </span>
                      {item.installed && item.updateSupported ? (
                        <button
                          type="button"
                          className="settings-auth-update"
                          disabled={saving.startsWith('backend-update:')}
                          onClick={() => setUpdateTarget(item)}
                        >
                          {saving === `backend-update:${item.id}` ? '更新中…' : '更新'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              <div className="settings-connection-groups">
                {connectionGroups.map((group) => (
                  <div key={group.label}>
                    <h3>{group.label}</h3>
                    {group.fields.map((field) => (
                      <div className="settings-secret-row" key={field.key}>
                        <div className="settings-secret-label">
                          <span>{field.label}</span>
                          <strong className={field.configured ? 'configured' : ''}>
                            {field.configured ? '設定済み' : '未設定'}
                          </strong>
                        </div>
                        <div className="settings-secret-control">
                          <input
                            type={field.type}
                            value={connectionValues[field.key] || ''}
                            autoComplete={field.type === 'password' ? 'new-password' : 'off'}
                            spellCheck={false}
                            aria-label={`${field.label}の新しい値`}
                            placeholder="新しい値を入力"
                            disabled={saving === field.key}
                            onChange={(event) =>
                              setConnectionValues((current) => ({
                                ...current,
                                [field.key]: event.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="secondary"
                            disabled={saving === field.key || !connectionValues[field.key]?.trim()}
                            onClick={() => void updateConnection(field.key)}
                          >
                            {saving === field.key ? '保存中…' : '保存'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <p className="settings-safe-note">
                入力値はWeb画面へ再表示せず、保存後に入力欄から消去します。明示的な環境変数がある場合はそちらが優先されます。
              </p>
            </section>

            {startupGroups.map((group) => (
              <details className="settings-card settings-startup" key={group.id}>
                <summary className="settings-card-heading">
                  <div>
                    <h2>{group.label}の起動設定</h2>
                    <p>{group.settings.length}項目。保存後、xangiの再起動で反映します。</p>
                  </div>
                  <ApplyBadge mode="restart" />
                </summary>
                <div className="settings-startup-fields">
                  {group.settings.map((setting) => (
                    <StartupField
                      key={setting.key}
                      setting={setting}
                      saving={saving === setting.key}
                      onSave={(value) => void updateStartup(setting.key, value)}
                    />
                  ))}
                </div>
              </details>
            ))}
          </div>
        ) : null}
      </main>
      <ConfirmDialog
        open={Boolean(updateTarget)}
        title={`${updateTarget?.label || 'AIサービス'}を更新しますか？`}
        description="公式CLIの自己更新コマンドをサーバー上で実行します。更新処理中もxangiは動作を続け、新しいCLIは次の実行から使われます。"
        confirmLabel="更新する"
        busyLabel="更新中…"
        busy={Boolean(updateTarget && saving === `backend-update:${updateTarget.id}`)}
        onCancel={() => setUpdateTarget(undefined)}
        onConfirm={() => void updateBackend()}
      />
      <ConfirmDialog
        open={Boolean(workspaceToRemove)}
        title="Workspaceの登録を解除"
        description={`「${workspaceToRemove?.name || ''}」の登録だけを解除します。ディレクトリとファイルは削除しません。`}
        confirmLabel="登録解除"
        busyLabel="解除中…"
        busy={saving === 'workspace-remove'}
        onCancel={() => {
          if (saving !== 'workspace-remove') setWorkspaceToRemove(undefined);
        }}
        onConfirm={() => void unregisterWorkspace()}
      />
    </div>
  );
}
