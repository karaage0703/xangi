import { ExtensionView } from './ExtensionView';
import { MarkdownPreferencesProvider } from './MarkdownPreferences';
import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';

const pageLoaders = {
  chat: () => import('./Chat').then((m) => ({ default: m.Chat })),
  monitor: () => import('./Monitor').then((m) => ({ default: m.Monitor })),
  schedules: () => import('./Schedules').then((m) => ({ default: m.Schedules })),
  workspace: () => import('./Workspace').then((m) => ({ default: m.Workspace })),
  extensions: () => import('./Extensions').then((m) => ({ default: m.Extensions })),
  settings: () => import('./Settings').then((m) => ({ default: m.Settings })),
};

type Page = keyof typeof pageLoaders;
const pages = {
  chat: lazy(pageLoaders.chat),
  monitor: lazy(pageLoaders.monitor),
  schedules: lazy(pageLoaders.schedules),
  workspace: lazy(pageLoaders.workspace),
  extensions: lazy(pageLoaders.extensions),
  settings: lazy(pageLoaders.settings),
};

const extensionPath = /^\/extensions\/([^/]+)\/?$/;

function pageForPath(path: string): Page {
  if (path.startsWith('/monitor')) return 'monitor';
  if (path.startsWith('/schedules')) return 'schedules';
  if (path.startsWith('/workspace')) return 'workspace';
  if (path.startsWith('/extensions')) return 'extensions';
  if (path.startsWith('/settings')) return 'settings';
  return 'chat';
}

type InitialPage = { page: Page; component: ComponentType };

export function loadInitialPage(path: string): Promise<InitialPage> | undefined {
  if (extensionPath.test(path)) return;
  const page = pageForPath(path);
  return pageLoaders[page]().then(({ default: component }) => ({ page, component }));
}

export function App({ initialPage }: { initialPage?: InitialPage }) {
  return (
    <MarkdownPreferencesProvider>
      <AppContent initialPage={initialPage} />
    </MarkdownPreferencesProvider>
  );
}

function AppContent({ initialPage }: { initialPage?: InitialPage }) {
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
      if (url.origin !== location.origin || !extensionPath.test(url.pathname)) return;
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
  const extension = path.match(extensionPath);
  if (extension) return <ExtensionView id={extension[1]} />;
  const page = pageForPath(path);
  const Page = initialPage?.page === page ? initialPage.component : pages[page];
  return (
    <Suspense fallback={<div role="status">読み込み中…</div>}>
      <Page />
    </Suspense>
  );
}
