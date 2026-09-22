interface AntigravityErrorEnvelope {
  status?: unknown;
  is_error?: unknown;
  error?: unknown;
  message?: unknown;
  response?: unknown;
}

export interface AntigravityStderrError {
  short_error: string;
  status?: string;
  code_kind?: string;
  error_code?: number;
  retryable?: boolean;
  error_id?: string;
}

const MAX_AGY_ERROR_CANDIDATE_LENGTH = 16_384;
const MAX_AGY_ERROR_MESSAGE_LENGTH = 2_000;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasNonWhitespaceControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isWhitespaceControl = code >= 0x09 && code <= 0x0d;
    if ((code <= 0x1f && !isWhitespaceControl) || code === 0x7f) return true;
  }
  return false;
}

function optionalToken(
  value: unknown,
  maxLength: number
): { valid: true; value?: string } | { valid: false } {
  if (value === undefined) return { valid: true };
  if (typeof value !== 'string') return { valid: false };
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || hasControlCharacters(trimmed)) {
    return { valid: false };
  }
  return { valid: true, value: trimmed };
}

/** Parse Agy 1.2.6+ structured stderr without trusting arbitrary provider fields. */
export function parseAntigravityStderrError(stderr: string): AntigravityStderrError | undefined {
  for (const line of stderr.split('\n')) {
    const markerMatch = /^[ \t]*AGY_ERROR:/u.exec(line);
    if (!markerMatch) continue;
    const candidate = line.slice(markerMatch[0].length).replace(/\r$/u, '').trim();

    if (!candidate || candidate.length > MAX_AGY_ERROR_CANDIDATE_LENGTH) continue;

    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = toRecord(JSON.parse(candidate));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed.short_error !== 'string') continue;

    if (hasNonWhitespaceControlCharacters(parsed.short_error)) continue;
    const shortError = parsed.short_error.trim().replace(/\s+/gu, ' ');
    if (!shortError) continue;

    const status = optionalToken(parsed.status, 64);
    const codeKind = optionalToken(parsed.code_kind, 64);
    const errorId = optionalToken(parsed.error_id, 256);
    if (!status.valid || !codeKind.valid || !errorId.valid) continue;
    if (
      parsed.error_code !== undefined &&
      (typeof parsed.error_code !== 'number' ||
        !Number.isSafeInteger(parsed.error_code) ||
        parsed.error_code < 0)
    ) {
      continue;
    }
    if (parsed.retryable !== undefined && typeof parsed.retryable !== 'boolean') continue;

    return {
      short_error: [...shortError].slice(0, MAX_AGY_ERROR_MESSAGE_LENGTH).join(''),
      ...(status.value ? { status: status.value } : {}),
      ...(codeKind.value ? { code_kind: codeKind.value } : {}),
      ...(parsed.error_code !== undefined ? { error_code: parsed.error_code as number } : {}),
      ...(parsed.retryable !== undefined ? { retryable: parsed.retryable as boolean } : {}),
      ...(errorId.value ? { error_id: errorId.value } : {}),
    };
  }
  return undefined;
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

export function isAntigravityWorkspaceArtifactPathError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    /write_to_file/i.test(detail) &&
    /is not a valid artifact path/i.test(detail) &&
    /artifacts must be in/i.test(detail)
  );
}
