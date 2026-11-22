import { useRef, useState, type ChangeEvent } from 'react';
import { requestJson } from './api';
import { jsonInit } from './chatPresentation';

export function AgentAvatar({
  name,
  url,
  petPortraitUrl,
}: {
  name: string;
  url?: string;
  petPortraitUrl?: string;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const custom = url && !failed.includes(url) ? url : undefined;
  const portrait =
    !custom && petPortraitUrl && !failed.includes(petPortraitUrl) ? petPortraitUrl : undefined;
  const image = custom || portrait;
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() || '?';

  return (
    <span className="agent-avatar" aria-hidden="true">
      {image ? (
        <img
          key={image}
          className={portrait ? 'agent-avatar-pet' : undefined}
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed((current) => [...current, image])}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (portrait && (naturalWidth !== 1536 || naturalHeight !== 1872))
              setFailed((current) => [...current, image]);
          }}
        />
      ) : (
        initial
      )}
    </span>
  );
}

async function avatarPng(file: File): Promise<string> {
  if (file.size > 12 * 1024 * 1024) throw new Error('12 MB 以下の画像を選んでください。');
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    try {
      await image.decode();
    } catch {
      throw new Error('画像を読み込めません。PNG・JPEG・WebP の画像を選んでください。');
    }
    const { naturalWidth: width, naturalHeight: height } = image;
    const side = Math.min(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('画像を変換できませんでした。');
    context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 128, 128);
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
  } finally {
    URL.revokeObjectURL(source);
  }
}

export function AgentAvatarSettings({
  agentId,
  name,
  url,
  petPortraitUrl,
  onSaved,
}: {
  agentId: string;
  name: string;
  url?: string;
  petPortraitUrl?: string;
  onSaved: (url: string | undefined) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const endpoint = `/api/agents/${encodeURIComponent(agentId)}/avatar`;

  async function changeAvatar(file?: File) {
    setPending(true);
    setNotice('');
    setError('');
    try {
      const { avatarUrl } = await requestJson<{ avatarUrl: string | null }>(
        endpoint,
        file ? jsonInit('PUT', { png: await avatarPng(file) }) : { method: 'DELETE' }
      );
      onSaved(avatarUrl || undefined);
      setNotice(file ? 'アバターを保存しました。' : 'アバターを初期表示に戻しました。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void changeAvatar(file);
  }

  return (
    <fieldset className="agent-avatar-settings" disabled={pending}>
      <legend>アバター</legend>
      <div className="agent-avatar-preview">
        <AgentAvatar name={name} url={url} petPortraitUrl={petPortraitUrl} />
        <button type="button" onClick={() => picker.current?.click()}>
          画像を選ぶ
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={selectImage}
          hidden
        />
      </div>
      <small>画像の中央を正方形に切り抜き、選ぶとすぐに保存します。</small>
      {url && (
        <button type="button" onClick={() => void changeAvatar()}>
          初期表示に戻す
        </button>
      )}
      {pending && <p role="status">保存中…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
