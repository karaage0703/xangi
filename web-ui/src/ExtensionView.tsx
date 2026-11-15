import { useCallback, useEffect, useRef, useState } from 'react';
import { AppTopbar } from './AppTopbar';

export function ExtensionView({ id }: { id: string }) {
  return (
    <main className="extension-view">
      <AppTopbar current="extensions" includeFrameHistory />
      <ExtensionFrame key={id} id={id} />
    </main>
  );
}

function ExtensionFrame({ id }: { id: string }) {
  const [loading, setLoading] = useState(true);
  const frame = useRef<HTMLIFrameElement>(null);
  const syncAppearance = useCallback(() => {
    try {
      const root = frame.current?.contentDocument?.documentElement;
      if (!root) return;
      root.dataset.xangiEmbedded = 'true';
      const theme = document.documentElement.dataset.theme;
      if (theme === 'light' || theme === 'dark') {
        root.dataset.theme = theme;
        root.style.colorScheme = theme;
      }
    } catch {
      // Appearance hints are available only to same-origin extension documents.
    }
  }, []);
  useEffect(() => {
    const observer = new MutationObserver(syncAppearance);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, [syncAppearance]);
  return (
    <div className="extension-frame">
      {loading ? <p role="status">拡張を読み込み中…</p> : null}
      <iframe
        ref={frame}
        title="拡張機能"
        src={`/api/extensions/${id}/ui`}
        onLoad={() => {
          syncAppearance();
          setLoading(false);
        }}
      />
    </div>
  );
}
