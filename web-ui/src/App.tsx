import { ExtensionView } from './ExtensionView';
import { MarkdownPreferencesProvider } from './MarkdownPreferences';
import { lazy, Suspense, useEffect, useState } from 'react';
const Chat = lazy(() => import('./Chat').then((m) => ({ default: m.Chat })));
const Monitor = lazy(() => import('./Monitor').then((m) => ({ default: m.Monitor })));
const Schedules = lazy(() => import('./Schedules').then((m) => ({ default: m.Schedules })));
const Workspace = lazy(() => import('./Workspace').then((m) => ({ default: m.Workspace })));
const Extensions = lazy(() => import('./Extensions').then((m) => ({ default: m.Extensions })));
const Settings = lazy(() => import('./Settings').then((m) => ({ default: m.Settings })));

export function App() {
  return (
    <MarkdownPreferencesProvider>
      <AppContent />
    </MarkdownPreferencesProvider>
  );
}

function AppContent() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = (event.target as Element).closest?.('a');
      if (!link || link.target || link.hasAttribute('download')) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || !/^\/extensions\/[^/]+\/?$/.test(url.pathname)) return;
      event.preventDefault();
      if (url.href !== location.href) history.pushState(null, '', url);
      update();
    };
    window.addEventListener('popstate', update);
    document.addEventListener('click', navigate);
    return () => {
      window.removeEventListener('popstate', update);
      document.removeEventListener('click', navigate);
    };
  }, []);
  const extension = path.match(/^\/extensions\/([^/]+)\/?$/);
  if (extension) return <ExtensionView id={extension[1]} />;
  const Page = path.startsWith('/monitor')
    ? Monitor
    : path.startsWith('/schedules')
      ? Schedules
      : path.startsWith('/workspace')
        ? Workspace
        : path.startsWith('/extensions')
          ? Extensions
          : path.startsWith('/settings')
            ? Settings
            : Chat;
  return (
    <Suspense fallback={<div role="status">読み込み中…</div>}>
      <Page />
    </Suspense>
  );
}
