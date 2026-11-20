import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAppLayout } from '../installer/layout.js';
import { SecretStore } from './secret-store.js';

export interface RuntimeSecretOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  homeDir?: string;
  names?: readonly string[];
}

export async function loadStoredSecrets(options: RuntimeSecretOptions = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  const layout = resolveAppLayout({
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    homeDir: options.homeDir ?? homedir(),
    xdgDataHome: env.XDG_DATA_HOME,
    xdgConfigHome: env.XDG_CONFIG_HOME,
    xdgStateHome: env.XDG_STATE_HOME,
  });
  const secrets = await new SecretStore(join(layout.configDir, 'secrets.json')).all();
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (options.names && !options.names.includes(name)) continue;
    // An explicit empty value opts out of the optional Agy API key mode.
    if (name === 'GEMINI_API_KEY' && env[name] !== undefined) continue;
    if (env[name]) continue;
    env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
