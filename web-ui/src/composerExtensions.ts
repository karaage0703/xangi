import { useEffect, useState } from 'react';
import { requestJson } from './api';

export interface ComposerExtension {
  id: string;
  displayName: string;
}
interface Entry extends ComposerExtension {
  installed: boolean;
  running: boolean;
  healthy: boolean;
  uiAvailable: boolean;
  capabilities: string[];
}
export function selectComposerExtensions(entries: Entry[]): ComposerExtension[] {
  return entries
    .filter(
      (e) =>
        /^[a-z0-9][a-z0-9-]*$/.test(e.id) &&
        e.installed &&
        e.running &&
        e.healthy &&
        e.uiAvailable &&
        e.capabilities.includes('composer.input')
    )
    .map(({ id, displayName }) => ({ id, displayName }));
}
export function replaceComposerText(draft: string, previous: string, next: string): string {
  if (!next.trim()) return draft;
  if (!previous) return draft + (draft && !/\s$/.test(draft) ? '\n' : '') + next;
  return draft.endsWith(previous) ? draft.slice(0, -previous.length) + next : draft;
}
export function useComposerExtensions() {
  const [extensions, setExtensions] = useState<ComposerExtension[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const catalog = await requestJson<{ extensions: Entry[] }>('/api/extensions', {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setExtensions(selectComposerExtensions(catalog.extensions));
      } catch {
        if (!controller.signal.aborted) setExtensions([]);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), 5000);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  return extensions;
}
