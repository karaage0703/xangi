import { spawnSync } from 'node:child_process';
import { chmodSync, renameSync, writeFileSync } from 'node:fs';

export interface CommandRunner {
  run(command: string, args: string[], allowFailure?: boolean): string;
  status(command: string, args: string[]): { status: number | null; output: string };
}

function command(command: string, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status,
    output: (String(result.stdout ?? '') + String(result.stderr ?? '')).trim(),
  };
}

export const defaultCommandRunner: CommandRunner = {
  run(name, args, allowFailure = false) {
    const result = command(name, args);
    if (!allowFailure && (result.status ?? 1) !== 0) {
      throw new Error(result.output || `${name} ${args.join(' ')} failed`);
    }
    return result.output;
  },
  status: command,
};

export function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, path);
}

export function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function validatedInterval(value = 21_600): number {
  if (!Number.isSafeInteger(value) || value < 300 || value > 2_592_000) {
    throw new Error('Update interval must be an integer between 300 and 2592000 seconds');
  }
  return value;
}

export function launchctlDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('LaunchAgent requires a numeric user id');
  return `gui/${uid}`;
}

export function systemdValue(value: string): string {
  if ([...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('systemd unit values may not contain control characters');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}
