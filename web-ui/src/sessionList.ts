export type SessionListStatus = 'running' | 'waiting' | 'completed';

export function sessionListStatus(session: {
  isActive: boolean;
  lifecycle?: 'open' | 'closed';
}): SessionListStatus {
  if (session.lifecycle === 'closed') return 'completed';
  return session.isActive ? 'running' : 'waiting';
}

export function sessionListStatusLabel(status: SessionListStatus): string {
  if (status === 'running') return '実行中';
  if (status === 'completed') return '完了';
  return '待機中';
}

import { SESSION_SOURCE_FILTERS, type SessionSource } from '../../src/session-source';
export {
  SESSION_SOURCE_FILTERS,
  sessionSource,
  type SessionSource,
} from '../../src/session-source';
export const SESSION_SOURCES_KEY = 'xangi.chat.visible-sources.v2';

export function parseSessionSources(stored: string | null): SessionSource[] {
  const allowed = SESSION_SOURCE_FILTERS.map((item) => item.value);
  const defaults: SessionSource[] = ['chat', 'web'];
  try {
    const parsed: unknown = JSON.parse(stored || 'null');
    if (!Array.isArray(parsed)) return defaults;
    // Preserve an intentional empty selection; reject unknown/corrupt values.
    if (!parsed.every((value) => allowed.includes(value))) return defaults;
    return allowed.filter((value) => parsed.includes(value));
  } catch {
    return defaults;
  }
}

export function restoreSessionSources(storage: Pick<Storage, 'getItem'>): SessionSource[] {
  const stored = storage.getItem(SESSION_SOURCES_KEY);
  if (stored !== null) return parseSessionSources(stored);
  // The previous version automatically saved all sources, including Schedule.
  // Keep its Chat/Web choices while applying the new Schedule-off default once.
  return parseSessionSources(storage.getItem('xangi.chat.visible-sources.v1')).filter(
    (value) => value !== 'scheduler'
  );
}
