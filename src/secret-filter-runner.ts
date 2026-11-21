import type { RunResult, StreamCallbacks } from './agent-runner.js';
import { SECRET_BLOCK_NOTICE, SecretFilter, SecretOutputStream } from './secret-filter.js';

export function filterRunResult(
  result: RunResult,
  filter: SecretFilter,
  blocked = false
): RunResult {
  if (
    blocked ||
    filter.contains(result.result) ||
    result.attachments?.some((p) => filter.contains(p))
  ) {
    return { ...result, result: SECRET_BLOCK_NOTICE, failed: true, attachments: undefined };
  }
  return result;
}

export function filterRunError(error: unknown, filter: SecretFilter): unknown {
  if (!(error instanceof Error)) return typeof error === 'string' ? filter.redact(error) : error;
  // Keep retryable/status metadata and the error class; never turn a non-retryable
  // failure into a generic error that could repeat an external side effect.
  return filter.redactValue(error);
}

/** Wrap before trajectory recorders / platform callbacks see provider events. */
export function filterStreamCallbacks(callbacks: StreamCallbacks, filter: SecretFilter) {
  const stream = new SecretOutputStream(filter);
  let fullText = '';
  let rawFullText = '';
  const emitSnapshot = (snapshot: string) => {
    if (snapshot === fullText) return;
    const delta = snapshot.startsWith(fullText) ? snapshot.slice(fullText.length) : snapshot;
    fullText = snapshot;
    callbacks.onText?.(delta, fullText);
  };
  const guarded: StreamCallbacks = {
    ...callbacks,
    onText: (text, snapshot) => {
      stream.push(text);
      if (filter.contains(snapshot)) stream.blocked = true;
      if (stream.blocked) return;
      rawFullText = snapshot;
      emitSnapshot(snapshot.slice(0, snapshot.length - filter.pendingPrefixLength(snapshot)));
    },
    onToolUse: (name, input) =>
      callbacks.onToolUse?.(filter.redact(name), filter.redactValue(input)),
    onTraceEvent: (event) => callbacks.onTraceEvent?.(filter.redactValue(event)),
    onUserInput: callbacks.onUserInput
      ? async (request, signal) =>
          filter.redactValue(await callbacks.onUserInput!(filter.redactValue(request), signal))
      : undefined,
    onError: (error) => callbacks.onError?.(filterRunError(error, filter) as Error),
    // DynamicRunnerManager owns completion, after filtering and model persistence.
    onComplete: undefined,
  };
  return {
    callbacks: guarded,
    finish(result: RunResult): RunResult {
      const safe = filterRunResult(result, filter, stream.blocked);
      if (safe !== result) return safe;
      emitSnapshot(rawFullText);
      return safe;
    },
  };
}
