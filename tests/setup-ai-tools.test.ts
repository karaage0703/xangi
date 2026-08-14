import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xangi-ai-tools-'));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await mkdir(home);
  await mkdir(bin);
  return { root, home, bin };
}

async function fakeCommand(path: string, body: string) {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

describe('standalone AI coding tool setup', () => {
  it('check reports versions and rule-based authentication without changing state', async () => {
    const data = await fixture();
    await fakeCommand(
      join(data.bin, 'codex'),
      '[ "$1 $2" = "login status" ] && exit 0\n[ "$1" = "--version" ] && echo "codex 1.2.3"'
    );
    await fakeCommand(
      join(data.bin, 'claude'),
      '[ "$1 $2" = "auth status" ] && exit 1\n[ "$1" = "--version" ] && echo "claude 4.5.6"'
    );

    const result = await exec('bash', ['packaging/setup-ai-tools.sh', 'check'], {
      env: { ...process.env, HOME: data.home, PATH: `${data.bin}:/usr/bin:/bin` },
    });
    expect(result.stdout).toContain('codex          ready (codex 1.2.3)');
    expect(result.stdout).toContain('claude-code    installed; login required (claude 4.5.6)');
    expect(result.stdout).toContain('cursor         not installed');
    expect(result.stdout).toContain('github-copilot not installed');
  });

  it('launches GitHub Copilot for interactive /login without reinstalling it', async () => {
    const data = await fixture();
    const log = join(data.root, 'copilot.log');
    await fakeCommand(
      join(data.bin, 'copilot'),
      `printf '%s\\n' "$*" >> '${log}'\n[ "$1" = "--version" ] && echo "copilot 1.0.79"\nexit 0`
    );
    const result = await exec('bash', ['packaging/setup-ai-tools.sh', 'github-copilot'], {
      env: { ...process.env, HOME: data.home, PATH: `${data.bin}:/usr/bin:/bin` },
    });
    expect(result.stdout).toContain('/login');
    await expect((await import('node:fs/promises')).readFile(log, 'utf8')).resolves.toContain('\n');
  });

  it('guides Codex users through nvm setup before installing Node.js', async () => {
    const data = await fixture();
    const error = await exec('/bin/bash', ['packaging/setup-ai-tools.sh', 'codex'], {
      env: { HOME: data.home, PATH: data.bin },
    }).catch((cause: unknown) => cause as { stderr: string });
    expect(error.stderr).toContain('Codexの導入にはNode.jsとnpmが必要です');
    expect(error.stderr).toContain(
      'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash'
    );
    expect(error.stderr).toContain('現在のTerminalを閉じて、新しいTerminalを開きます');
    expect(error.stderr).toContain('command -v nvm\n   nvm install --lts');
    expect(error.stderr).toContain('https://github.com/nvm-sh/nvm');
  });

  it('does not reinstall or relogin an already ready tool', async () => {
    const data = await fixture();
    const log = join(data.root, 'codex.log');
    await fakeCommand(
      join(data.bin, 'codex'),
      `printf '%s\\n' "$*" >> '${log}'\n[ "$1 $2" = "login status" ] && exit 0\nexit 0`
    );
    const result = await exec('bash', ['packaging/setup-ai-tools.sh', 'codex'], {
      env: { ...process.env, HOME: data.home, PATH: `${data.bin}:/usr/bin:/bin` },
    });
    expect(result.stdout).toContain('インストール・認証済み');
  });

  it('runs as a process-substitution one-liner while keeping stdin for login', async () => {
    const data = await fixture();
    const loginLog = join(data.root, 'cursor-login.log');
    await fakeCommand(
      join(data.bin, 'cursor-agent'),
      `[ "$1" = "status" ] && exit 1\nif [ "$1" = "login" ]; then read answer; printf '%s\\n' "$answer" > '${loginLog}'; fi`
    );

    await exec(
      'bash',
      [
        '-c',
        'printf "confirmed\\n" | bash <(cat "$1") cursor',
        'setup-ai-tools-one-liner',
        'packaging/setup-ai-tools.sh',
      ],
      { env: { ...process.env, HOME: data.home, PATH: `${data.bin}:/usr/bin:/bin` } }
    );
    await expect((await import('node:fs/promises')).readFile(loginLog, 'utf8')).resolves.toBe(
      'confirmed\n'
    );
  });
});
