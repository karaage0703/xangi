import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startSecretSettingsServer, type SecretSettingsServer } from '../src/cli/settings-cmd.js';
import { SecretStore } from '../src/setup/secret-store.js';

const roots: string[] = [];
const servers: SecretSettingsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('secret settings UI', () => {
  it('never renders stored values and saves submitted tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-settings-ui-'));
    roots.push(root);
    const store = new SecretStore(join(root, 'secrets.json'));
    await store.set('DISCORD_TOKEN', 'existing-discord-secret');
    const server = await startSecretSettingsServer({ store, timeoutMs: 5_000 });
    servers.push(server);

    const page = await fetch(server.url);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(html).toContain('Discord');
    expect(html).toContain('DISCORD_ALLOWED_USER');
    expect(html).toContain('許可ユーザーID');
    expect(html).not.toContain('Notion');
    expect(html).toContain('設定済み');
    expect(html).not.toContain('existing-discord-secret');

    const origin = new URL(server.url).origin;
    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        DISCORD_TOKEN: '',
        DISCORD_ALLOWED_USER: '123456789012345678, 987654321098765432',
        SLACK_BOT_TOKEN: 'xoxb-new-secret',
        SLACK_APP_TOKEN: 'xapp-new-secret',
      }),
    });
    expect(response.status).toBe(200);
    expect(await server.completion).toBe(3);
    expect(await store.get('DISCORD_TOKEN')).toBe('existing-discord-secret');
    expect(await store.get('DISCORD_ALLOWED_USER')).toBe(
      '123456789012345678,987654321098765432'
    );
    expect(await store.get('SLACK_BOT_TOKEN')).toBe('xoxb-new-secret');
    expect(await store.get('SLACK_APP_TOKEN')).toBe('xapp-new-secret');
  });

  it('rejects an invalid Discord allowed-user value without saving it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-settings-ui-'));
    roots.push(root);
    const store = new SecretStore(join(root, 'secrets.json'));
    const server = await startSecretSettingsServer({ store, timeoutMs: 5_000 });
    servers.push(server);

    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ DISCORD_ALLOWED_USER: 'not-a-user' }),
    });

    expect(response.status).toBe(400);
    expect(await store.get('DISCORD_ALLOWED_USER')).toBeUndefined();
  });

  it('rejects requests without the one-time URL token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-settings-ui-'));
    roots.push(root);
    const server = await startSecretSettingsServer({
      store: new SecretStore(join(root, 'secrets.json')),
      timeoutMs: 5_000,
    });
    servers.push(server);

    expect((await fetch(`${new URL(server.url).origin}/settings`)).status).toBe(404);
    const response = await fetch(`${new URL(server.url).origin}/settings`, {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ DISCORD_TOKEN: 'must-not-be-stored' }),
    });
    expect(response.status).toBe(404);
  });

  it('accepts a valid one-time form POST with an opaque browser Origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-settings-ui-'));
    roots.push(root);
    const store = new SecretStore(join(root, 'secrets.json'));
    const server = await startSecretSettingsServer({ store, timeoutMs: 5_000 });
    servers.push(server);

    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        Origin: 'null',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ DISCORD_TOKEN: 'discord-new-secret' }),
    });

    expect(response.status).toBe(200);
    expect(await server.completion).toBe(1);
    expect(await store.get('DISCORD_TOKEN')).toBe('discord-new-secret');
  });
});
