import { MarkdownPreferencesProvider } from './MarkdownPreferences';
import { lazy, Suspense } from 'react';
const Chat = lazy(() => import('./Chat').then((m) => ({ default: m.Chat })));
const Monitor = lazy(() => import('./Monitor').then((m) => ({ default: m.Monitor })));
const Schedules = lazy(() => import('./Schedules').then((m) => ({ default: m.Schedules })));
const Workspace = lazy(() => import('./Workspace').then((m) => ({ default: m.Workspace })));
const Extensions = lazy(() => import('./Extensions').then((m) => ({ default: m.Extensions })));
const Settings = lazy(() => import('./Settings').then((m) => ({ default: m.Settings })));

export function App() {
  const path = window.location.pathname;
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
    <MarkdownPreferencesProvider>
      <Suspense fallback={<div role="status">読み込み中…</div>}>
        <Page />
      </Suspense>
    </MarkdownPreferencesProvider>
  );
}
