import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, requestJson } from './api';

export interface ExtensionFavorite {
  id: string;
  displayName: string;
  available: boolean;
}
const changedEvent = 'xangi-extension-favorites-changed';

export function useExtensionFavorites() {
  const [favorites, setFavorites] = useState<ExtensionFavorite[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await getJson<{ favorites: ExtensionFavorite[] }>('/api/extension-favorites');
      if (current === generation.current) {
        setFavorites(result.favorites);
        setError('');
      }
    } catch {
      if (current === generation.current)
        setError('お気に入りを読み込めません。再確認してください。');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const reload = () => {
      void refresh();
    };
    reload();
    window.addEventListener(changedEvent, reload);
    window.addEventListener('focus', reload);
    return () => {
      generation.current++;
      window.removeEventListener(changedEvent, reload);
      window.removeEventListener('focus', reload);
    };
  }, [refresh]);
  const update = async (id: string, action: 'add' | 'remove' | 'up' | 'down') => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      await requestJson('/api/extension-favorites', {
        method: 'POST',
        body: JSON.stringify({ id, action }),
      });
      window.dispatchEvent(new Event(changedEvent));
      await refresh();
    } catch {
      setError('お気に入りを保存できませんでした。再確認してからやり直してください。');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return { favorites, error, loading, saving, refresh, update };
}

export function FavoriteLinks({ favorites }: { favorites: ExtensionFavorite[] }) {
  return (
    <>
      {favorites.map((favorite) => (
        <a
          key={favorite.id}
          href={
            favorite.available
              ? `/api/extensions/${encodeURIComponent(favorite.id)}/ui`
              : '/extensions'
          }
          title={`${favorite.displayName}${favorite.available ? '' : '（拡張一覧で状態を確認）'}`}
        >
          <svg className="app-navigation-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />
          </svg>
          <span>{favorite.displayName}</span>
        </a>
      ))}
    </>
  );
}
