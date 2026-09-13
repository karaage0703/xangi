import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { normalizeExecutionEffort, normalizeModelId } from './model-execution.js';

export interface GrokModelEvidenceQuery {
  providerSessionId: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  grokHome?: string;
  chatHistoryOffset?: number;
}

type GrokSessionQuery = Pick<GrokModelEvidenceQuery, 'providerSessionId' | 'cwd' | 'grokHome'>;

export interface GrokTurnEvidence {
  models: string[];
  effort?: string;
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

/** Grok stores the applied effort on each main-session assistant message. */
export function parseGrokTurnEffort(text: string): string | undefined {
  let effort: string | undefined;
  for (const line of text.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event?.type !== 'assistant') continue;
      effort = normalizeExecutionEffort(event.reasoning_effort) ?? effort;
    } catch {
      /* Partial trailing records are not evidence. */
    }
  }
  return effort;
}

async function resolveGrokSessionFile(
  query: GrokSessionQuery,
  filename: 'events.jsonl' | 'chat_history.jsonl'
): Promise<string | undefined> {
  if (!query.cwd || !/^[a-zA-Z0-9-]{1,128}$/.test(query.providerSessionId)) return undefined;
  try {
    const root = await realpath(join(query.grokHome ?? join(homedir(), '.grok'), 'sessions'));
    const directory = join(root, encodeURIComponent(resolve(query.cwd)), query.providerSessionId);
    const file = await realpath(join(directory, filename));
    if (!file.startsWith(directory + sep)) return undefined;
    const info = await stat(file);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) return undefined;
    return file;
  } catch {
    return undefined;
  }
}

export async function getGrokChatHistorySize(query: GrokSessionQuery): Promise<number> {
  const file = await resolveGrokSessionFile(query, 'chat_history.jsonl');
  if (!file) return 0;
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

export async function readGrokTurnEvidence(
  query: GrokModelEvidenceQuery
): Promise<GrokTurnEvidence> {
  const models = await readGrokTurnModels(query);
  const file = await resolveGrokSessionFile(query, 'chat_history.jsonl');
  if (!file) return { models };
  try {
    const content = await readFile(file);
    const offset = query.chatHistoryOffset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) return { models };
    return { models, effort: parseGrokTurnEffort(content.subarray(offset).toString('utf8')) };
  } catch {
    return { models };
  }
}

export async function readGrokTurnModels(query: GrokModelEvidenceQuery): Promise<string[]> {
  const file = await resolveGrokSessionFile(query, 'events.jsonl');
  if (!file) return [];
  try {
    return parseGrokTurnModels(await readFile(file, 'utf8'), query);
  } catch {
    return [];
  }
}
