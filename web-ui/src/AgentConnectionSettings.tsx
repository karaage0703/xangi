import { ApplyBadge } from './ApplyBadge';
import { RestartGuidance } from './RestartGuidance';
import { useEffect, useState, useId, type FormEvent } from 'react';
import { requestJson } from './api';
import { jsonInit } from './chatPresentation';
import { CatalogRow, useCatalogFormFocus } from './CatalogControls';
import { ConfirmDialog } from './ConfirmDialog';

interface Connection {
  id: string;
  name: string;
  platform: 'discord' | 'slack';
  enabled: boolean;
  allowedUsers: string;
  status: 'starting' | 'ready' | 'failed' | 'stopped';
}
const connectionLabel = (connection: Connection) =>
  connection.name || (connection.platform === 'discord' ? 'Discord' : 'Slack');
const statuses = { starting: '接続中', ready: '接続済み', failed: '起動失敗', stopped: '停止中' };

export function AgentConnectionSettings({ agentId }: { agentId: string }) {
  const fieldId = useId();
  const formRef = useCatalogFormFocus();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [id, setId] = useState<string>();
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<'discord' | 'slack'>('discord');
  const [enabled, setEnabled] = useState(true);
  const [allowedUsers, setAllowedUsers] = useState('');
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Connection>();
  const endpoint = `/api/agents/${encodeURIComponent(agentId)}/connections`;
  useEffect(() => {
    let cancelled = false;
    void requestJson<{ connections: Connection[] }>(endpoint)
      .then((r) => {
        if (!cancelled) setConnections(r.connections);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  function edit(connection?: Connection) {
    setId(connection?.id);
    setName(connection?.name || '');
    setPlatform(connection?.platform || 'discord');
    setEnabled(connection?.enabled ?? true);
    setAllowedUsers(connection?.allowedUsers || '');
    setBotToken('');
    setAppToken('');
    setError('');
    setNotice('');
    setEditing(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<{ connection: Connection }>(
        id ? `${endpoint}/${encodeURIComponent(id)}` : endpoint,
        jsonInit(id ? 'PATCH' : 'POST', {
          name,
          platform,
          enabled,
          allowedUsers,
          botToken,
          appToken,
        })
      );
      setConnections((previous) => [
        ...previous.filter((c) => c.id !== result.connection.id),
        result.connection,
      ]);
      setBotToken('');
      setAppToken('');
      setEditing(false);
      setNotice('接続設定を保存しました。エージェント設定は再起動後の新しい会話に適用されます。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="専用Bot接続" className="agent-connections">
      <h3>
        Discord・Slackの専用Bot <ApplyBadge mode="restart" />
      </h3>
      <p>
        このエージェント専用のBotで受信・返信します。追加・変更・削除はxangiの再起動後に反映されます。
      </p>
      {notice && <RestartGuidance>{notice}</RestartGuidance>}
      {error && (
        <p role="alert" className="settings-status error">
          {error}
        </p>
      )}
      {loading && <p role="status">接続を読み込んでいます…</p>}
      {!editing && (
        <>
          <nav className="project-view-list" aria-label="専用Bot接続一覧">
            {connections.map((connection) => (
              <CatalogRow
                key={connection.id}
                name={connectionLabel(connection)}
                onEdit={() => edit(connection)}
                onDelete={() => {
                  setError('');
                  setNotice('');
                  setDeleting(connection);
                }}
              >
                <small>
                  {connection.platform === 'discord' ? 'Discord' : 'Slack'} /{' '}
                  {statuses[connection.status]}
                </small>
                <small>次回起動: {connection.enabled ? '有効' : '無効'}</small>
              </CatalogRow>
            ))}
          </nav>
          {!loading && !connections.length && <p>専用Botは未設定です。</p>}
          <button
            type="button"
            className="secondary catalog-create"
            disabled={loading}
            onClick={() => edit()}
          >
            接続を追加
          </button>
        </>
      )}
      {editing && (
        <form ref={formRef} tabIndex={-1} className="project-form" onSubmit={(e) => void save(e)}>
          <fieldset disabled={busy}>
            <legend>{id ? '接続を編集' : '新しい接続'}</legend>
            <label>
              <span id={fieldId + '-name-label'}>接続名（任意）</span>
              <input
                aria-labelledby={fieldId + '-name-label'}
                aria-describedby={fieldId + '-name-hint'}
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <small id={fieldId + '-name-hint'}>
                空欄ならDiscord・Slackのサービス名で表示します。
              </small>
            </label>
            <label>
              <span>サービス</span>
              <select
                aria-label="サービス"
                value={platform}
                disabled={Boolean(id)}
                onChange={(e) => {
                  setPlatform(e.target.value as 'discord' | 'slack');
                  setBotToken('');
                  setAppToken('');
                }}
              >
                <option value="discord">Discord</option>
                <option value="slack">Slack</option>
              </select>
            </label>
            <label>
              <span id={fieldId + '-bot-label'}>
                Botトークン{id ? '（変更する場合のみ）' : '（必須）'}
              </span>
              <input
                aria-labelledby={fieldId + '-bot-label'}
                aria-describedby={fieldId + '-bot-hint'}
                type="password"
                autoComplete="new-password"
                required={!id}
                maxLength={4096}
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
              />
              <small id={fieldId + '-bot-hint'}>
                {id
                  ? '空欄なら保存済みのトークンを使います。'
                  : '共通Botや他の接続とは別のBotを指定してください。'}
              </small>
            </label>
            {platform === 'slack' && (
              <label>
                <span id={fieldId + '-app-label'}>
                  Appトークン{id ? '（変更する場合のみ）' : '（必須）'}
                </span>
                <input
                  aria-labelledby={fieldId + '-app-label'}
                  aria-describedby={fieldId + '-app-hint'}
                  type="password"
                  autoComplete="new-password"
                  required={!id}
                  maxLength={4096}
                  value={appToken}
                  onChange={(e) => setAppToken(e.target.value)}
                />
                <small id={fieldId + '-app-hint'}>
                  Socket Modeを有効にしたSlack AppのAppトークンを入力してください。
                </small>
              </label>
            )}
            <label>
              <span id={fieldId + '-users-label'}>許可ユーザーID（必須）</span>
              <input
                required
                aria-labelledby={fieldId + '-users-label'}
                aria-describedby={fieldId + '-users-hint'}
                value={allowedUsers}
                onChange={(e) => setAllowedUsers(e.target.value)}
              />
              <small id={fieldId + '-users-hint'}>
                複数はカンマ区切り。*を指定すると全員に応答します。
              </small>
            </label>
            <label>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              次回起動時に接続する
            </label>
          </fieldset>
          <div className="project-form-actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? '保存中…' : '接続を保存'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError('');
                setBotToken('');
                setAppToken('');
              }}
            >
              キャンセル
            </button>
          </div>
        </form>
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="専用Bot接続を削除"
        description={`「${deleting ? connectionLabel(deleting) : ''}」を削除します。現在の接続はxangiの再起動まで継続します。会話履歴は保持されます。`}
        confirmLabel="削除"
        busyLabel="削除中…"
        busy={busy}
        error={error}
        variant="danger"
        onCancel={() => {
          if (!busy) setDeleting(undefined);
        }}
        onConfirm={() => {
          if (!deleting || busy) return;
          setBusy(true);
          setError('');
          void requestJson(`${endpoint}/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' })
            .then(() => {
              setConnections((previous) => previous.filter((c) => c.id !== deleting.id));
              setDeleting(undefined);
              setNotice('削除を保存しました。現在の接続はxangiの再起動後に停止します。');
            })
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      />
    </section>
  );
}
