import { Chat } from './Chat';
import { Monitor } from './Monitor';
import { Workspace } from './Workspace';

export function App() {
  if (window.location.pathname.startsWith('/monitor')) return <Monitor />;
  if (window.location.pathname.startsWith('/workspace')) return <Workspace />;
  return <Chat />;
}
