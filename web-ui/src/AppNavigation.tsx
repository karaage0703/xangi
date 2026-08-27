export type AppSurface = 'chat' | 'workspace' | 'schedules' | 'monitor' | 'extensions';

interface AppNavigationProps {
  current: AppSurface;
  moreOpen: boolean;
  onMore: () => void;
}

export const DESTINATIONS: Array<{
  id: AppSurface;
  href: string;
  label: string;
  icon: AppSurface;
  placement: 'primary' | 'secondary';
}> = [
  { id: 'chat', href: '/', label: 'チャット', icon: 'chat', placement: 'primary' },
  {
    id: 'workspace',
    href: '/workspace',
    label: 'ファイル',
    icon: 'workspace',
    placement: 'primary',
  },
  { id: 'monitor', href: '/monitor', label: '監視', icon: 'monitor', placement: 'primary' },
  {
    id: 'schedules',
    href: '/schedules',
    label: '予定',
    icon: 'schedules',
    placement: 'secondary',
  },
  {
    id: 'extensions',
    href: '/extensions',
    label: '拡張',
    icon: 'extensions',
    placement: 'secondary',
  },
];

export function NavigationIcon({ icon }: { icon: AppSurface | 'more' | 'close' }) {
  if (icon === 'chat') {
    return <path d="M5 6.5h14v9H9l-4 3v-12Z" />;
  }
  if (icon === 'workspace') {
    return <path d="M4.5 6.5h6l1.8 2H19.5v9h-15v-11Z" />;
  }
  if (icon === 'schedules') {
    return <path d="M6 4.5v3m12-3v3m-13.5 3h15m-14-5h13v14h-13v-14Z" />;
  }
  if (icon === 'monitor') {
    return <path d="M4 17.5h16M6 15l3.2-4 2.6 2.5L16 7l2 3" />;
  }
  if (icon === 'extensions') {
    return <path d="M8.5 4.5h3v4h4v3h4v4h-4v4h-4v-4h-4v-3h-4v-4h5v-4Z" />;
  }
  if (icon === 'close') {
    return <path d="m6 6 12 12M18 6 6 18" />;
  }
  return (
    <>
      <circle cx="6" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="18" cy="12" r="1" />
    </>
  );
}

function DestinationLink({
  destination,
  current,
}: {
  destination: (typeof DESTINATIONS)[number];
  current: AppSurface;
}) {
  return (
    <a
      className={current === destination.id ? 'active' : ''}
      aria-current={current === destination.id ? 'page' : undefined}
      href={destination.href}
    >
      <svg className="app-navigation-icon" viewBox="0 0 24 24" aria-hidden="true">
        <NavigationIcon icon={destination.icon} />
      </svg>
      <span>{destination.label}</span>
    </a>
  );
}

export function AppNavigation({ current, moreOpen, onMore }: AppNavigationProps) {
  const secondaryActive = DESTINATIONS.some(
    (destination) => destination.placement === 'secondary' && destination.id === current
  );

  return (
    <nav className="app-navigation" aria-label="xangiの主要機能">
      <div className="app-navigation-primary">
        {DESTINATIONS.filter((destination) => destination.placement === 'primary').map(
          (destination) => (
            <DestinationLink destination={destination} current={current} key={destination.id} />
          )
        )}
      </div>
      <div className="app-navigation-secondary">
        {DESTINATIONS.filter((destination) => destination.placement === 'secondary').map(
          (destination) => (
            <DestinationLink destination={destination} current={current} key={destination.id} />
          )
        )}
      </div>
      <button
        className={`app-more-trigger${secondaryActive ? ' active' : ''}`}
        type="button"
        aria-controls="app-more-sheet"
        aria-expanded={moreOpen}
        onClick={onMore}
      >
        <svg className="app-navigation-icon" viewBox="0 0 24 24" aria-hidden="true">
          <NavigationIcon icon="more" />
        </svg>
        <span>その他</span>
      </button>
    </nav>
  );
}
