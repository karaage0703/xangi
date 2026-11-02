import { useEffect, useState } from 'react';
import { getJsonWithTimeout } from './api';

interface Channel {
  id: string;
  name: string;
  group?: string;
}

interface ChannelsResponse {
  status: 'available' | 'starting' | 'disabled' | 'unavailable';
  channels: Channel[];
  message?: string;
}

const MANUAL = '__manual__';

export function ScheduleDestination({
  platform,
  channelId,
  onChange,
}: {
  platform: 'discord' | 'slack';
  channelId: string;
  onChange: (id: string) => void;
}) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [forceManual, setForceManual] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotice('');
    void getJsonWithTimeout<ChannelsResponse>(
      `/api/runtime-settings/channels?platform=${platform}`,
      15_000,
      'チャンネル一覧の取得がタイムアウトしました。'
    )
      .then((data) => {
        if (!active) return;
        setChannels(data.channels);
        setNotice(
          data.message || (data.channels.length ? '' : '選択できるチャンネルがありません。')
        );
      })
      .catch((error) => {
        if (!active) return;
        setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [platform, revision]);

  // Keep destinations absent from the list (including threads) editable without replacing their ID.
  const manual = forceManual || Boolean(channelId && !channels.some((c) => c.id === channelId));

  return (
    <>
      <label>
        <span>送信先チャンネル</span>
        <select
          required
          value={manual ? MANUAL : channelId}
          onChange={(event) => {
            const value = event.target.value;
            setForceManual(value === MANUAL);
            if (value !== MANUAL) onChange(value);
          }}
        >
          <option value="">{loading ? 'チャンネルを読み込み中…' : 'チャンネルを選択'}</option>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.group ? `${channel.group} / ` : ''}
              {channel.name} ({channel.id})
            </option>
          ))}
          <option value={MANUAL}>IDを直接指定（スレッドなど）</option>
        </select>
        <small>一覧にない送信先は「IDを直接指定」で設定できます。</small>
      </label>
      {manual && (
        <label>
          <span>送信先ID</span>
          <input
            required
            value={channelId}
            onChange={(event) => onChange(event.target.value)}
            placeholder={
              platform === 'discord'
                ? 'チャンネルまたはスレッドID'
                : 'チャンネルID または チャンネルID:スレッドのts'
            }
          />
        </label>
      )}
      {notice && <p role="status">{notice} IDを直接指定することもできます。</p>}
      <button
        type="button"
        className="button"
        disabled={loading}
        onClick={() => setRevision((v) => v + 1)}
      >
        チャンネル一覧を再読み込み
      </button>
    </>
  );
}
