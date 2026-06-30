import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const WRAPPER_DIR = '/tmp/xangi-gh-wrapper';
const WRAPPER_ENV_PATH = `${WRAPPER_DIR}/env.sh`;
const GH_WRAPPER_PATH = `${WRAPPER_DIR}/gh`;
const GIT_WRAPPER_PATH = `${WRAPPER_DIR}/git`;
const GIT_CREDENTIAL_HELPER_PATH = `${WRAPPER_DIR}/git-credential-helper`;

describe('github-auth gh wrapper env', () => {
  const originalEnv = { ...process.env };
  let tempDir: string | undefined;

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    vi.resetModules();
  });

  async function enableGitHubApp() {
    tempDir = mkdtempSync(join(tmpdir(), 'xangi-github-auth-'));
    const keyPath = join(tempDir, 'github-app.pem');
    writeFileSync(keyPath, 'dummy private key');

    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_APP_INSTALLATION_ID = '456';
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;

    const mod = await import('../src/github-auth.js');
    mod.initGitHubAuth();
    return mod;
  }

  it('keeps the gh wrapper directory at the front of PATH without duplicates', async () => {
    const { getGitHubEnv } = await enableGitHubApp();

    const env = getGitHubEnv({
      PATH: `/home/user/.local/bin:${WRAPPER_DIR}:/usr/bin`,
    });

    expect(env.PATH).toBe(`${WRAPPER_DIR}:/home/user/.local/bin:/usr/bin`);
    expect(env.PATH.split(':').filter((entry) => entry === WRAPPER_DIR)).toHaveLength(1);
    expect(env.BASH_ENV).toBe(WRAPPER_ENV_PATH);
  });

  it('generates a shell hook that re-asserts the gh wrapper directory', async () => {
    await enableGitHubApp();

    const output = execFileSync('/bin/bash', ['-c', '. "$BASH_ENV"; printf %s "$PATH"'], {
      env: {
        ...process.env,
        PATH: `/home/user/.local/bin:${WRAPPER_DIR}:/usr/bin:/bin`,
        BASH_ENV: WRAPPER_ENV_PATH,
      },
      encoding: 'utf8',
    });

    expect(output).toBe(`${WRAPPER_DIR}:/home/user/.local/bin:/usr/bin:/bin`);
  });

  it('generates gh and git wrappers in the wrapper directory', async () => {
    await enableGitHubApp();

    expect(existsSync(GH_WRAPPER_PATH)).toBe(true);
    expect(existsSync(GIT_WRAPPER_PATH)).toBe(true);
    expect(existsSync(GIT_CREDENTIAL_HELPER_PATH)).toBe(true);

    const ghWrapper = readFileSync(GH_WRAPPER_PATH, 'utf8');
    expect(ghWrapper).toContain('$XANGI_TOOL_SERVER/github-token');
    expect(ghWrapper).not.toContain('which -a gh');

    const gitWrapper = readFileSync(GIT_WRAPPER_PATH, 'utf8');
    expect(gitWrapper).toContain('credential.helper=');
    expect(gitWrapper).toContain(
      `credential.https://github.com.helper=!${GIT_CREDENTIAL_HELPER_PATH}`
    );
    expect(gitWrapper).not.toContain('which -a git');

    const gitCredentialHelper = readFileSync(GIT_CREDENTIAL_HELPER_PATH, 'utf8');
    expect(gitCredentialHelper).toContain('username=x-access-token');
    expect(gitCredentialHelper).toContain('$XANGI_TOOL_SERVER/github-token');
  });

  it('puts gh and git wrappers ahead of regular commands after the shell hook runs', async () => {
    await enableGitHubApp();

    const output = execFileSync(
      '/bin/bash',
      ['-c', '. "$BASH_ENV"; command -v gh; command -v git'],
      {
        env: {
          ...process.env,
          PATH: `/usr/bin:${WRAPPER_DIR}:/bin`,
          BASH_ENV: WRAPPER_ENV_PATH,
        },
        encoding: 'utf8',
      }
    )
      .trim()
      .split('\n');

    expect(output).toEqual([GH_WRAPPER_PATH, GIT_WRAPPER_PATH]);
  });
});
