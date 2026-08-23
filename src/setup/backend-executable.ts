import { access, realpath, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { SetupBackend } from './schema.js';

export const BACKEND_COMMAND: Record<SetupBackend, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
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
  if (executable && isAbsolute(executable) && basename(executable) === command) return executable;

  // The official OpenCode installer uses ~/.opencode/bin, which is commonly
  // added only to interactive shell startup files. PM2/systemd services do not
  // necessarily inherit that PATH, so resolve the documented install location.
  if (command === 'opencode' && env.HOME) {
    const installed = join(env.HOME, '.opencode', 'bin', 'opencode');
    if (existsSync(installed)) return installed;
  }

  return command;
}
