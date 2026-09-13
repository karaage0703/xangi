import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/setup/secret-store.js';
import {
  updateWebConnectionSetting,
  updateWebStartupSetting,
  webConnectionSettingsSnapshot,
  webStartupSettingsSnapshot,
} from '../src/web-startup-settings.js';

describe('Web startup settings', () => {
  let root: string;
  const authenticationSnapshot = async () => [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'web-startup-settings-'));
    process.env.XANGI_ENV_PATH = join(root, '.env');
    process.env.XDG_CONFIG_HOME = join(root, 'config');
    writeFileSync(
      process.env.XANGI_ENV_PATH,
      'DISCORD_STREAMING=false\nDISCORD_TOKEN=env-secret\n'
    );
  });

  afterEach(() => {
    delete process.env.XANGI_ENV_PATH;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.DISCORD_STREAMING;
    rmSync(root, { recursive: true, force: true });
  });

  it('returns only allowlisted non-secret settings with restart timing', () => {
    const settings = webStartupSettingsSnapshot().flatMap((group) => group.settings);
    expect(settings.find((setting) => setting.key === 'DISCORD_STREAMING')).toMatchObject({
      value: 'false',
      applyMode: 'restart',
    });
    expect(settings.some((setting) => setting.key === 'DISCORD_TOKEN')).toBe(false);
  });

  it('validates and persists settings without mutating the running process', () => {
    process.env.DISCORD_STREAMING = 'false';
    expect(updateWebStartupSetting({ key: 'DISCORD_STREAMING', value: 'true' })).toContain(
      '再起動後'
    );
    expect(readFileSync(process.env.XANGI_ENV_PATH, 'utf8')).toContain('DISCORD_STREAMING=true');
    expect(process.env.DISCORD_STREAMING).toBe('false');
    expect(() => updateWebStartupSetting({ key: 'DISCORD_TOKEN', value: 'leak' })).toThrow(
      '変更できない'
    );
  });

  it('reports secret presence without returning values', async () => {
    const store = new SecretStore(join(process.env.XDG_CONFIG_HOME!, 'xangi', 'secrets.json'));
    await store.set('SLACK_BOT_TOKEN', 'stored-secret');
    const serialized = JSON.stringify(
      (await webConnectionSettingsSnapshot(authenticationSnapshot)).groups
    );
    expect(serialized).not.toContain('env-secret');
    expect(serialized).not.toContain('stored-secret');
    expect(serialized).toContain('"configured":true');
  });

  it('accepts only allowlisted write-only connection values', async () => {
    const message = await updateWebConnectionSetting({
      key: 'ANTHROPIC_API_KEY',
      value: 'new-secret-value',
    });
    const store = new SecretStore(join(process.env.XDG_CONFIG_HOME!, 'xangi', 'secrets.json'));

    expect(message).toContain('再起動後');
    expect(message).not.toContain('new-secret-value');
    expect(await store.get('ANTHROPIC_API_KEY')).toBe('new-secret-value');
    expect(
      JSON.stringify(await webConnectionSettingsSnapshot(authenticationSnapshot))
    ).not.toContain('new-secret-value');
    await expect(
      updateWebConnectionSetting({ key: 'UNSAFE_SECRET', value: 'value' })
    ).rejects.toThrow('変更できない');
    await expect(
      updateWebConnectionSetting({ key: 'ANTHROPIC_API_KEY', value: 'line1\nline2' })
    ).rejects.toThrow('制御文字');
  });
});
