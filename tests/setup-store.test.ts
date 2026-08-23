import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SetupStore, SetupValidationError, parseSetupConfig } from '../src/setup/store.js';

describe('typed setup config', () => {
  const valid = {
    backend: 'codex',
    workspacePath: '/Users/example/xangi-workspace',
    webChatEnabled: true,
    webChatAccess: 'local',
  };

  it('accepts only the documented fields and backend values', () => {
    expect(parseSetupConfig(valid)).toEqual(valid);
    expect(() => parseSetupConfig({ ...valid, admin: true })).toThrow(SetupValidationError);
    expect(() => parseSetupConfig({ ...valid, backend: 'shell' })).toThrow(SetupValidationError);
    expect(() => parseSetupConfig({ ...valid, webChatAccess: 'public' })).toThrow(
      SetupValidationError
    );
  });

  it('accepts only an absolute executable matching the selected backend command', () => {
    expect(
      parseSetupConfig({ ...valid, backendExecutable: '/Users/example/.nvm/bin/codex' })
    ).toMatchObject({ backendExecutable: '/Users/example/.nvm/bin/codex' });
    expect(() => parseSetupConfig({ ...valid, backendExecutable: 'codex' })).toThrow(
      SetupValidationError
    );
    expect(() => parseSetupConfig({ ...valid, backendExecutable: '/tmp/claude' })).toThrow(
      SetupValidationError
    );
    expect(() =>
      parseSetupConfig({ ...valid, backendExecutable: '/tmp/codex\nmalicious' })
    ).toThrow(SetupValidationError);
  });

  it('requires an absolute workspace path and all typed fields', () => {
    expect(() => parseSetupConfig({ ...valid, workspacePath: 'relative/path' })).toThrow(
      SetupValidationError
    );
    expect(() =>
      parseSetupConfig({ backend: 'codex', workspacePath: valid.workspacePath })
    ).toThrow(SetupValidationError);
  });

  it('accepts an xangi-owned OpenCode config and rejects it for other backends', () => {
    const opencode = {
      ...valid,
      backend: 'opencode',
      model: 'xangi-local/qwen3.8-27b',
      opencodeConfigPath: '/Users/example/.config/xangi/opencode.json',
    };
    expect(parseSetupConfig(opencode)).toEqual(opencode);
    expect(() => parseSetupConfig({ ...opencode, backend: 'codex' })).toThrow(
      SetupValidationError
    );
    expect(() => parseSetupConfig({ ...opencode, opencodeConfigPath: 'opencode.json' })).toThrow(
      SetupValidationError
    );
    expect(() => parseSetupConfig({ ...opencode, model: undefined })).toThrow(
      SetupValidationError
    );
  });

  it('ignores the removed legacy Notion sync flag', () => {
    expect(parseSetupConfig({ ...valid, notionSyncEnabled: true })).toEqual(valid);
  });
});

describe('SetupStore', () => {
  let directory: string;
  let configPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xangi-setup-store-'));
    configPath = join(directory, 'config', 'setup.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('leaves an existing config byte-for-byte unchanged for invalid input', async () => {
    await writeFile(join(directory, 'existing.json'), 'original\n', { mode: 0o640 });
    const existingPath = join(directory, 'existing.json');
    const store = new SetupStore(existingPath);

    await expect(
      store.save({
        backend: 'codex',
        workspacePath: '/Users/example/workspace',
        webChatEnabled: true,
        webChatAccess: 'local',
        unexpected: 'not allowed',
      })
    ).rejects.toBeInstanceOf(SetupValidationError);

    expect(await readFile(existingPath, 'utf8')).toBe('original\n');
    expect((await stat(existingPath)).mode & 0o777).toBe(0o640);
  });

  it('atomically saves a valid allowlisted config with mode 0600', async () => {
    const store = new SetupStore(configPath);
    await store.save({
      backend: 'claude-code',
      workspacePath: '/Users/example/My Workspace',
      webChatEnabled: true,
      webChatAccess: 'tailscale',
    });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      backend: 'claude-code',
      workspacePath: '/Users/example/My Workspace',
      webChatEnabled: true,
      webChatAccess: 'tailscale',
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(
      (await readdir(join(directory, 'config'))).filter((name) => name.includes('.tmp-'))
    ).toEqual([]);
  });
});
