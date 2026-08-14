import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { SetupBackend } from './schema.js';

export const BACKEND_COMMAND: Record<SetupBackend, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  grok: 'grok',
  antigravity: 'agy',
  'github-copilot': 'copilot',
  'local-llm': 'ollama',
};

export function isValidBackendExecutablePath(backend: SetupBackend, executable: string): boolean {
  return (
    executable.length > 0 &&
    executable.length <= 4096 &&
    isAbsolute(executable) &&
    basename(executable) === BACKEND_COMMAND[backend] &&
    ![...executable].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

export async function verifyBackendExecutable(
  backend: SetupBackend,
  executable: string
): Promise<string> {
  if (!isValidBackendExecutablePath(backend, executable)) {
    throw new Error(`Invalid executable path for backend ${backend}`);
  }
  const resolved = await realpath(executable);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Backend executable is not a regular file: ${executable}`);
  await access(executable, constants.X_OK);
  return executable;
}

export function configuredBackendCommand(command: string, env: NodeJS.ProcessEnv): string {
  const executable = env.XANGI_BACKEND_EXECUTABLE;
  return executable && isAbsolute(executable) && basename(executable) === command
    ? executable
    : command;
}
