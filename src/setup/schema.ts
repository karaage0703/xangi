import { isAbsolute } from 'node:path';
import { isValidBackendExecutablePath } from './backend-executable.js';

export const SETUP_BACKENDS = [
  'claude-code',
  'codex',
  'cursor',
  'grok',
  'antigravity',
  'local-llm',
] as const;

export type SetupBackend = (typeof SETUP_BACKENDS)[number];

export const SETUP_WEB_CHAT_ACCESS = ['local', 'tailscale', 'lan'] as const;
export type SetupWebChatAccess = (typeof SETUP_WEB_CHAT_ACCESS)[number];

export interface SetupConfig {
  backend: SetupBackend;
  backendExecutable?: string;
  workspacePath: string;
  webChatEnabled: boolean;
  webChatAccess: SetupWebChatAccess;
}

const ALLOWED_KEYS = new Set<string>([
  'backend',
  'backendExecutable',
  'workspacePath',
  'webChatEnabled',
  'webChatAccess',
  // Read compatibility for setup files created before Notion sync was removed.
  'notionSyncEnabled',
]);

export class SetupValidationError extends Error {
  constructor(message = 'Invalid setup configuration') {
    super(message);
    this.name = 'SetupValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSetupConfig(value: unknown): SetupConfig {
  if (!isRecord(value)) {
    throw new SetupValidationError();
  }

  const keys = Object.keys(value);
  if (keys.some((key) => !ALLOWED_KEYS.has(key))) {
    throw new SetupValidationError();
  }

  const {
    backend,
    backendExecutable,
    workspacePath,
    webChatEnabled,
    webChatAccess = 'local',
  } = value;
  if (
    typeof backend !== 'string' ||
    !(SETUP_BACKENDS as readonly string[]).includes(backend) ||
    typeof workspacePath !== 'string' ||
    workspacePath.length === 0 ||
    workspacePath.length > 4096 ||
    workspacePath.includes('\0') ||
    !isAbsolute(workspacePath) ||
    typeof webChatEnabled !== 'boolean' ||
    typeof webChatAccess !== 'string' ||
    !(SETUP_WEB_CHAT_ACCESS as readonly string[]).includes(webChatAccess) ||
    (value.notionSyncEnabled !== undefined && typeof value.notionSyncEnabled !== 'boolean')
  ) {
    throw new SetupValidationError();
  }

  if (
    backendExecutable !== undefined &&
    (typeof backendExecutable !== 'string' ||
      !isValidBackendExecutablePath(backend as SetupBackend, backendExecutable))
  ) {
    throw new SetupValidationError();
  }

  return {
    backend: backend as SetupBackend,
    ...(backendExecutable === undefined ? {} : { backendExecutable }),
    workspacePath,
    webChatEnabled,
    webChatAccess: webChatAccess as SetupWebChatAccess,
  };
}
