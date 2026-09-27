import { ValidationError } from './errors.js';
import { getSessionEntry } from './sessions.js';

const running = new Map<string, Map<symbol, string>>();

/** 実行中だけ登録する。永続backendの起動時環境に会話IDを固定しない。 */
export function registerRunningSession(channelId?: string, appSessionId?: string): () => void {
  if (!channelId || !appSessionId) return () => {};
  const token = Symbol();
  const entries = running.get(channelId) ?? new Map<symbol, string>();
  entries.set(token, appSessionId);
  running.set(channelId, entries);
  return () => {
    entries.delete(token);
    if (entries.size === 0 && running.get(channelId) === entries) running.delete(channelId);
  };
}

export function resolveRunningSession(channelId: string, platform?: string): string | undefined {
  const ids = new Set(running.get(channelId)?.values());
  if (ids.size > 1) throw new ValidationError('progress_card has multiple running sessions');
  const id = ids.values().next().value;
  if (!id) return undefined;
  const entry = getSessionEntry(id);
  if (!entry || entry.contextKey !== channelId || (platform && entry.platform !== platform)) {
    throw new ValidationError('progress_card running session does not match the current context');
  }
  return id;
}
