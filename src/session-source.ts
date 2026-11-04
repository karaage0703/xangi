/** Shared classification for chat lists and monitoring, independent of transport. */
export interface SessionSourceMetadata {
  platform?: string;
  scope?: string;
  executionOrigin?: 'manual' | 'automation';
}

export const SESSION_SOURCE_FILTERS = [
  { value: 'chat', label: 'Chat' },
  { value: 'web', label: 'Web' },
  // Keep the persisted filter value compatible with existing browser preferences.
  { value: 'scheduler', label: '自動実行' },
] as const;
export type SessionSource = (typeof SESSION_SOURCE_FILTERS)[number]['value'];

export function sessionSource(session: SessionSourceMetadata): SessionSource {
  if (session.scope === 'scheduler' || session.executionOrigin === 'automation') return 'scheduler';
  return session.platform === 'web' ? 'web' : 'chat';
}

export function sessionExecutionOrigin(session?: SessionSourceMetadata): 'manual' | 'automation' {
  return session && sessionSource(session) === 'scheduler' ? 'automation' : 'manual';
}
