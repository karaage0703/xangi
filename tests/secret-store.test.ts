import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/setup/secret-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SecretStore', () => {
  it('atomically stores secrets outside the workspace with mode 0600', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-secret-store-'));
    roots.push(root);
    const path = join(root, 'config', 'secrets.json');
    const store = new SecretStore(path);

    await store.set('TELEGRAM_BOT_TOKEN', 'telegram-secret-value');

    expect(await store.get('TELEGRAM_BOT_TOKEN')).toBe('telegram-secret-value');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      secrets: { TELEGRAM_BOT_TOKEN: 'telegram-secret-value' },
    });
  });

  it('preserves existing secrets when another value is saved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-secret-store-'));
    roots.push(root);
    const store = new SecretStore(join(root, 'secrets.json'));
    await store.set('DISCORD_TOKEN', 'discord-secret');
    await store.set('SLACK_APP_TOKEN', 'slack-app-secret');

    expect(await store.get('DISCORD_TOKEN')).toBe('discord-secret');
    expect(await store.get('SLACK_APP_TOKEN')).toBe('slack-app-secret');
  });

  it('stores multiple values in one atomic update and returns a copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-secret-store-'));
    roots.push(root);
    const store = new SecretStore(join(root, 'secrets.json'));
    await store.setMany({ DISCORD_TOKEN: 'discord-secret', SLACK_BOT_TOKEN: 'slack-secret' });

    const values = await store.all();
    expect(values).toEqual({
      DISCORD_TOKEN: 'discord-secret',
      SLACK_BOT_TOKEN: 'slack-secret',
    });
    values.DISCORD_TOKEN = 'changed-only-in-copy';
    expect(await store.get('DISCORD_TOKEN')).toBe('discord-secret');
  });
});
