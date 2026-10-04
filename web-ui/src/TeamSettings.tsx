import { useEffect, useState, type FormEvent } from 'react';
import { requestJson } from './api';
import { jsonInit } from './chatPresentation';
import { ConfirmDialog } from './ConfirmDialog';

interface Member {
  agentId: string;
  role: string;
  reportsTo?: string;
}
interface Team {
  id: string;
  name: string;
  prompt: string;
  members: Member[];
  leadership?: 'caller' | 'fixed';
  maxConcurrency?: number;
  serializeWorkspaces?: boolean;
}
interface Agent {
  id: string;
  name: string;
  role?: string;
}
export function TeamSettings() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editing, setEditing] = useState<Team>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Team>();
  async function load() {
    setLoading(true);
    setError('');
    try {
      const p = await requestJson<{ teams: Team[]; agents: Agent[] }>('/api/teams');
      setTeams(p.teams || []);
      setAgents(p.agents || []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function changeMember(index: number, value: Partial<Member>) {
    if (editing)
      setEditing({
        ...editing,
        members: editing.members.map((m, i) => (i === index ? { ...m, ...value } : m)),
      });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { team } = await requestJson<{ team: Team }>(
        editing.id ? `/api/teams/${encodeURIComponent(editing.id)}` : '/api/teams',
        jsonInit(editing.id ? 'PATCH' : 'POST', {
          name: editing.name,
          prompt: editing.prompt,
          members: editing.members,
          leadership: 'caller',
          maxConcurrency: editing.maxConcurrency ?? 16,
          serializeWorkspaces: editing.serializeWorkspaces ?? false,
        })
      );
      setTeams((current) => [...current.filter((p) => p.id !== team.id), team]);
      setEditing(undefined);
      window.dispatchEvent(new Event('xangi:teams-changed'));
      setNotice(
        'チームを保存しました。チャンネル固有設定で担当に指定できます。変更は新しい会話から適用されます。'
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setSaving(true);
    setError('');
    try {
      await requestJson(`/api/teams/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' });
      setTeams((current) => current.filter((p) => p.id !== deleting.id));
      setDeleting(undefined);
      window.dispatchEvent(new Event('xangi:teams-changed'));
      setNotice('チームを削除しました');
    } catch (e) {
      setError(String(e));
      setDeleting(undefined);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="settings-card" id="teams" aria-labelledby="settings-teams-title">
      <div className="settings-card-heading">
        <div>
          <h2 id="settings-teams-title">チーム</h2>
          <p>
            デフォルトの担当や登録済みエージェントを組み合わせ、メンバーと共通指示を設定します。担当は必要な場合だけ指定できます。
          </p>
        </div>
      </div>
      {loading ? (
        <p role="status">読み込み中…</p>
      ) : (
        !editing && (
          <>
            <div className="project-form-actions">
              <button
                type="button"
                onClick={() => {
                  setEditing({ id: '', name: '', prompt: '', members: [], leadership: 'caller' });
                  setNotice('');
                  setError('');
                  void requestJson<{ agents: Agent[] }>('/api/teams')
                    .then((r) => setAgents(r.agents || []))
                    .catch((e) => setError(String(e)));
                }}
              >
                チームを作成
              </button>
              <button type="button" className="secondary" onClick={() => void load()}>
                再読み込み
              </button>
            </div>
            {!teams.length && (
              <p>チームはまだありません。デフォルトの担当や登録済みエージェントで編成できます。</p>
            )}
            {teams.map((p) => (
              <div className="team-list-row" key={p.id}>
                <div>
                  <strong>{p.name}</strong>
                  <p>{p.members.length}名 · 呼び出し元がリーダー</p>
                </div>
                <div className="project-form-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setEditing(structuredClone(p));
                      setError('');
                      setNotice('');
                      void requestJson<{ agents: Agent[] }>('/api/teams')
                        .then((r) => setAgents(r.agents || []))
                        .catch((e) => setError(String(e)));
                    }}
                    aria-label={`${p.name}を編集`}
                  >
                    編集
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setDeleting(p)}
                    aria-label={`${p.name}を削除`}
                  >
                    削除
                  </button>
                </div>
              </div>
            ))}
          </>
        )
      )}
      {editing && (
        <form className="project-form" onSubmit={(e) => void save(e)}>
          <fieldset disabled={saving} className="team-editor">
            <legend>{editing.id ? 'チームを編集' : '新しいチーム'}</legend>
            <label>
              チーム名（必須）
              <input
                required
                maxLength={80}
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <p>
              呼び出し元が前提確認・分担・結果の取りまとめを担当します。チームには作業メンバーだけを登録します。
            </p>
            <label>
              同時実行数
              <input
                type="number"
                min={1}
                max={64}
                step={1}
                required
                value={Number.isNaN(editing.maxConcurrency) ? '' : (editing.maxConcurrency ?? 16)}
                onChange={(e) => setEditing({ ...editing, maxConcurrency: e.target.valueAsNumber })}
              />
            </label>
            <p>既定は16。同じチームの別会話も合わせた上限です。1〜64で指定できます。</p>
            <label>
              <input
                type="checkbox"
                checked={editing.serializeWorkspaces ?? false}
                onChange={(e) => setEditing({ ...editing, serializeWorkspaces: e.target.checked })}
              />
              同じ作業場所では順番に実行する
            </label>
            <p>
              通常は同じ作業場所でも並行実行します。同じファイルを編集する担当は分担するか、別の作業場所を指定してください。
            </p>
            <label>
              共通指示
              <textarea
                rows={3}
                maxLength={20000}
                value={editing.prompt}
                onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
              />
            </label>
            {editing.members.map((m, index) => (
              <fieldset className="team-member" key={m.agentId}>
                <legend>{agents.find((a) => a.id === m.agentId)?.name || m.agentId}</legend>
                <label>
                  チーム内の担当（任意）
                  <input
                    placeholder="未指定ならリーダーが分担"
                    maxLength={2000}
                    value={m.role}
                    onChange={(e) => changeMember(index, { role: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      members: editing.members
                        .filter((other) => other.agentId !== m.agentId)
                        .map((other) =>
                          other.reportsTo === m.agentId ? { ...other, reportsTo: undefined } : other
                        ),
                    })
                  }
                >
                  メンバーから外す
                </button>
              </fieldset>
            ))}
            <label>
              メンバーを追加
              <select
                value=""
                disabled={editing.members.length >= 64}
                onChange={(e) => {
                  const agent = agents.find((a) => a.id === e.target.value);
                  if (agent)
                    setEditing({
                      ...editing,
                      members: [...editing.members, { agentId: agent.id, role: '' }],
                    });
                }}
              >
                <option value="">Agentを選択（最大64名）</option>
                {agents
                  .filter((a) => !editing.members.some((m) => m.agentId === a.id))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
            <p>
              「デフォルト」は普段のxangiのAI設定と既定の作業場所を使います。登録済みエージェントは各自の設定を使い、同じ作業場所のメンバーは順番に実行します。
            </p>
            <div className="project-form-actions">
              <button type="submit" disabled={!editing.members.length}>
                {saving ? '保存中…' : 'チームを保存'}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing(undefined);
                  setError('');
                }}
              >
                キャンセル
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="チームを削除"
        description={`${deleting?.name || ''}を削除します。Agent自体は残ります。`}
        confirmLabel="削除"
        busy={saving}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(undefined)}
      />
    </section>
  );
}
