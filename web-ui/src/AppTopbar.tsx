import { useEffect, useState } from 'react';
import { AppNavigation, DESTINATIONS, NavigationIcon, type AppSurface } from './AppNavigation';
import { ThemeControl, useThemePreference } from './ThemeSelect';

export function AppTopbar({ current }: { current: AppSurface }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [themePreference, setThemePreference] = useThemePreference();

  useEffect(() => {
    if (!moreOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moreOpen]);

  return (
    <>
      <header className="app-topbar">
        <div className="app-page-navigation">
          <a className="brand" href="/" aria-label="xangi チャット">
            <span aria-hidden="true">x</span>
          </a>
          <AppNavigation
            current={current}
            moreOpen={moreOpen}
            onMore={() => setMoreOpen((open) => !open)}
          />
        </div>
        <div className="app-rail-theme">
          <ThemeControl variant="rail" preference={themePreference} onChange={setThemePreference} />
        </div>
      </header>
      {moreOpen ? (
        <>
          <button
            className="app-more-scrim"
            type="button"
            aria-label="その他メニューを閉じる"
            onClick={() => setMoreOpen(false)}
          />
          <aside
            className="app-more-sheet"
            id="app-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-more-heading"
          >
            <div className="app-more-heading-row">
              <h2 id="app-more-heading">その他</h2>
              <button
                className="app-more-close"
                type="button"
                aria-label="閉じる"
                autoFocus
                onClick={() => setMoreOpen(false)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <NavigationIcon icon="close" />
                </svg>
              </button>
            </div>
            <nav className="app-more-links" aria-label="その他の機能">
              {DESTINATIONS.filter((destination) => destination.placement === 'secondary').map(
                (destination) => (
                  <a
                    className={current === destination.id ? 'active' : ''}
                    aria-current={current === destination.id ? 'page' : undefined}
                    href={destination.href}
                    key={destination.id}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <NavigationIcon icon={destination.icon} />
                    </svg>
                    <span>{destination.label}</span>
                  </a>
                )
              )}
            </nav>
            <ThemeControl
              variant="sheet"
              preference={themePreference}
              onChange={setThemePreference}
            />
          </aside>
        </>
      ) : null}
    </>
  );
}
