import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveEnvFilePath, updateEnvKeyValue, updateEnvKeyValues } from '../src/env-persist.js';

describe('resolveEnvFilePath', () => {
  const savedXangiEnvPath = process.env.XANGI_ENV_PATH;
  const savedCwd = process.cwd();

  afterEach(() => {
    if (savedXangiEnvPath === undefined) {
      delete process.env.XANGI_ENV_PATH;
    } else {
      process.env.XANGI_ENV_PATH = savedXangiEnvPath;
    }
    process.chdir(savedCwd);
  });

  it('XANGI_ENV_PATH が未設定なら process.cwd() + /.env を返す', () => {
    delete process.env.XANGI_ENV_PATH;
    expect(resolveEnvFilePath()).toBe(join(process.cwd(), '.env'));
  });

  it('XANGI_ENV_PATH が設定されていればそれを返す', () => {
    process.env.XANGI_ENV_PATH = '/workspace/.env';
    expect(resolveEnvFilePath()).toBe('/workspace/.env');
  });

  it('XANGI_ENV_PATH が空文字なら fallback (Falsy 判定)', () => {
    process.env.XANGI_ENV_PATH = '';
    expect(resolveEnvFilePath()).toBe(join(process.cwd(), '.env'));
  });
});

describe('updateEnvKeyValues', () => {
  it('updates the backend and removes an explicit model in one write', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'xangi-env-persist-many-'));
    const envPath = join(workdir, '.env');
    const previous = process.env.XANGI_ENV_PATH;
    try {
      writeFileSync(envPath, 'OTHER=keep\nAGENT_BACKEND=codex\nAGENT_MODEL=gpt-old\n');
      process.env.XANGI_ENV_PATH = envPath;

      expect(
        updateEnvKeyValues({ AGENT_BACKEND: 'claude-code', AGENT_MODEL: undefined }).ok
      ).toBe(true);
      expect(readFileSync(envPath, 'utf8')).toBe('OTHER=keep\nAGENT_BACKEND=claude-code\n');
    } finally {
      if (previous === undefined) delete process.env.XANGI_ENV_PATH;
      else process.env.XANGI_ENV_PATH = previous;
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('rejects newline injection without modifying the file', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'xangi-env-persist-newline-'));
    const envPath = join(workdir, '.env');
    const previous = process.env.XANGI_ENV_PATH;
    try {
      writeFileSync(envPath, 'AGENT_MODEL=gpt-old\n');
      process.env.XANGI_ENV_PATH = envPath;

      const result = updateEnvKeyValues({ AGENT_MODEL: 'gpt-new\nINJECTED=value' });
      expect(result.ok).toBe(false);
      expect(readFileSync(envPath, 'utf8')).toBe('AGENT_MODEL=gpt-old\n');
    } finally {
      if (previous === undefined) delete process.env.XANGI_ENV_PATH;
      else process.env.XANGI_ENV_PATH = previous;
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe('updateEnvKeyValue', () => {
  let workdir: string;
  const savedXangiEnvPath = process.env.XANGI_ENV_PATH;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'xangi-env-persist-test-'));
  });

  afterEach(() => {
    if (savedXangiEnvPath === undefined) {
      delete process.env.XANGI_ENV_PATH;
    } else {
      process.env.XANGI_ENV_PATH = savedXangiEnvPath;
    }
    rmSync(workdir, { recursive: true, force: true });
  });

  it('既存 key を value で置換する', () => {
    const envPath = join(workdir, '.env');
    writeFileSync(envPath, 'FOO=oldval\nBAR=baz\n');
    process.env.XANGI_ENV_PATH = envPath;

    const result = updateEnvKeyValue('FOO', 'newval');
    expect(result.ok).toBe(true);
    expect(result.envPath).toBe(envPath);

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('FOO=newval');
    expect(content).not.toContain('FOO=oldval');
    expect(content).toContain('BAR=baz'); // 他 key は変わらない
  });

  it('未存在 key を末尾に追記する', () => {
    const envPath = join(workdir, '.env');
    writeFileSync(envPath, 'FOO=val\n');
    process.env.XANGI_ENV_PATH = envPath;

    const result = updateEnvKeyValue('NEWKEY', 'newvalue');
    expect(result.ok).toBe(true);

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('FOO=val');
    expect(content).toContain('NEWKEY=newvalue');
  });

  it('.env ファイル不在なら ENOENT で graceful 失敗', () => {
    const envPath = join(workdir, 'nonexistent.env');
    process.env.XANGI_ENV_PATH = envPath;

    const result = updateEnvKeyValue('FOO', 'bar');
    expect(result.ok).toBe(false);
    expect(result.envPath).toBe(envPath);
    expect(result.reason).toContain('.env file not found');
    expect(result.reason).toContain('XANGI_ENV_PATH');
  });

  it('置換: 行頭以外の同名 key は変更しない', () => {
    const envPath = join(workdir, '.env');
    writeFileSync(envPath, 'BAR=foo with FOO=embedded\nFOO=actual\n');
    process.env.XANGI_ENV_PATH = envPath;

    const result = updateEnvKeyValue('FOO', 'changed');
    expect(result.ok).toBe(true);

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('FOO=changed');
    expect(content).toContain('BAR=foo with FOO=embedded'); // 文中の FOO= は変更されない
  });

  it('値に複数行が含まれる場合も置換は 1 行で済む', () => {
    const envPath = join(workdir, '.env');
    writeFileSync(envPath, 'X=1\nFOO=old\nY=2\n');
    process.env.XANGI_ENV_PATH = envPath;

    const result = updateEnvKeyValue('FOO', 'comma,separated,value');
    expect(result.ok).toBe(true);

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toBe('X=1\nFOO=comma,separated,value\nY=2\n');
  });

  it('特殊文字 (regex metachar) を含む key も正しく escape する', () => {
    const envPath = join(workdir, '.env');
    writeFileSync(envPath, 'KEY.NAME=old\n');
    process.env.XANGI_ENV_PATH = envPath;

    const result = updateEnvKeyValue('KEY.NAME', 'new');
    expect(result.ok).toBe(true);

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('KEY.NAME=new');
  });

  it('読み取り権限が無い場合も graceful 失敗 (例外を投げない)', () => {
    // permission denied は環境依存なので、シンプルに「存在しない directory」で代替
    const envPath = join(workdir, 'no-such-dir', '.env');
    process.env.XANGI_ENV_PATH = envPath;

    const result = updateEnvKeyValue('FOO', 'bar');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
