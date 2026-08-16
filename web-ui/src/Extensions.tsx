import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppTopbar } from './AppTopbar';
import { getJson, requestJson } from './api';
import { extensionSetupStorageKey } from './extensionSetup';
import { sessionPath } from './sessionPermalink';

interface ExtensionEntry {
  id: string;
  displayName: string;
  description?: string;
  permissions?: string[];
  version: string;
  capabilities: string[];
  installed: boolean;
  running: boolean;
  healthy: boolean;
  uiAvailable: boolean;
  updateSupported?: boolean;
  statusKnown: boolean;
  actionsAvailable: boolean;
  detail?: string;
  setupRepositoryUrl?: string;
  source?: {
    repositoryUrl: string;
    commitSha: string;
    license?: string;
  };
}

interface ExtensionsResponse {
  extensions: ExtensionEntry[];
  degraded: boolean;
  issues: Array<{ code: string; message: string }>;
}

function statusLabel(extension: ExtensionEntry): string {
  if (!extension.statusKnown) return '状態不明';
  if (extension.healthy) return '利用可能';
  if (extension.running) return '起動確認中';
  if (extension.installed) return '停止中';
  return '未インストール';
}

function extensionDescription(extension: ExtensionEntry): string {
  return extension.description || 'xangiに外部serviceの機能を追加します。';
}

function permissionLabels(extension: ExtensionEntry): string[] {
  return (
    extension.permissions || [
      '登録済みの外部serviceを起動',
      'manifestに記載されたHTTP capabilityへ接続',
    ]
  );
}

export function Extensions() {
  const [extensions, setExtensions] = useState<ExtensionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string>();
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [addingRepository, setAddingRepository] = useState(false);
  const [error, setError] = useState('');
  const [catalogWarning, setCatalogWarning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getJson<ExtensionsResponse>('/api/extensions');
      setExtensions(result.extensions);
      setCatalogWarning(result.degraded || result.issues.length > 0);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const requestRepositorySetup = async (url: string) => {
    const result = await requestJson<{
      sessionId: string;
      prompt: string;
      displayMessage: string;
    }>('/api/extensions/repositories', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    window.sessionStorage.setItem(
      extensionSetupStorageKey(result.sessionId),
      JSON.stringify({ prompt: result.prompt, displayMessage: result.displayMessage })
    );
    window.location.assign(sessionPath(result.sessionId));
  };

  const requestSetup = async (extension: ExtensionEntry) => {
    setActionId(extension.id);
    setError('');
    try {
      if (!extension.installed && extension.setupRepositoryUrl) {
        await requestRepositorySetup(extension.setupRepositoryUrl);
        return;
      }
      const result = await requestJson<{
        sessionId: string;
        prompt: string;
        displayMessage: string;
      }>(`/api/extensions/${encodeURIComponent(extension.id)}/setup`, { method: 'POST' });
      window.sessionStorage.setItem(
        extensionSetupStorageKey(result.sessionId),
        JSON.stringify({ prompt: result.prompt, displayMessage: result.displayMessage })
      );
      window.location.assign(sessionPath(result.sessionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionId(undefined);
    }
  };

  const removeExtension = async (extension: ExtensionEntry) => {
    setActionId(extension.id);
    setError('');
    try {
      const result = await requestJson<{ extension: ExtensionEntry }>(
        `/api/extensions/${encodeURIComponent(extension.id)}`,
        { method: 'DELETE' }
      );
      setExtensions((current) =>
        current.map((item) => (item.id === result.extension.id ? result.extension : item))
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionId(undefined);
    }
  };

  const requestUpdate = async (extension: ExtensionEntry) => {
    setActionId(extension.id);
    setError('');
    try {
      const result = await requestJson<{
        sessionId: string;
        prompt: string;
        displayMessage: string;
      }>(`/api/extensions/${encodeURIComponent(extension.id)}/update`, { method: 'POST' });
      window.sessionStorage.setItem(
        extensionSetupStorageKey(result.sessionId),
        JSON.stringify({ prompt: result.prompt, displayMessage: result.displayMessage })
      );
      window.location.assign(sessionPath(result.sessionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionId(undefined);
    }
  };

  const addRepository = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAddingRepository(true);
    setError('');
    try {
      await requestRepositorySetup(repositoryUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAddingRepository(false);
    }
  };

  return (
    <div className="extensions-page">
      <AppTopbar current="extensions" />
      <main className="extensions-content">
        <header className="extensions-header">
          <div>
            <p className="extensions-kicker">Official extension catalog</p>
            <h1>Extensions</h1>
            <p>xangiへ機能を追加します。カタログまたは公開GitHubリポジトリから選べます。</p>
          </div>
          <button
            className="extensions-refresh"
            type="button"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? '確認中…' : '再確認'}
          </button>
        </header>

        <section className="extension-repository" aria-labelledby="extension-repository-title">
          <div>
            <h2 id="extension-repository-title">GitHubリポジトリから追加</h2>
            <p>
              公開リポジトリのrootにある <code>xangi-extension.json</code>{' '}
              を検証し、専用のセットアップ会話を開きます。
            </p>
          </div>
          <form onSubmit={(event) => void addRepository(event)}>
            <label htmlFor="extension-repository-url">リポジトリURL</label>
            <div className="extension-repository-controls">
              <input
                id="extension-repository-url"
                type="url"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/owner/repository"
                autoComplete="url"
                required
                disabled={addingRepository}
              />
              <button type="submit" disabled={addingRepository || !repositoryUrl.trim()}>
                {addingRepository ? '取得・検証中…' : 'URLから追加'}
              </button>
            </div>
          </form>
        </section>

        {error ? (
          <div className="extensions-notice error" role="alert">
            {error}
          </div>
        ) : null}

        {catalogWarning ? (
          <div className="extensions-notice warning" role="status">
            一部のextension情報を読み込めませんでした。公式項目と読み込めた項目を表示しています。
          </div>
        ) : null}

        {loading && extensions.length === 0 ? (
          <div className="extensions-empty">extensionを確認しています…</div>
        ) : extensions.length === 0 ? (
          <div className="extensions-empty">
            <h2>利用できるextensionはありません</h2>
            <p>
              上の入力欄へ公開GitHubリポジトリURLを入力するか、開発用manifestを設定してください。
            </p>
          </div>
        ) : (
          <section className="extension-list" aria-label="利用可能なextension">
            {extensions.map((extension) => {
              const busy = actionId === extension.id;
              return (
                <article className="extension-row" key={extension.id}>
                  <div className="extension-main" aria-live="polite">
                    <div className="extension-title-row">
                      <h2>{extension.displayName}</h2>
                      <span className={`extension-status ${extension.healthy ? 'healthy' : ''}`}>
                        {statusLabel(extension)}
                      </span>
                    </div>
                    <p className="extension-description">{extensionDescription(extension)}</p>
                    <dl className="extension-meta">
                      <div>
                        <dt>Version</dt>
                        <dd>{extension.version}</dd>
                      </div>
                      <div>
                        <dt>Capabilities</dt>
                        <dd>{extension.capabilities.join(', ') || 'なし'}</dd>
                      </div>
                      {extension.source ? (
                        <div>
                          <dt>Source</dt>
                          <dd>
                            <a
                              href={extension.source.repositoryUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {new URL(extension.source.repositoryUrl).pathname.slice(1)}
                            </a>
                            {' @ '}
                            {extension.source.commitSha.slice(0, 7)}
                            {extension.source.license ? ` · ${extension.source.license}` : ''}
                          </dd>
                        </div>
                      ) : extension.setupRepositoryUrl ? (
                        <div>
                          <dt>Source</dt>
                          <dd>
                            <a href={extension.setupRepositoryUrl} target="_blank" rel="noreferrer">
                              {new URL(extension.setupRepositoryUrl).pathname.slice(1)}
                            </a>{' '}
                            · 公式catalog
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                    <div className="extension-permissions">
                      <span>申告されたアクセス</span>
                      <ul>
                        {permissionLabels(extension).map((permission) => (
                          <li key={permission}>{permission}</li>
                        ))}
                      </ul>
                    </div>
                    {extension.detail ? (
                      <p className="extension-detail">{extension.detail}</p>
                    ) : null}
                  </div>
                  <div className="extension-actions">
                    {extension.installed && extension.uiAvailable ? (
                      <button
                        className="extension-open"
                        type="button"
                        onClick={() =>
                          window.location.assign(
                            `/api/extensions/${encodeURIComponent(extension.id)}/ui`
                          )
                        }
                        disabled={
                          !extension.actionsAvailable || !extension.healthy || Boolean(actionId)
                        }
                      >
                        開く
                      </button>
                    ) : null}
                    {extension.installed ? (
                      <button
                        className="extension-install"
                        type="button"
                        onClick={() => void requestSetup(extension)}
                        disabled={!extension.actionsAvailable || Boolean(actionId)}
                      >
                        {busy ? '準備中…' : 'セットアップ'}
                      </button>
                    ) : null}
                    {extension.installed && extension.updateSupported ? (
                      <button
                        className="extension-install"
                        type="button"
                        onClick={() => void requestUpdate(extension)}
                        disabled={!extension.actionsAvailable || Boolean(actionId)}
                      >
                        {busy ? '確認中…' : '更新を確認'}
                      </button>
                    ) : null}
                    <button
                      className={extension.installed ? 'extension-remove' : 'extension-install'}
                      type="button"
                      onClick={() =>
                        void (extension.installed
                          ? removeExtension(extension)
                          : requestSetup(extension))
                      }
                      disabled={!extension.actionsAvailable || Boolean(actionId)}
                    >
                      {busy ? '準備中…' : extension.installed ? '削除' : '追加'}
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}
