import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'dotenv';
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

  it('defaults both OpenRouter protections ON and saves each option independently', () => {
    const settings = () => webStartupSettingsSnapshot().flatMap((g) => g.settings);
    for (const key of ['OPENROUTER_NO_TRAINING', 'OPENROUTER_ZDR']) {
      expect(settings().find((f) => f.key === key)).toMatchObject({
        defaultValue: 'true',
        value: 'true',
        applyMode: 'restart',
      });
    }
    updateWebStartupSetting({ key: 'OPENROUTER_ZDR', value: 'false' });
    expect(settings().find((f) => f.key === 'OPENROUTER_NO_TRAINING')?.value).toBe('true');
    expect(settings().find((f) => f.key === 'OPENROUTER_ZDR')?.value).toBe('false');
    expect(() =>
      updateWebStartupSetting({ key: 'OPENROUTER_NO_TRAINING', value: 'oops' })
    ).toThrow();
    updateWebStartupSetting({ key: 'OPENROUTER_NO_TRAINING', value: 'false' });
    expect(settings().find((f) => f.key === 'OPENROUTER_NO_TRAINING')?.value).toBe('false');
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

  it('exposes question deadlines, stop/reply selection, and a free-text reply', () => {
    const settings = webStartupSettingsSnapshot().flatMap((g) => g.settings);
    expect(settings.find((s) => s.key === 'AGENT_USER_INPUT_TIMEOUT_MS')).toMatchObject({
      value: '600000',
      min: 1000,
      max: 86400000,
    });
    expect(settings.find((s) => s.key === 'AGENT_USER_INPUT_TIMEOUT_ACTION')).toMatchObject({
      value: 'reply',
      options: ['reply', 'stop'],
    });
    expect(settings.find((s) => s.key === 'AGENT_USER_INPUT_TIMEOUT_MESSAGE')).toMatchObject({
      type: 'textarea',
    });
    updateWebStartupSetting({ key: 'AGENT_USER_INPUT_TIMEOUT_ACTION', value: 'stop' });
    expect(() =>
      updateWebStartupSetting({ key: 'AGENT_USER_INPUT_TIMEOUT_ACTION', value: 'oops' })
    ).toThrow();
    expect(() =>
      updateWebStartupSetting({ key: 'AGENT_USER_INPUT_TIMEOUT_MS', value: '0' })
    ).toThrow();
  });

  it('round-trips a multiline free-text reply without adding environment variables', async () => {
    const value =
      '今は回答できません。\n"引用" と \'単引用\' と `code`、#comment $& \\n\nINJECTED_SETTING=true\u2028末尾\u2029行';
    updateWebStartupSetting({ key: 'AGENT_USER_INPUT_TIMEOUT_MESSAGE', value });
    expect(
      webStartupSettingsSnapshot()
        .flatMap((g) => g.settings)
        .find((s) => s.key === 'AGENT_USER_INPUT_TIMEOUT_MESSAGE')?.value
    ).toBe(value);
    const env = parse(readFileSync(process.env.XANGI_ENV_PATH!));
    expect(env.INJECTED_SETTING).toBeUndefined();
    vi.stubEnv('AGENT_USER_INPUT_TIMEOUT_MESSAGE', env.AGENT_USER_INPUT_TIMEOUT_MESSAGE);
    try {
      const { userInputTimeoutMessage } = await import('../src/user-input.js');
      expect(userInputTimeoutMessage()).toBe(value);
    } finally {
      vi.unstubAllEnvs();
    }
    updateWebStartupSetting({ key: 'AGENT_USER_INPUT_TIMEOUT_MESSAGE', value: '' });
    expect(
      webStartupSettingsSnapshot()
        .flatMap((g) => g.settings)
        .find((s) => s.key === 'AGENT_USER_INPUT_TIMEOUT_MESSAGE')?.value
    ).toBe('');
    expect(() =>
      updateWebStartupSetting({ key: 'AGENT_USER_INPUT_TIMEOUT_MESSAGE', value: 'a'.repeat(4001) })
    ).toThrow();
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
  it('saves an OpenRouter key write-only without an account confirmation setting', async () => {
    await updateWebConnectionSetting({
      key: 'OPENROUTER_API_KEY',
      value: 'openrouter-test-secret',
    });
    const snapshot = await webConnectionSettingsSnapshot(authenticationSnapshot);
    expect(
      snapshot.groups.flatMap((g) => g.fields).find((f) => f.key === 'OPENROUTER_API_KEY')
    ).toMatchObject({ configured: true, type: 'password' });
    expect(JSON.stringify(snapshot)).not.toContain('openrouter-test-secret');
    const setting = () =>
      webStartupSettingsSnapshot()
        .flatMap((g) => g.settings)
        .find((f) => f.key === 'OPENROUTER_PRIVACY_CONFIRMED');
    expect(setting()).toBeUndefined();
    expect(() =>
      updateWebStartupSetting({ key: 'OPENROUTER_PRIVACY_CONFIRMED', value: 'true' })
    ).toThrow('変更できない');
    expect(readFileSync(process.env.XANGI_ENV_PATH!, 'utf8')).not.toContain(
      'openrouter-test-secret'
    );
  });
});
