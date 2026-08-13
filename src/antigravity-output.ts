interface AntigravityErrorEnvelope {
  status?: unknown;
  is_error?: unknown;
  error?: unknown;
  message?: unknown;
  response?: unknown;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function extractAntigravityErrorMessage(value: unknown): string | undefined {
  const event = toRecord(value) as AntigravityErrorEnvelope | undefined;
  if (!event) return undefined;

  const stringError = typeof event.error === 'string' ? event.error.trim() : '';
  if (stringError) return stringError;
  const error = toRecord(event.error);
  if (error) {
    for (const key of ['message', 'detail', 'description']) {
      const detail = error[key];
      if (typeof detail === 'string' && detail.trim()) return detail.trim();
    }
    if (Object.keys(error).length > 0) return JSON.stringify(error);
  }

  const isError = event.status === 'ERROR' || event.is_error === true;
  if (!isError) return undefined;
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim();
  if (typeof event.response === 'string' && event.response.trim()) return event.response.trim();
  return undefined;
}

export function extractAntigravityOutputError(output: string): string | undefined {
  for (const candidate of [output, ...output.split('\n')]) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const error = extractAntigravityErrorMessage(parsed);
      if (error) return error;
    } catch {
      // Non-JSON diagnostics are handled by the caller.
    }
  }
  return undefined;
}

export function reportsUnsupportedOutputFormat(detail: string): boolean {
  const mentionsOutputFormat = /-{1,2}output-format/i.test(detail);
  const reportsUnsupported =
    /(?:unknown|unrecognized|undefined|unexpected)\s+(?:option|flag|argument)/i.test(detail) ||
    /(?:option|flag|argument)s?\s+provided\s+but\s+not\s+defined/i.test(detail) ||
    /(?:option|flag|argument)s?\s+(?:is|are)\s+not\s+defined/i.test(detail);
  return mentionsOutputFormat && reportsUnsupported;
}
