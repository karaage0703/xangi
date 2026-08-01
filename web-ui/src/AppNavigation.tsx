type AppSurface = 'chat' | 'workspace' | 'schedules' | 'monitor';

interface AppNavigationProps {
  current: AppSurface;
}

const DESTINATIONS: Array<{
  id: AppSurface;
  href: string;
  label: string;
}> = [
  { id: 'chat', href: '/', label: 'チャット' },
  { id: 'workspace', href: '/workspace', label: 'ファイル' },
  { id: 'schedules', href: '/schedules', label: '予定' },
  { id: 'monitor', href: '/monitor', label: '監視' },
];

export function AppNavigation({ current }: AppNavigationProps) {
  return (
    <nav className="app-navigation" aria-label="xangiの主要機能">
      {DESTINATIONS.map((destination) => (
        <a
          className={current === destination.id ? 'active' : ''}
          aria-current={current === destination.id ? 'page' : undefined}
          href={destination.href}
          key={destination.id}
        >
          <span>{destination.label}</span>
        </a>
      ))}
    </nav>
  );
}
