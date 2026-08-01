import { Chat } from './Chat';
import { Monitor } from './Monitor';
import { Schedules } from './Schedules';
import { Workspace } from './Workspace';

export function App() {
  if (window.location.pathname.startsWith('/monitor')) return <Monitor />;
  if (window.location.pathname.startsWith('/schedules')) return <Schedules />;
  if (window.location.pathname.startsWith('/workspace')) return <Workspace />;
  return <Chat />;
}
