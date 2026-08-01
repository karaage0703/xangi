import type { ChildProcess } from 'child_process';
import { processManager } from './process-manager.js';
import { getSafeEnv } from './base-runner.js';
import { getGitHubEnv } from './github-auth.js';
import type { TimeoutController } from './timeout-controller.js';
import type { ChatPlatform } from './prompts/index.js';

export function buildCliEnv(channelId?: string, platform?: ChatPlatform): NodeJS.ProcessEnv {
  const safeEnv = getSafeEnv();
  const env: NodeJS.ProcessEnv = { ...safeEnv, ...getGitHubEnv(safeEnv) };
  if (channelId) {
    env.XANGI_CHANNEL_ID = channelId;
  } else {
    delete env.XANGI_CHANNEL_ID;
  }
  if (platform === 'discord' || platform === 'slack' || platform === 'web') {
    env.XANGI_PLATFORM = platform;
  } else {
    delete env.XANGI_PLATFORM;
  }
  return env;
}

export function registerManagedCliProcess(
  channelId: string | undefined,
  proc: ChildProcess,
  activeProcesses: Map<string, ChildProcess>,
  timeoutController: TimeoutController
): void {
  if (!channelId) return;

  activeProcesses.set(channelId, proc);
  processManager.register(channelId, proc);
  timeoutController.start(channelId, () => {
    const active = activeProcesses.get(channelId);
    if (active) active.kill();
  });
}

export function clearManagedCliProcess(
  channelId: string | undefined,
  activeProcesses: Map<string, ChildProcess>,
  timeoutController: TimeoutController,
  status: 'completed' | 'error'
): void {
  if (!channelId) return;

  activeProcesses.delete(channelId);
  timeoutController.clear(channelId, status);
}
