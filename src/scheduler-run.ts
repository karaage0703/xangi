import { randomUUID } from 'crypto';
import {
  appendCompletionSummary,
  DEFAULT_COMPLETION_DISPLAY,
  formatElapsedTime,
  type CompletionDisplayOptions,
} from './completion-summary.js';

const SCHEDULER_RUN_PREFIX = 'scheduler-run-';
const LEGACY_SCHEDULER_RUN_ID = /^0m[a-z0-9]+_[a-f0-9]{8}-\d{13}$/;

/** Create a stateless appSessionId for one scheduled agent run. */
export function createSchedulerRunId(platform: string, now: number = Date.now()): string {
  return `${SCHEDULER_RUN_PREFIX}${platform}-${now}-${randomUUID().slice(0, 8)}`;
}

/** Scheduler transcripts are audit records, not interactive Web Chat sessions. */
export function isSchedulerRunId(id: string): boolean {
  return id.startsWith(SCHEDULER_RUN_PREFIX) || LEGACY_SCHEDULER_RUN_ID.test(id);
}

/** Format elapsed time for the footer shown on scheduled task results. */
export function formatScheduleRunDuration(elapsedMs: number): string {
  return formatElapsedTime(elapsedMs).replace(/分0(\d)秒$/, '分$1秒');
}

/** Append the shared completion summary to a scheduled task result. */
export function appendScheduleRunCompletion(
  text: string,
  elapsedMs: number,
  options: CompletionDisplayOptions = DEFAULT_COMPLETION_DISPLAY,
  status: 'complete' | 'error' = 'complete'
): string {
  return appendCompletionSummary(text, { elapsedMs }, options, status);
}
