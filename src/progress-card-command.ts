import { ValidationError } from './errors.js';
import {
  getActiveSessionId,
  replaceSessionProgressCard,
  type SessionProgressStep,
} from './sessions.js';

const MAX_STEPS = 50;
const MAX_STEP_CHARS = 512;
const MAX_NOTE_CHARS = 2000;
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed']);

function parsePlan(raw: string | undefined): SessionProgressStep[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('progress_card --plan-json must be a JSON array');
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_STEPS) {
    throw new ValidationError(`progress_card plan must contain at most ${MAX_STEPS} steps`);
  }
  const plan = parsed.map((item): SessionProgressStep => {
    if (!item || typeof item !== 'object') {
      throw new ValidationError('progress_card steps must be objects');
    }
    const step = String((item as { step?: unknown }).step ?? '').trim();
    const status = String((item as { status?: unknown }).status ?? '');
    if (!step || step.length > MAX_STEP_CHARS || !VALID_STATUSES.has(status)) {
      throw new ValidationError(
        'each progress_card step requires step (1-512 chars) and status pending|in_progress|completed'
      );
    }
    return { step, status: status as SessionProgressStep['status'] };
  });
  if (plan.filter((item) => item.status === 'in_progress').length > 1) {
    throw new ValidationError('progress_card allows at most one in_progress step');
  }
  return plan;
}

export function executeProgressCardCommand(
  flags: Record<string, string>,
  context?: { channelId?: string }
): string {
  const contextKey = flags.channel || context?.channelId;
  if (!contextKey) throw new ValidationError('progress_card requires the current channel context');
  const appSessionId = getActiveSessionId(contextKey);
  if (!appSessionId) throw new ValidationError('progress_card could not resolve an active session');

  if (flags.clear === 'true') {
    replaceSessionProgressCard(appSessionId, { clear: true });
    return 'Progress card cleared';
  }

  const plan = parsePlan(flags['plan-json']);
  const note = flags.note?.trim();
  if (note && note.length > MAX_NOTE_CHARS) {
    throw new ValidationError(`progress_card note must be at most ${MAX_NOTE_CHARS} characters`);
  }
  if (plan.length === 0 && !note) {
    throw new ValidationError('progress_card requires --plan-json, --note, or --clear true');
  }

  const card = replaceSessionProgressCard(appSessionId, { plan, note });
  const completed = card?.plan.filter((item) => item.status === 'completed').length ?? 0;
  return `Progress card updated (rev ${card?.revision ?? 0}, ${completed}/${card?.plan.length ?? 0} done)`;
}
