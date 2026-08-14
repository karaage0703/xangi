import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKEND_COMMAND,
  configuredBackendCommand,
  isValidBackendExecutablePath,
  verifyBackendExecutable,
} from '../src/setup/backend-executable.js';

describe('managed backend executable', () => {
  it.each([
    ['codex', 'codex'],
    ['claude-code', 'claude'],
    ['cursor', 'cursor-agent'],
    ['grok', 'grok'],
    ['antigravity', 'agy'],
    ['github-copilot', 'copilot'],
  ] as const)(
    'maps %s to its expected CLI without accepting another filename',
    (backend, command) => {
      expect(BACKEND_COMMAND[backend]).toBe(command);
      expect(isValidBackendExecutablePath(backend, `/opt/tools/${command}`)).toBe(true);
      expect(isValidBackendExecutablePath(backend, '/opt/tools/unrelated')).toBe(false);
    }
  );

  it('verifies an executable regular file and uses it only for the matching runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-backend-executable-'));
    const bin = join(root, 'bin');
    const executable = join(bin, 'codex');
    await mkdir(bin);
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);

    await expect(verifyBackendExecutable('codex', executable)).resolves.toBe(executable);
    expect(configuredBackendCommand('codex', { XANGI_BACKEND_EXECUTABLE: executable })).toBe(
      executable
    );
    expect(configuredBackendCommand('claude', { XANGI_BACKEND_EXECUTABLE: executable })).toBe(
      'claude'
    );
  });
});
