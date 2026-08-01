import { AppNavigation } from './AppNavigation';
import { ThemeSelect } from './ThemeSelect';

type AppSurface = 'chat' | 'workspace' | 'schedules' | 'monitor';

export function AppTopbar({ current }: { current: AppSurface }) {
  return (
    <header className="app-topbar">
      <div className="app-page-navigation">
        <a className="brand" href="/">
          xangi
        </a>
        <AppNavigation current={current} />
      </div>
      <ThemeSelect />
    </header>
  );
}
