import { classifyBindHost, resolveAccessUrls } from './access-urls.js';

export const DEFAULT_WEB_CHAT_PORT = 18888;
export const DEFAULT_WEB_CHAT_HOST = '0.0.0.0';

export interface ResolvedWebChatPort {
  port: number;
  source: 'option' | 'environment' | 'default';
  defaultApplied: boolean;
}

export interface WebEndpointStatus {
  url: string;
  ok: boolean;
  status: number | null;
  error?: string;
}

export interface WebStatus {
  enabled: boolean;
  port: number;
  portSource: ResolvedWebChatPort['source'];
  defaultPortApplied: boolean;
  bindHost: string;
  bindHostKind: ReturnType<typeof classifyBindHost>;
  accessUrls: string[];
  chatUrls: string[];
  workspaceUrls: string[];
  http: {
    root: WebEndpointStatus | null;
    workspace: WebEndpointStatus | null;
  };
}

export interface WebStatusOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  resolveUrls?: typeof resolveAccessUrls;
  timeoutMs?: number;
}

function unwrapQuotedValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function validPort(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const normalized = unwrapQuotedValue(value);
  if (!/^\d+$/.test(normalized)) return undefined;
  const port = Number(normalized);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

export function resolveWebChatPort(
  optionPort?: number,
  env: NodeJS.ProcessEnv = process.env
): ResolvedWebChatPort {
  const fromOption = validPort(optionPort);
  if (fromOption !== undefined) {
    return { port: fromOption, source: 'option', defaultApplied: false };
  }
  const fromEnvironment = validPort(env.WEB_CHAT_PORT);
  if (fromEnvironment !== undefined) {
    return { port: fromEnvironment, source: 'environment', defaultApplied: false };
  }
  return { port: DEFAULT_WEB_CHAT_PORT, source: 'default', defaultApplied: true };
}

export function resolveWebChatHost(
  optionHost?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = optionHost ?? env.WEB_CHAT_HOST;
  if (typeof raw !== 'string') return DEFAULT_WEB_CHAT_HOST;
  const normalized = unwrapQuotedValue(raw);
  return normalized || DEFAULT_WEB_CHAT_HOST;
}

function localProbeBaseUrl(port: number, host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === '::1') return `http://[::1]:${port}`;
  if (classifyBindHost(host) === 'specific') {
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${authority}:${port}`;
  }
  return `http://127.0.0.1:${port}`;
}

async function probeEndpoint(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<WebEndpointStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    return { url, ok: response.ok, status: response.status };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectWebStatus(options: WebStatusOptions = {}): Promise<WebStatus> {
  const env = options.env ?? process.env;
  const enabled = env.WEB_CHAT_ENABLED === 'true';
  const resolvedPort = resolveWebChatPort(undefined, env);
  const bindHost = resolveWebChatHost(undefined, env);
  const bindHostKind = classifyBindHost(bindHost);

  if (!enabled) {
    return {
      enabled,
      port: resolvedPort.port,
      portSource: resolvedPort.source,
      defaultPortApplied: resolvedPort.defaultApplied,
      bindHost,
      bindHostKind,
      accessUrls: [],
      chatUrls: [],
      workspaceUrls: [],
      http: { root: null, workspace: null },
    };
  }

  const accessUrls = await (options.resolveUrls ?? resolveAccessUrls)(resolvedPort.port, bindHost);
  const chatUrls = [...accessUrls];
  const workspaceUrls = accessUrls.map((url) => `${url}/workspace`);
  const localBaseUrl = localProbeBaseUrl(resolvedPort.port, bindHost);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const [root, workspace] = await Promise.all([
    probeEndpoint(`${localBaseUrl}/`, fetchImpl, timeoutMs),
    probeEndpoint(`${localBaseUrl}/workspace`, fetchImpl, timeoutMs),
  ]);

  return {
    enabled,
    port: resolvedPort.port,
    portSource: resolvedPort.source,
    defaultPortApplied: resolvedPort.defaultApplied,
    bindHost,
    bindHostKind,
    accessUrls,
    chatUrls,
    workspaceUrls,
    http: { root, workspace },
  };
}

export async function webStatusCmd(options: WebStatusOptions = {}): Promise<string> {
  return JSON.stringify(await collectWebStatus(options), null, 2);
}
