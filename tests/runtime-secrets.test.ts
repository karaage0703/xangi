import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/setup/secret-store.js';
import { loadStoredSecrets } from '../src/setup/runtime-secrets.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('loadStoredSecrets', () => {
  it('fills missing environment values without overriding explicit configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-runtime-secrets-'));
    roots.push(root);
    const configHome = join(root, 'config');
    await new SecretStore(join(configHome, 'xangi', 'secrets.json')).setMany({
      DISCORD_TOKEN: 'stored-discord',
      DISCORD_ALLOWED_USER: '123456789012345678',
      SLACK_APP_TOKEN: 'stored-slack-app',
    });
    const env: NodeJS.ProcessEnv = {
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      DISCORD_TOKEN: 'explicit-discord',
    };

    expect(await loadStoredSecrets({ env, platform: 'linux', arch: 'x64', homeDir: root })).toEqual(
      ['DISCORD_ALLOWED_USER', 'SLACK_APP_TOKEN']
    );
    expect(env.DISCORD_TOKEN).toBe('explicit-discord');
    expect(env.DISCORD_ALLOWED_USER).toBe('123456789012345678');
    expect(env.SLACK_APP_TOKEN).toBe('stored-slack-app');
  });
});
