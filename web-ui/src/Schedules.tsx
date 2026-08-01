import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTime, getJson, platformLabel, requestJson } from './api';
import { AppTopbar } from './AppTopbar';
import type { ProjectsResponse, Schedule, SchedulesResponse, WebProject } from './types';

type ScheduleMode = 'once' | 'daily' | 'weekly' | 'cron' | 'startup';
type SchedulePlatform = 'web' | 'discord' | 'slack' | 'telegram';
type ScheduleFilter = 'all' | SchedulePlatform;

const PLATFORM_OPTIONS: Array<{ value: SchedulePlatform; label: string }> = [
  { value: 'web', label: 'Web' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'telegram', label: 'Telegram' },
];

const WEEKDAYS = [
  { value: '1', label: '月曜' },
  { value: '2', label: '火曜' },
  { value: '3', label: '水曜' },
  { value: '4', label: '木曜' },
  { value: '5', label: '金曜' },
  { value: '6', label: '土曜' },
  { value: '0', label: '日曜' },
];

function initialRunAt(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function localDateTimeInput(value?: string): string {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function cronDescription(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, day, month, weekday] = parts;
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (day === '*' && month === '*' && weekday === '*') return `毎日 ${time}`;
  if (day === '*' && month === '*' && /^[0-6]$/.test(weekday)) {
    const label = WEEKDAYS.find((item) => item.value === weekday)?.label || weekday;
    return `毎週${label} ${time}`;
  }
  return expression;
}

function timingLabel(schedule: Schedule): string {
  if (schedule.type === 'startup') return 'xangi起動時';
  if (schedule.type === 'once') return formatDateTime(schedule.runAt) || '日時未設定';
  return cronDescription(schedule.expression || '');
}

function schedulePayload(input: {
  mode: ScheduleMode;
  platform: SchedulePlatform;
  channelId: string;
  projectId: string;
  label: string;
  message: string;
  runAt: string;
  time: string;
  weekday: string;
  expression: string;
}) {
  const [hour = '0', minute = '0'] = input.time.split(':');
  if (input.mode === 'once') {
    return {
      platform: input.platform,
      channelId: input.channelId,
      projectId: input.platform === 'web' ? input.projectId : undefined,
      type: 'once',
      runAt: new Date(input.runAt).toISOString(),
      label: input.label,
      message: input.message,
    };
  }
  if (input.mode === 'startup') {
    return {
      platform: input.platform,
      channelId: input.channelId,
      projectId: input.platform === 'web' ? input.projectId : undefined,
      type: 'startup',
      label: input.label,
      message: input.message,
    };
  }
  const expression =
    input.mode === 'daily'
      ? `${Number(minute)} ${Number(hour)} * * *`
      : input.mode === 'weekly'
        ? `${Number(minute)} ${Number(hour)} * * ${input.weekday}`
        : input.expression;
  return {
    platform: input.platform,
    channelId: input.channelId,
    projectId: input.platform === 'web' ? input.projectId : undefined,
    type: 'cron',
    expression,
    label: input.label,
    message: input.message,
  };
}

function timingForm(schedule: Schedule): {
  mode: ScheduleMode;
  runAt: string;
  time: string;
  weekday: string;
  expression: string;
} {
  if (schedule.type === 'once') {
    return {
      mode: 'once',
      runAt: localDateTimeInput(schedule.runAt),
      time: '09:00',
      weekday: '1',
      expression: '0 9 * * *',
    };
  }
  if (schedule.type === 'startup') {
    return {
      mode: 'startup',
      runAt: initialRunAt(),
      time: '09:00',
      weekday: '1',
      expression: '0 9 * * *',
    };
  }
  const expression = schedule.expression || '0 9 * * *';
  const parts = expression.trim().split(/\s+/);
  if (parts.length === 5) {
    const [minute, hour, day, month, weekday] = parts;
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    if (day === '*' && month === '*' && weekday === '*') {
      return { mode: 'daily', runAt: initialRunAt(), time, weekday: '1', expression };
    }
    if (day === '*' && month === '*' && /^[0-6]$/.test(weekday)) {
      return { mode: 'weekly', runAt: initialRunAt(), time, weekday, expression };
    }
  }
  return {
    mode: 'cron',
    runAt: initialRunAt(),
    time: '09:00',
    weekday: '1',
    expression,
  };
}

export function Schedules() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [projects, setProjects] = useState<WebProject[]>([]);
  const [schedulerEnabled, setSchedulerEnabled] = useState(true);
  const [startupEnabled, setStartupEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState<ScheduleFilter>('all');
  const [editingId, setEditingId] = useState('');
  const [platform, setPlatform] = useState<SchedulePlatform>('web');
  const [mode, setMode] = useState<ScheduleMode>('once');
  const [channelId, setChannelId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [label, setLabel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [runAt, setRunAt] = useState(initialRunAt);
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState('1');
  const [expression, setExpression] = useState('0 9 * * *');

  const load = useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const [scheduleData, projectData] = await Promise.all([
        getJson<SchedulesResponse>('/api/schedules'),
        getJson<ProjectsResponse>('/api/projects'),
      ]);
      setSchedules(scheduleData.schedules);
      setSchedulerEnabled(scheduleData.enabled);
      setStartupEnabled(scheduleData.startupEnabled);
      setProjects(projectData.projects);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  );
  const visibleSchedules = useMemo(
    () =>
      schedules.filter((schedule) => {
        return filter === 'all' || schedule.platform === filter;
      }),
    [filter, schedules]
  );
  const activeCount = schedules.filter((schedule) => schedule.enabled).length;

  const resetForm = () => {
    setEditingId('');
    setPlatform('web');
    setMode('once');
    setChannelId('');
    setProjectId('');
    setLabel('');
    setPrompt('');
    setRunAt(initialRunAt());
    setTime('09:00');
    setWeekday('1');
    setExpression('0 9 * * *');
  };

  const submitSchedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if ((platform !== 'web' && !channelId.trim()) || !prompt.trim() || saving) return;
    setSaving(true);
    setMessage('');
    try {
      const result = await requestJson<{ schedule: Schedule }>(
        editingId ? `/api/schedules/${editingId}` : '/api/schedules',
        {
          method: editingId ? 'PATCH' : 'POST',
          body: JSON.stringify(
            schedulePayload({
              mode,
              platform,
              channelId: channelId.trim(),
              projectId,
              label: label.trim(),
              message: prompt.trim(),
              runAt,
              time,
              weekday,
              expression: expression.trim(),
            })
          ),
        }
      );
      setSchedules((current) =>
        editingId
          ? current.map((item) => (item.id === editingId ? result.schedule : item))
          : [...current, result.schedule]
      );
      setMessage(editingId ? 'スケジュールを更新しました。' : 'スケジュールを追加しました。');
      resetForm();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const edit = (schedule: Schedule) => {
    const timing = timingForm(schedule);
    setEditingId(schedule.id);
    setPlatform(schedule.platform as SchedulePlatform);
    setChannelId(schedule.platform === 'web' ? '' : schedule.channelId);
    setProjectId(schedule.projectId || '');
    setLabel(schedule.label || '');
    setPrompt(schedule.message);
    setMode(timing.mode);
    setRunAt(timing.runAt);
    setTime(timing.time);
    setWeekday(timing.weekday);
    setExpression(timing.expression);
    setMessage('');
    requestAnimationFrame(() => {
      document.querySelector('.schedule-create')?.scrollIntoView({ behavior: 'smooth' });
    });
  };

  const setEnabled = async (schedule: Schedule, enabled: boolean) => {
    setMessage('');
    try {
      const result = await requestJson<{ schedule: Schedule }>(`/api/schedules/${schedule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      setSchedules((current) =>
        current.map((item) => (item.id === schedule.id ? result.schedule : item))
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (schedule: Schedule) => {
    const name = schedule.label || timingLabel(schedule);
    if (!window.confirm(`「${name}」を削除しますか？`)) return;
    setMessage('');
    try {
      await requestJson(`/api/schedules/${schedule.id}`, { method: 'DELETE' });
      setSchedules((current) => current.filter((item) => item.id !== schedule.id));
      if (editingId === schedule.id) resetForm();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main className="schedules-page">
      <AppTopbar current="schedules" />
      <div className="schedules-content">
        <header className="schedules-header">
          <div>
            <p className="schedules-eyebrow">AUTOMATION</p>
            <h1>予定</h1>
            <p>決まった時刻に、Web・Discord・Slack・Telegramへ仕事を依頼します。</p>
          </div>
          <dl className="schedules-summary" aria-label="スケジュール集計">
            <div>
              <dt>有効</dt>
              <dd>{activeCount}</dd>
            </div>
            <div>
              <dt>停止中</dt>
              <dd>{schedules.length - activeCount}</dd>
            </div>
            <div>
              <dt>合計</dt>
              <dd>{schedules.length}</dd>
            </div>
          </dl>
        </header>

        {!schedulerEnabled && (
          <div className="schedules-notice error" role="alert">
            スケジューラが無効です。設定を有効にするまで予定は実行されません。
          </div>
        )}
        {!startupEnabled && mode === 'startup' && (
          <div className="schedules-notice" role="status">
            起動時タスクは現在無効です。
          </div>
        )}
        {message && (
          <div className="schedules-notice" role="status">
            {message}
          </div>
        )}

        <div className="schedules-layout">
          <section className="schedule-create" aria-labelledby="schedule-create-title">
            <div className="schedule-section-heading">
              <div>
                <p>NEW SCHEDULE</p>
                <h2 id="schedule-create-title">{editingId ? '予定を編集' : '予定を追加'}</h2>
              </div>
            </div>
            <form onSubmit={(event) => void submitSchedule(event)}>
              <label>
                <span>プラットフォーム</span>
                <select
                  required
                  value={platform}
                  onChange={(event) => {
                    setPlatform(event.target.value as SchedulePlatform);
                    setChannelId('');
                    setProjectId('');
                  }}
                >
                  {PLATFORM_OPTIONS.map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {platform === 'web' ? (
                <label>
                  <span>プロジェクト（任意）</span>
                  <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                    <option value="">プロジェクトなし</option>
                    {projects.map((project) => (
                      <option value={project.id} key={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  <small>実行するたびに、選んだプロジェクトへ新しいWeb会話を作ります。</small>
                </label>
              ) : (
                <label>
                  <span>送信先ID</span>
                  <input
                    required
                    value={channelId}
                    onChange={(event) => setChannelId(event.target.value)}
                    placeholder={
                      platform === 'discord'
                        ? 'チャンネルまたはスレッドID'
                        : platform === 'slack'
                          ? 'チャンネルID'
                          : 'チャットID'
                    }
                  />
                </label>
              )}

              <label>
                <span>実行タイミング</span>
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as ScheduleMode)}
                >
                  <option value="once">1回だけ</option>
                  <option value="daily">毎日</option>
                  <option value="weekly">毎週</option>
                  <option value="cron">Cron式</option>
                  <option value="startup">xangi起動時</option>
                </select>
              </label>

              {mode === 'once' && (
                <label>
                  <span>日時</span>
                  <input
                    required
                    type="datetime-local"
                    value={runAt}
                    onChange={(event) => setRunAt(event.target.value)}
                  />
                </label>
              )}
              {(mode === 'daily' || mode === 'weekly') && (
                <div className="schedule-inline-fields">
                  {mode === 'weekly' && (
                    <label>
                      <span>曜日</span>
                      <select value={weekday} onChange={(event) => setWeekday(event.target.value)}>
                        {WEEKDAYS.map((day) => (
                          <option value={day.value} key={day.value}>
                            {day.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    <span>時刻</span>
                    <input
                      required
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                    />
                  </label>
                </div>
              )}
              {mode === 'cron' && (
                <label>
                  <span>Cron式</span>
                  <input
                    required
                    value={expression}
                    onChange={(event) => setExpression(event.target.value)}
                    placeholder="0 9 * * *"
                  />
                  <small>分 時 日 月 曜日の順。時刻はサーバーのタイムゾーンです。</small>
                </label>
              )}

              <label>
                <span>名前（任意）</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="朝のニュース確認"
                />
              </label>
              <label>
                <span>実行内容</span>
                <textarea
                  required
                  rows={5}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="今日の予定と重要な連絡を確認して報告して"
                />
              </label>
              <div className="schedule-form-actions">
                <button
                  className="button primary schedule-submit"
                  disabled={saving || (platform !== 'web' && !channelId.trim())}
                >
                  {saving ? '保存中…' : editingId ? '変更を保存' : '予定を追加'}
                </button>
                {editingId && (
                  <button className="button schedule-cancel" type="button" onClick={resetForm}>
                    キャンセル
                  </button>
                )}
              </div>
            </form>
          </section>

          <section className="schedule-list-section" aria-labelledby="schedule-list-title">
            <div className="schedule-section-heading schedule-list-heading">
              <div>
                <p>ALL SCHEDULES</p>
                <h2 id="schedule-list-title">設定済み</h2>
              </div>
              <div className="schedule-filters" aria-label="予定の絞り込み">
                {(
                  [
                    ['all', 'すべて'],
                    ['web', 'Web'],
                    ['discord', 'Discord'],
                    ['slack', 'Slack'],
                    ['telegram', 'Telegram'],
                  ] as const
                ).map(([value, text]) => (
                  <button
                    type="button"
                    className={filter === value ? 'active' : ''}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    key={value}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <p className="schedule-empty">読み込み中…</p>
            ) : visibleSchedules.length === 0 ? (
              <p className="schedule-empty">この条件の予定はありません。</p>
            ) : (
              <div className="schedule-list">
                {visibleSchedules.map((schedule) => (
                  <article
                    className={schedule.enabled ? 'schedule-row' : 'schedule-row paused'}
                    key={schedule.id}
                  >
                    <div className="schedule-row-main">
                      <div className="schedule-row-title">
                        <strong>{schedule.label || timingLabel(schedule)}</strong>
                        <span>{schedule.enabled ? '有効' : '停止中'}</span>
                      </div>
                      <p>{schedule.message}</p>
                      <div className="schedule-row-meta">
                        <span>{timingLabel(schedule)}</span>
                        <span>{platformLabel(schedule.platform)}</span>
                        <span>
                          {schedule.platform === 'web'
                            ? schedule.channelId === '__new__'
                              ? schedule.projectId
                                ? `新しい会話 / ${projectNames.get(schedule.projectId) || schedule.projectId}`
                                : '新しい会話'
                              : `既存会話 / ${schedule.channelId}`
                            : schedule.channelId}
                        </span>
                      </div>
                    </div>
                    <div className="schedule-row-actions">
                      <label className="schedule-toggle">
                        <span className="sr-only">
                          {schedule.enabled ? '停止する' : '有効にする'}
                        </span>
                        <input
                          type="checkbox"
                          checked={schedule.enabled}
                          onChange={(event) => void setEnabled(schedule, event.target.checked)}
                        />
                        <span aria-hidden="true" />
                      </label>
                      <button
                        className="schedule-edit"
                        type="button"
                        onClick={() => edit(schedule)}
                      >
                        編集
                      </button>
                      <button
                        className="schedule-delete"
                        type="button"
                        onClick={() => void remove(schedule)}
                      >
                        削除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
