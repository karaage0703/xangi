import { sessionIdFromPathname } from './sessionPermalink';

const MAX_PANES = 8;
const PANE_STATE_KEY = 'xangi_pane_state_v1';

export interface PaneDescriptor {
  key: string;
  sessionId: string | null;
}

let paneSequence = 0;

function createPane(sessionId: string | null): PaneDescriptor {
  return { key: `pane-${++paneSequence}`, sessionId };
}

export function restorePanes(): { panes: PaneDescriptor[]; activeKey: string } {
  const linkedSessionId = sessionIdFromPathname(window.location.pathname);
  if (linkedSessionId) {
    const pane = createPane(linkedSessionId);
    return { panes: [pane], activeKey: pane.key };
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(PANE_STATE_KEY) || '{}') as {
      sessions?: Array<string | null>;
      activeIndex?: number;
      ids?: Array<string | null>;
      activeIdx?: number;
    };
    const sessions = (parsed.sessions || parsed.ids)?.slice(0, MAX_PANES);
    if (sessions?.length) {
      const panes = sessions.map(createPane);
      const savedActiveIndex = parsed.activeIndex ?? parsed.activeIdx ?? 0;
      return {
        panes,
        activeKey: panes[Math.min(Math.max(0, savedActiveIndex), panes.length - 1)].key,
      };
    }
  } catch {
    // Corrupt storage intentionally falls back to an empty pane.
  }
  const pane = createPane(null);
  return { panes: [pane], activeKey: pane.key };
}

export function nextPane(sessionId: string | null): PaneDescriptor {
  return createPane(sessionId);
}

export { MAX_PANES, PANE_STATE_KEY };
