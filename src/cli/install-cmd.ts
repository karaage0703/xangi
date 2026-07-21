import { access, mkdir } from 'node:fs/promises';
import {
  executeManagedUpdate,
  resolveManagedRuntime,
  type InstallerFlags,
  type ManagedCommandDependencies,
} from './update-cmd.js';
import type { AppLayout } from '../installer/types.js';
import { installConfiguredWorkspaceTemplate } from '../installer/workspace-template.js';

export interface InstallCommandDependencies extends ManagedCommandDependencies {
  ensureConfigured?: (layout: AppLayout) => Promise<void>;
  initializeWorkspace?: (layout: AppLayout) => Promise<{ workspacePath: string }>;
}

export async function installCmd(
  flags: InstallerFlags,
  dependencies: InstallCommandDependencies = {}
): Promise<string> {
  const runtime = await resolveManagedRuntime(flags, dependencies);
  await Promise.all([
    mkdir(runtime.layout.stateDir, { recursive: true }),
    mkdir(runtime.layout.configDir, { recursive: true }),
  ]);
  await (dependencies.ensureConfigured ?? requireSetupConfiguration)(runtime.layout);
  const { workspacePath } = await (
    dependencies.initializeWorkspace ?? installConfiguredWorkspaceTemplate
  )(runtime.layout);

  const hadService = (await runtime.service.status()).running;
  const hadUpdateScheduler = (await runtime.updateScheduler.status()).installed;
  let installAttempted = false;
  let updateSchedulerInstallAttempted = false;
  try {
    const result = await executeManagedUpdate(flags, {
      ...dependencies,
      forceActivate: true,
      layout: runtime.layout,
      manifestVerifier: runtime.manifestVerifier,
      service: {
        status: () => runtime.service.status(),
        openBrowser: (url) => runtime.service.openBrowser(url),
        install: () => runtime.service.install(),
        start: () => runtime.service.start(),
        stop: () => runtime.service.stop(),
        autostart: (enabled) => runtime.service.autostart(enabled),
        uninstall: () => runtime.service.uninstall(),
        async restart() {
          if (!hadService && !installAttempted) {
            installAttempted = true;
            await runtime.service.install();
          } else {
            await runtime.service.restart();
          }
        },
      },
    });
    if (!hadUpdateScheduler) {
      updateSchedulerInstallAttempted = true;
      await runtime.updateScheduler.install();
    }
    return `Installed xangi ${result.version} (workspace: ${workspacePath})`;
  } catch (error) {
    if (!hadUpdateScheduler && updateSchedulerInstallAttempted) {
      await runtime.updateScheduler.uninstall().catch(() => undefined);
    }
    if (!hadService && installAttempted) {
      await runtime.service.uninstall().catch(() => undefined);
    }
    throw error;
  }
}

export async function requireSetupConfiguration(layout: AppLayout): Promise<void> {
  try {
    await access(layout.configFile);
  } catch {
    throw new Error('xangiの設定がありません。先に `xangi setup` を実行してください');
  }
}
