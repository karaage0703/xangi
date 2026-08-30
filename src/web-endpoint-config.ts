export const DEFAULT_WEB_CHAT_PORT = 18888;
export const DEFAULT_WEB_CHAT_HOST = '0.0.0.0';

export interface ResolvedWebChatPort {
  port: number;
  source: 'option' | 'environment' | 'default';
  defaultApplied: boolean;
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
