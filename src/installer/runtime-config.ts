import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSetupConfig } from '../setup/schema.js';

export const SETUP_CONFIG_PATH_ENV = 'XANGI_SETUP_CONFIG_PATH';
export const SETUP_STATE_DIR_ENV = 'XANGI_SETUP_STATE_DIR';

export async function loadSetupRuntimeEnv(
  configPath: string,
  stateDir: string
): Promise<NodeJS.ProcessEnv> {
  if (!isAbsolute(stateDir)) throw new Error('Runtime state directory must be an absolute path');
  const config = parseSetupConfig(JSON.parse(await readFile(configPath, 'utf8')) as unknown);
  return {
    AGENT_BACKEND: config.backend,
    WORKSPACE_PATH: config.workspacePath,
    DATA_DIR: stateDir,
    WEB_CHAT_ENABLED: String(config.webChatEnabled),
    WEB_CHAT_HOST: config.webChatAccess === 'lan' ? '0.0.0.0' : '127.0.0.1',
    XANGI_NOTION_SYNC_ENABLED: String(config.notionSyncEnabled),
  };
}

/**
 * Apply the setup selected by the user after checkout-local `.env` loading.
 *
 * Managed services call `runConfiguredRuntime` directly. Source checkouts use
 * the same configuration by passing these two internal paths through their
 * process manager. Applying them here keeps setup values authoritative while
 * preserving checkout-only advanced settings that are not part of SetupConfig.
 */
export async function applySetupRuntimeEnvFromProcess(
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const configPath = env[SETUP_CONFIG_PATH_ENV];
  const stateDir = env[SETUP_STATE_DIR_ENV];
  if (!configPath && !stateDir) return false;
  if (!configPath || !stateDir) {
    throw new Error(
      `${SETUP_CONFIG_PATH_ENV} and ${SETUP_STATE_DIR_ENV} must be provided together`
    );
  }
  Object.assign(env, await loadSetupRuntimeEnv(configPath, stateDir));
  return true;
}

export async function runConfiguredRuntime(
  configPath: string,
  stateDir: string,
  entrypoint: string,
  importModule: (url: string) => Promise<unknown> = (url) => import(url)
): Promise<void> {
  Object.assign(process.env, await loadSetupRuntimeEnv(configPath, stateDir));
  await importModule(pathToFileURL(entrypoint).href);
}
