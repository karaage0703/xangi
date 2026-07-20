import { readlink, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveManagedLifecycle,
  type InstallerFlags,
  type ManagedCommandDependencies,
} from './update-cmd.js';

const REINSTALL_COMMAND =
  'curl -fsSL https://github.com/karaage0703/xangi/releases/latest/download/install.sh | bash';

async function removeManagedCommandLink(homeDir: string, launcherPath: string): Promise<void> {
  const commandLink = join(homeDir, '.local', 'bin', 'xangi');
  let target: string;
  try {
    target = await readlink(commandLink);
  } catch {
    // Missing paths and non-symlink files are not owned by the managed installer.
    return;
  }
  if (target === launcherPath) {
    await rm(commandLink, { force: true });
  }
}

function enabled(flags: InstallerFlags, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

export async function uninstallCmd(
  flags: InstallerFlags,
  dependencies: ManagedCommandDependencies = {}
): Promise<string> {
  const purge = enabled(flags, 'purge');
  if (purge && !enabled(flags, 'yes')) {
    throw new Error(
      '`xangi uninstall --purge` deletes settings, tokens, and state. Run again with `--purge --yes` to confirm. The workspace is never deleted.'
    );
  }

  const runtime = await resolveManagedLifecycle(dependencies);
  await runtime.updateScheduler.uninstall();
  await runtime.service.uninstall();
  await removeManagedCommandLink(
    dependencies.homeDir ?? homedir(),
    join(runtime.layout.appRoot, 'bin', 'xangi')
  );
  await rm(runtime.layout.appRoot, { recursive: true, force: true });

  if (purge) {
    await Promise.all([
      rm(runtime.layout.configDir, { recursive: true, force: true }),
      rm(runtime.layout.stateDir, { recursive: true, force: true }),
    ]);
  }

  const retained = purge ? 'Kept workspace.' : 'Kept workspace, settings, tokens, and state.';
  return `Uninstalled xangi.\n${retained}\nReinstall: ${REINSTALL_COMMAND}`;
}
