import { useEffect, useState } from 'react';
import { requestJson } from './api';

export interface ComposerExtension {
  id: string;
  displayName: string;
  path: string;
  permissions?: string[];
}
interface Entry {
  id: string;
  displayName: string;
  composer?: { path: string; permissions?: string[] };
  installed: boolean;
  running: boolean;
  healthy: boolean;
  uiAvailable: boolean;
  capabilities: string[];
}
export function selectComposerContributions(entries: Entry[]): ComposerExtension[] {
  return entries
    .filter(
      (e) =>
        /^[a-z0-9][a-z0-9-]*$/.test(e.id) &&
        e.installed &&
        e.running &&
        e.healthy &&
        e.uiAvailable &&
        Boolean(e.composer)
    )
    .map(({ id, displayName, composer }) => ({ id, displayName, ...composer! }));
}
export function applyComposerSnapshot(draft: string, previous: string, next: string): string {
  if (!next.trim()) return draft;
  if (!previous) return draft + (draft && !/\s$/.test(draft) ? '\n' : '') + next;
  return draft.endsWith(previous) ? draft.slice(0, -previous.length) + next : draft;
}
export function useComposerContributions() {
  const [extensions, setExtensions] = useState<ComposerExtension[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const catalog = await requestJson<{ extensions: Entry[] }>('/api/extensions', {
          signal: controller.signal,
        });
        if (!controller.signal.aborted && current === generation)
          setExtensions(selectComposerContributions(catalog.extensions));
      } catch {
        if (!controller.signal.aborted && current === generation) setExtensions([]);
      }
    };
    const refresh = () => {
      void load();
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return extensions;
}
