import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initializeTheme } from './ThemeSelect';
import './styles.css';
import { initializeHistory } from './appHistory';

initializeHistory();
initializeTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
