import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { normalizeModelId } from './model-execution.js';

export interface GrokModelEvidenceQuery {
  providerSessionId: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  grokHome?: string;
}

/** Grok ACP stdout omits models; native primary turn events retain model_id. */
export function parseGrokTurnModels(text: string, query: GrokModelEvidenceQuery): string[] {
  const start = Date.parse(query.startedAt);
  const end = Date.parse(query.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const models = new Set<string>();
  for (const line of text.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (
        event?.type !== 'turn_started' ||
        event.session_id !== query.providerSessionId ||
        event.session_relationship !== 'primary'
      )
        continue;
      const timestamp = Date.parse(event.ts);
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;
      const model = normalizeModelId(event.model_id);
      if (model) {
        models.delete(model);
        models.add(model);
      }
    } catch {
      /* Partial trailing records are not evidence. */
    }
  }
  return [...models];
}

export async function readGrokTurnModels(query: GrokModelEvidenceQuery): Promise<string[]> {
  if (!query.cwd || !/^[a-zA-Z0-9-]{1,128}$/.test(query.providerSessionId)) return [];
  try {
    const root = await realpath(join(query.grokHome ?? join(homedir(), '.grok'), 'sessions'));
    const directory = join(root, encodeURIComponent(resolve(query.cwd)), query.providerSessionId);
    const file = await realpath(join(directory, 'events.jsonl'));
    if (!file.startsWith(directory + sep)) return [];
    const info = await stat(file);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) return [];
    return parseGrokTurnModels(await readFile(file, 'utf8'), query);
  } catch {
    return [];
  }
}
