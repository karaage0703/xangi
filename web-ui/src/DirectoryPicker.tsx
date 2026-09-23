import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson } from './api';

interface DirectoryListing {
  path: string;
  parent: string | null;
  roots: string[];
  directories: Array<{ name: string; path: string }>;
}

export function DirectoryPicker({
  open,
  initialPath,
  onCancel,
  onSelect,
}: {
  open: boolean;
  initialPath: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<DirectoryListing>();
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const load = useCallback(async (nextPath: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await getJson<DirectoryListing>(
        `/api/workspaces/directories?path=${encodeURIComponent(nextPath)}`
      );
      setListing(result);
      setPath(result.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setListing(undefined);
    setPath(initialPath);
    void load(initialPath);
  }, [initialPath, load, open]);

  return (
    <dialog
      ref={ref}
      className="directory-picker"
      aria-labelledby="directory-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <header>
        <h2 id="directory-picker-title">サーバーのフォルダを選択</h2>
        <button type="button" aria-label="閉じる" onClick={onCancel}>
          ×
        </button>
      </header>
      <p>ここに表示されるのはxangiが動いているマシンのフォルダです。</p>
      <form
        className="directory-picker-path"
        onSubmit={(event) => {
          event.preventDefault();
          void load(path);
        }}
      >
        <label htmlFor="directory-picker-path">現在のパス</label>
        <div>
          <input
            id="directory-picker-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            aria-label="フォルダのパス"
          />
          <button type="submit" disabled={busy}>
            移動
          </button>
        </div>
      </form>
      {error && (
        <p className="directory-picker-error" role="alert">
          {error}
        </p>
      )}
      {listing && listing.roots.length > 1 && (
        <div className="directory-picker-roots" aria-label="選択できる場所">
          {listing.roots.map((root) => (
            <button type="button" key={root} onClick={() => void load(root)} disabled={busy}>
              {root}
            </button>
          ))}
        </div>
      )}
      <div className="directory-picker-list" aria-label="サブフォルダ">
        {listing?.parent && (
          <button type="button" onClick={() => void load(listing.parent!)} disabled={busy}>
            ↑ 親フォルダ
          </button>
        )}
        {listing?.directories.map((directory) => (
          <button
            type="button"
            key={directory.path}
            onClick={() => void load(directory.path)}
            disabled={busy}
          >
            📁 {directory.name}
          </button>
        ))}
        {!busy && listing?.directories.length === 0 && <span>サブフォルダはありません</span>}
        {busy && <span>読み込み中…</span>}
      </div>
      <footer>
        <button type="button" onClick={onCancel}>
          キャンセル
        </button>
        <button
          type="button"
          className="primary"
          disabled={!listing || busy || path !== listing.path}
          onClick={() => listing && onSelect(listing.path)}
        >
          このフォルダを選択
        </button>
      </footer>
    </dialog>
  );
}
