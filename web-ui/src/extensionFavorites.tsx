import { useCallback, useEffect, useRef, useState } from 'react';
import { ExtensionIcon } from './ExtensionIcon';
import { getJson, requestJson } from './api';

export interface ExtensionFavorite {
  id: string;
  displayName: string;
  available: boolean;
  showInSidebar?: boolean;
  defaultDisplayName?: string;
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
  const update = async (
    id: string,
    action: 'add' | 'remove' | 'up' | 'down' | 'rename' | 'set-sidebar',
    displayName?: string,
    showInSidebar?: boolean
  ) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      await requestJson('/api/extension-favorites', {
        method: 'POST',
        body: JSON.stringify({ id, action, displayName, showInSidebar }),
      });
      window.dispatchEvent(new Event(changedEvent));
      await refresh();
      return true;
    } catch {
      setError('お気に入りを保存できませんでした。再確認してからやり直してください。');
      return false;
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
      {favorites
        .filter((favorite) => favorite.showInSidebar !== false)
        .map((favorite) => (
          <a
            className="extension-favorite-link"
            aria-label={favorite.displayName}
            key={favorite.id}
            href={
              favorite.available
                ? `/api/extensions/${encodeURIComponent(favorite.id)}/ui`
                : '/extensions'
            }
            title={`${favorite.displayName}${favorite.available ? '' : '（拡張一覧で状態を確認）'}`}
          >
            <ExtensionIcon id={favorite.id} />
            <span>{favorite.displayName}</span>
          </a>
        ))}
    </>
  );
}
