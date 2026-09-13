import { Chat } from './Chat';
import { Monitor } from './Monitor';
import { Schedules } from './Schedules';
import { Workspace } from './Workspace';
import { Extensions } from './Extensions';
import { Settings } from './Settings';

export function App() {
  if (window.location.pathname.startsWith('/monitor')) return <Monitor />;
  if (window.location.pathname.startsWith('/schedules')) return <Schedules />;
  if (window.location.pathname.startsWith('/workspace')) return <Workspace />;
  if (window.location.pathname.startsWith('/extensions')) return <Extensions />;
  if (window.location.pathname.startsWith('/settings')) return <Settings />;
  return <Chat />;
}
