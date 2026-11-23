import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, loadInitialPage } from './App';
import { initializeTheme } from './ThemeSelect';
import './styles.css';
import { initializeHistory } from './appHistory';

initializeHistory();
initializeTheme();

const root = createRoot(document.getElementById('root')!);
const render = (initialPage?: Awaited<ReturnType<typeof loadInitialPage>>) =>
  root.render(
    <StrictMode>
      <App initialPage={initialPage} />
    </StrictMode>
  );

// Let the HTML provide the initial loading state until the route is ready.
// Suspense still handles route changes after the first render.
const initialPage = loadInitialPage(window.location.pathname);
if (initialPage) void initialPage.then(render, () => render());
else render();
