import { normalizeExecutionEffort, normalizeModelId } from './model-execution.js';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** A bounded execution interval, never the current CLI configuration. */
export interface CodexModelEvidenceQuery {
  providerSessionId: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  codexHome?: string;
}

export interface CodexTurnEvidence {
  models: string[];
  effort?: string;
}

const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 2000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Only timestamped turn contexts belonging to the exact provider session and cwd
 * count as model/effort evidence. Old contexts, modelUsage and current defaults are ignored.
 */
export function parseCodexTurnEvidence(
  text: string,
  query: CodexModelEvidenceQuery
): CodexTurnEvidence {
  const start = Date.parse(query.startedAt);
  const end = Date.parse(query.finishedAt);
  if (!query.cwd || !Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return { models: [] };
  let linked = false;
  const models = new Set<string>();
  let effort: string | undefined;
  for (const line of text.split('\n')) {
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue; // Rollouts can end with an incomplete line while running.
    }
    const payload = record(event?.payload);
    if (!event || !payload) continue;
    if (event.type === 'session_meta') {
      // Refuse concatenated/mismatched files instead of retaining earlier evidence.
      if (
        payload.id !== query.providerSessionId ||
        typeof payload.cwd !== 'string' ||
        resolve(payload.cwd) !== resolve(query.cwd)
      )
        return { models: [] };
      linked = true;
    }
    if (!linked || event.type !== 'turn_context') continue;
    const time = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
    if (!Number.isFinite(time) || time < start || time > end) continue;
    if (typeof payload.cwd !== 'string' || resolve(payload.cwd) !== resolve(query.cwd)) continue;
    const model = normalizeModelId(payload.model);
    if (model) {
      models.delete(model); // Keep the final element equal to the latest observed model.
      models.add(model);
    }
    effort = normalizeExecutionEffort(payload.effort) ?? effort;
  }
  return { models: [...models], effort };
}

export function parseCodexTurnModels(text: string, query: CodexModelEvidenceQuery): string[] {
  return parseCodexTurnEvidence(text, query).models;
}

/** UUIDv7 contains the original session creation time, including resumed sessions. */
function candidateDays(query: CodexModelEvidenceQuery): string[] {
  const times = [Date.parse(query.startedAt)];
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      query.providerSessionId
    )
  ) {
    times.push(parseInt(query.providerSessionId.replaceAll('-', '').slice(0, 12), 16));
  }
  const days = new Set<string>();
  for (const time of times) {
    if (!Number.isFinite(time)) continue;
    for (const offset of [-1, 0, 1]) {
      // Rollout directory dates may use a different local timezone.
      days.add(
        new Date(time + offset * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '/')
      );
    }
  }
  return [...days];
}

/**
 * Read local provider evidence without launching/resuming a provider process.
 * Missing, oversized or ambiguous evidence stays unknown. Directory discovery is
 * restricted to session creation/run days, never an unbounded history scan.
 */
export async function readCodexTurnEvidence(
  query: CodexModelEvidenceQuery
): Promise<CodexTurnEvidence> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(query.providerSessionId)) return { models: [] };
  try {
    const root = await realpath(
      join(query.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
    );
    const candidates: string[] = [];
    for (const day of candidateDays(query)) {
      const directory = join(root, day);
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      if (entries.length > MAX_DIRECTORY_ENTRIES) return { models: [] };
      for (const entry of entries) {
        if (
          entry.isFile() &&
          entry.name.startsWith('rollout-') &&
          entry.name.endsWith(`-${query.providerSessionId}.jsonl`)
        ) {
          candidates.push(join(directory, entry.name));
        }
      }
    }
    if (candidates.length !== 1) return { models: [] };
    const file = await realpath(candidates[0]);
    if (!file.startsWith(`${root}${sep}`)) return { models: [] };
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > MAX_ROLLOUT_BYTES) return { models: [] };
    return parseCodexTurnEvidence(await readFile(file, 'utf8'), query);
  } catch {
    // Provider evidence is optional and must not fail an otherwise successful run.
    return { models: [] };
  }
}

export async function readCodexTurnModels(query: CodexModelEvidenceQuery): Promise<string[]> {
  return (await readCodexTurnEvidence(query)).models;
}
