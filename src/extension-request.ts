import { ValidationError } from './errors.js';
import { resolveExtensionCapability, type ResolvedExtensionCapability } from './extensions.js';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const MAX_RESPONSE_CHARS = 1_000_000;

type CapabilityResolver = (
  extensionId: string,
  capabilityId: string
) => ResolvedExtensionCapability | undefined;

function parseJsonObject(
  raw: string | undefined,
  flag: string
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ValidationError(`${flag} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError(`${flag} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function appendQuery(url: URL, query: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === null || item === undefined) continue;
      if (!['string', 'number', 'boolean'].includes(typeof item)) {
        throw new ValidationError('--query-json values must be scalar values or arrays of scalars');
      }
      url.searchParams.append(key, String(item));
    }
  }
}

export async function executeExtensionRequest(
  flags: Record<string, string>,
  resolveCapability: CapabilityResolver = resolveExtensionCapability
): Promise<string> {
  const extensionId = flags.id?.trim();
  const capabilityId = flags.capability?.trim();
  const path = flags.path?.trim();
  if (!extensionId) throw new ValidationError('extension_request requires --id');
  if (!capabilityId) throw new ValidationError('extension_request requires --capability');
  if (!path || !path.startsWith('/') || path.startsWith('//')) {
    throw new ValidationError(
      'extension_request requires an absolute service --path beginning with /'
    );
  }

  const method = (flags.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new ValidationError('--method must be GET, POST, PUT, or DELETE');
  }

  const runtime = resolveCapability(extensionId, capabilityId);
  if (!runtime) {
    throw new ValidationError(
      `Extension capability is not running or unavailable: ${extensionId}/${capabilityId}`
    );
  }

  const baseUrl = new URL(runtime.baseUrl);
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new ValidationError('--path must stay within the extension service origin');
  }
  const query = parseJsonObject(flags['query-json'], '--query-json');
  if (query) appendQuery(url, query);

  let body: string | undefined;
  if (flags['body-json'] !== undefined) {
    if (method === 'GET' || method === 'DELETE') {
      throw new ValidationError(`--body-json is not supported with ${method}`);
    }
    try {
      body = JSON.stringify(JSON.parse(flags['body-json']) as unknown);
    } catch {
      throw new ValidationError('--body-json must be valid JSON');
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: runtime.authorization,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = await response.text();
  const boundedBody = responseBody.slice(0, MAX_RESPONSE_CHARS);
  if (!response.ok) {
    throw new ValidationError(
      `Extension request failed (${response.status} ${response.statusText}): ${boundedBody}`
    );
  }
  return boundedBody;
}
