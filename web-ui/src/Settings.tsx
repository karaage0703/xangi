import { ConfiguredChannels } from './ConfiguredChannels';
import {
  CatalogCreateButton,
  CatalogRow,
  CatalogFormActions,
  useCatalogFormFocus,
} from './CatalogControls';
import { TeamSettings } from './TeamSettings';
import { useEffect, useState, type FormEvent } from 'react';
import { AppTopbar } from './AppTopbar';
import { MarkdownDisplaySettings } from './MarkdownPreferences';
import { getJson, getJsonWithTimeout, requestJson } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { DirectoryPicker } from './DirectoryPicker';
import { AgentSettings } from './AgentSettings';
import { ChannelBackendSettings, type ChannelBackendSnapshot } from './ChannelBackendSettings';

type ApplyMode = 'immediate' | 'next-turn';

interface StartupSetting {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'integer' | 'number' | 'select' | 'text' | 'textarea';
  value: string;
  options?: string[];
  optionLabels?: Record<string, string>;
  maxLength?: number;
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

interface ChannelRuntimeSettings extends ChannelBackendSnapshot {
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
        <p id={`setting-description-${setting.key}`}>{setting.description}</p>
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
                  {setting.optionLabels?.[option] ??
                    (option === 'true' ? 'ON' : option === 'false' ? 'OFF' : option)}
                </option>
              )
            )}
          </select>
        ) : setting.type === 'textarea' ? (
          <textarea
            id={`setting-${setting.key}`}
            aria-describedby={`setting-description-${setting.key}`}
            value={value}
            rows={6}
            maxLength={setting.maxLength}
            placeholder="空欄で既定の回答文を使います"
            onChange={(event) => setValue(event.target.value)}
            disabled={saving}
          />
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
  const workspaceFormRef = useCatalogFormFocus();
  const [settings, setSettings] = useState<RuntimeSettingsSnapshot>();
  const [startupGroups, setStartupGroups] = useState<StartupGroup[]>([]);
  const [connectionGroups, setConnectionGroups] = useState<ConnectionGroup[]>([]);
  const [backendAuthentication, setBackendAuthentication] = useState<BackendAuthenticationStatus[]>(
    []
  );
  const [workspaces, setWorkspaces] = useState<RegisteredWorkspace[]>([]);
  const [workspacesStatus, setWorkspacesStatus] = useState('');
  const [workspaceFormOpen, setWorkspaceFormOpen] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<RegisteredWorkspace>();
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [workspaceToRemove, setWorkspaceToRemove] = useState<RegisteredWorkspace>();
  const [workspaceRemoveError, setWorkspaceRemoveError] = useState('');
  const [platform, setPlatform] = useState<'discord' | 'slack'>('discord');
  const [channelId, setChannelId] = useState('');
  const [channels, setChannels] = useState<SettingsChannel[]>([]);
  const [channelsStatus, setChannelsStatus] = useState('');
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelSettings, setChannelSettings] = useState<ChannelRuntimeSettings>();
  const [channelSettingsLoading, setChannelSettingsLoading] = useState(false);
  const [connectionValues, setConnectionValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionsError, setConnectionsError] = useState('');
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [updateTarget, setUpdateTarget] = useState<BackendAuthenticationStatus>();
  const [updatingBackend, setUpdatingBackend] = useState('');
  const [updateStatus, setUpdateStatus] = useState('');
  const [updateError, setUpdateError] = useState('');

  useEffect(() => {
    const focusSection = () => {
      const id = window.location.hash.slice(1);
      if (id !== 'display' && id !== 'agents' && id !== 'teams' && id !== 'workspaces') return;
      const section = document.getElementById(id);
      section?.scrollIntoView({ block: 'start' });
      section?.focus({ preventScroll: true });
    };
    if (!loading) focusSection();
    window.addEventListener('hashchange', focusSection);
    return () => window.removeEventListener('hashchange', focusSection);
  }, [loading]);

  useEffect(() => {
    void Promise.all([
      getJson<RuntimeSettingsSnapshot>('/api/runtime-settings'),
      getJson<{ groups: StartupGroup[] }>('/api/startup-settings'),
    ])
      .then(([runtime, startup]) => {
        setSettings(runtime);
        setStartupGroups(startup.groups);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  const loadConnections = () => {
    setConnectionsLoading(true);
    setConnectionsError('');
    void getJson<ConnectionSettingsResponse>('/api/connection-settings')
      .then((connections) => {
        setConnectionGroups(connections.groups);
        setBackendAuthentication(connections.backends);
      })
      .catch((cause) => setConnectionsError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setConnectionsLoading(false));
  };

  useEffect(loadConnections, []);

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
    setUpdatingBackend(id);
    setUpdateTarget(undefined);
    setUpdateError('');
    setUpdateStatus(`${updateTarget.label}を更新中です。ほかの操作を続けられます。`);
    try {
      const result = await requestJson<BackendUpdateResponse>('/api/backend-tools/update', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      setConnectionGroups(result.groups);
      setBackendAuthentication(result.backends);
      setUpdateStatus(result.message);
    } catch (cause) {
      setUpdateStatus('');
      setUpdateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUpdatingBackend('');
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
      await requestJson(
        editingWorkspace
          ? `/api/workspaces/${encodeURIComponent(editingWorkspace.id)}`
          : '/api/workspaces',
        {
          method: editingWorkspace ? 'PATCH' : 'POST',
          body: JSON.stringify(
            editingWorkspace
              ? { name: workspaceName.trim() }
              : { name: workspaceName.trim(), path: workspacePath.trim() }
          ),
        }
      );
      const refreshed = await getJson<{ workspaces: RegisteredWorkspace[] }>('/api/workspaces');
      setWorkspaces(refreshed.workspaces);
      setWorkspaceName('');
      setWorkspacePath('');
      setWorkspacesStatus('');
      setWorkspaceFormOpen(false);
      setEditingWorkspace(undefined);
      setMessage(
        editingWorkspace ? 'ワークスペースを保存しました' : 'ワークスペースを作成しました'
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving('');
    }
  };

  const unregisterWorkspace = async () => {
    if (!workspaceToRemove || saving === 'workspace-remove') return;
    setSaving('workspace-remove');
    setWorkspaceRemoveError('');
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
      setWorkspaceRemoveError(cause instanceof Error ? cause.message : String(cause));
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
          <nav className="settings-section-links" aria-label="設定項目">
            <a href="#display">表示</a>
            <a href="#workspaces">ワークスペース</a>
            <a href="#agents">エージェント</a>
            <a href="#teams">チーム</a>
          </nav>
        </header>

        <div className="settings-sections">
          <MarkdownDisplaySettings />
        </div>

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
            <section
              id="workspaces"
              className="settings-card"
              aria-labelledby="settings-workspace-title"
              tabIndex={-1}
            >
              <div className="settings-card-heading">
                <div>
                  <h2 id="settings-workspace-title">ワークスペース</h2>
                  <p>Projectや会話で使う作業ディレクトリを追加・管理します。</p>
                </div>
                {!workspaceFormOpen && (
                  <CatalogCreateButton
                    label="ワークスペース"
                    onClick={() => {
                      setEditingWorkspace(undefined);
                      setWorkspaceName('');
                      setWorkspacePath('');
                      setWorkspaceFormOpen(true);
                      setError('');
                      setMessage('');
                    }}
                  />
                )}
              </div>
              {workspacesStatus ? (
                <p className="settings-safe-note" role="status">
                  {workspacesStatus}
                </p>
              ) : (
                <div className="workspace-manager settings-workspace-manager">
                  {workspaceFormOpen ? (
                    <form
                      ref={workspaceFormRef}
                      tabIndex={-1}
                      className="project-form"
                      onSubmit={registerWorkspace}
                    >
                      <h3>{editingWorkspace ? 'ワークスペースを編集' : '新しいワークスペース'}</h3>
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
                            disabled={Boolean(editingWorkspace) || saving === 'workspace-add'}
                          />
                          <button
                            type="button"
                            hidden={Boolean(editingWorkspace)}
                            onClick={() => setDirectoryPickerOpen(true)}
                            disabled={saving === 'workspace-add'}
                          >
                            参照…
                          </button>
                        </div>
                      </label>
                      <p>
                        {editingWorkspace
                          ? '表示名だけを変更します。作業場所のパスは変わりません。'
                          : '既存のフォルダを作業場所として登録します。親フォルダのAGENTS.mdなどが適用される場合があります。独立した用途では、既存ワークスペースの外を選び、親の指示も確認してください。'}
                      </p>
                      <CatalogFormActions
                        creating={!editingWorkspace}
                        saving={saving === 'workspace-add'}
                        disabled={!workspaceName.trim() || !workspacePath.trim()}
                        onCancel={() => {
                          setWorkspaceFormOpen(false);
                          setEditingWorkspace(undefined);
                        }}
                      />
                    </form>
                  ) : (
                    <div className="catalog-list" aria-label="登録済みワークスペース">
                      {workspaces.map((workspace) => (
                        <CatalogRow
                          key={workspace.id}
                          name={workspace.name}
                          disabled={workspace.isDefault}
                          deleteDisabled={workspace.isDefault || saving === 'workspace-remove'}
                          disabledReason={
                            workspace.isDefault
                              ? '既定のワークスペースは編集・登録解除できません。'
                              : undefined
                          }
                          deleteLabel="登録解除"
                          onDelete={() => {
                            setWorkspaceRemoveError('');
                            setWorkspaceToRemove(workspace);
                          }}
                          onEdit={() => {
                            setEditingWorkspace(workspace);
                            setWorkspaceName(workspace.name);
                            setWorkspacePath(workspace.path);
                            setWorkspaceFormOpen(true);
                            setError('');
                            setMessage('');
                          }}
                        >
                          <small>{workspace.path}</small>
                        </CatalogRow>
                      ))}
                    </div>
                  )}
                  <DirectoryPicker
                    open={directoryPickerOpen}
                    initialPath={workspacePath}
                    onCancel={() => setDirectoryPickerOpen(false)}
                    onSelect={(path) => {
                      setWorkspacePath(path);
                      setDirectoryPickerOpen(false);
                    }}
                  />
                </div>
              )}
            </section>

            <AgentSettings
              workspaces={workspaces}
              defaultAI={settings?.backend}
              onDefaultAISaved={() =>
                getJson<RuntimeSettingsSnapshot>('/api/runtime-settings')
                  .then(setSettings)
                  .catch((cause) => setError(String(cause)))
              }
            />
            <TeamSettings />

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
                    aria-label="チャンネル"
                    value={channelId}
                    onChange={(event) => {
                      setChannelSettings(undefined);
                      setChannelId(event.target.value);
                    }}
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
              <ConfiguredChannels
                key={platform}
                platform={platform}
                onSelect={(channel) => {
                  setChannels((current) =>
                    current.some((item) => item.id === channel.id) ? current : [...current, channel]
                  );
                  setChannelSettings(undefined);
                  setChannelId(channel.id);
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLSelectElement>('select[aria-label="チャンネル"]')
                      ?.focus()
                  );
                }}
              />
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
              {channelId && channelSettings && !channelSettingsLoading && (
                <ChannelBackendSettings
                  key={`${platform}:${channelId}`}
                  platform={platform}
                  channelId={channelId}
                  snapshot={channelSettings}
                  workspaces={workspaces}
                  backends={settings.backend.options}
                  enabled={settings.backend.enabled}
                />
              )}
              <div className="settings-runtime-grid">
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
                  </>
                ) : null}
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
                  <small>現在: {channelSettings?.threadMode?.effective.toUpperCase() || '—'}</small>
                </label>
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
              {connectionsLoading ? (
                <p className="settings-status" role="status">
                  接続と認証状態を確認しています…
                </p>
              ) : null}
              {connectionsError ? (
                <div className="settings-status error" role="alert">
                  <p>接続と認証状態を取得できませんでした: {connectionsError}</p>
                  <button type="button" className="secondary" onClick={loadConnections}>
                    再読み込み
                  </button>
                </div>
              ) : null}
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
                          disabled={Boolean(updatingBackend)}
                          onClick={() => setUpdateTarget(item)}
                        >
                          {updatingBackend === item.id ? '更新中…' : '更新'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              {updateStatus && <p role="status">{updateStatus}</p>}
              {updateError && (
                <p className="settings-status error" role="alert">
                  {updateError}
                </p>
              )}
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
        error={workspaceRemoveError}
        variant="danger"
        onCancel={() => {
          if (saving !== 'workspace-remove') {
            setWorkspaceToRemove(undefined);
            setWorkspaceRemoveError('');
          }
        }}
        onConfirm={() => void unregisterWorkspace()}
      />
    </div>
  );
}
