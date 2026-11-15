import { runCliInProcess } from './helpers/cli-in-process.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { spawn, spawnSync } from 'child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const XANGI = join(__dirname, '..', 'bin', 'xangi');

interface CapturedRequest {
  method?: string;
  url?: string;
  authorization?: string;
  body?: unknown;
}

let server: Server | null = null;
let serverUrl = '';
let requests: CapturedRequest[] = [];
let messagesPollCount = 0;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve(body);
      }
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
  stdinText?: string,
  executable = XANGI
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(executable, args, {
      env: {
        ...process.env,
        XANGI_CONFIG: '/tmp/xangi-cli-test-missing-config.json',
        XANGI_SKIP_ENV_FILE: 'true',
        XANGI_USE_TSX: 'true',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    if (stdinText !== undefined) {
      proc.stdin.end(stdinText);
    }
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body,
    });

    const parsedUrl = new URL(req.url || '/', serverUrl);
    if (parsedUrl.pathname === '/api/execute') {
      json(res, 200, { ok: true, result: 'extension action accepted' });
      return;
    }
    if (parsedUrl.pathname === '/api/sessions') {
      json(res, 200, {
        sessions: [
          {
            id: 'sess-1',
            title: 'Test Session',
            status: 'idle',
            updatedAt: '2026-07-06T00:00:00.000Z',
            lastMessage: 'hello',
          },
        ],
      });
      return;
    }
    if (parsedUrl.pathname === '/api/prompt') {
      json(res, 202, { ok: true, sessionId: 'sess-1', provider: 'codex', after: 100 });
      return;
    }
    if (parsedUrl.pathname === '/api/messages') {
      messagesPollCount++;
      json(res, 200, {
        sessionId: 'sess-1',
        provider: 'codex',
        state: messagesPollCount >= 2 ? 'idle' : 'busy',
        messages:
          messagesPollCount >= 2
            ? [{ id: 101, type: 'result', success: true, text: 'assistant reply' }]
            : [],
      });
      return;
    }
    if (parsedUrl.pathname === '/api/status') {
      json(res, 200, {
        sessionId: parsedUrl.searchParams.get('sessionId'),
        state: 'idle',
        provider: 'codex',
      });
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      serverUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  requests = [];
  messagesPollCount = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('xangi user-facing CLI', () => {
  function createFakePm2(options: Record<string, string> = {}): { dir: string; logFile: string } {
    const dir = mkdtempSync(join(tmpdir(), 'xangi-cli-pm2-'));
    const logFile = join(dir, 'pm2.log');
    const pm2Path = join(dir, 'pm2');
    writeFileSync(
      pm2Path,
      `#!/bin/sh
PM2_LOG='${logFile}'
${Object.entries(options)
  .map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`)
  .join('\n')}
echo "$@" >> "$PM2_LOG"
echo "runtime=$XANGI_SETUP_CONFIG_PATH|$XANGI_SETUP_STATE_DIR" >> "$PM2_LOG"
echo "caller=$FUTURE_FEATURE_ENABLED|$REMOTE_WORKER_PORT|$XANGI_ENV_PATH" >> "$PM2_LOG"
if [ "$1" = "--version" ]; then
  echo "5.0.0"
  exit 0
fi
if [ "$1" = "describe" ]; then
  exit "\${PM2_DESCRIBE_EXIT:-0}"
fi
if [ "$1" = "startup" ]; then
  if [ -n "$PM2_STARTUP_OUTPUT" ]; then
    echo "$PM2_STARTUP_OUTPUT"
  fi
  exit "\${PM2_STARTUP_EXIT:-0}"
fi
if [ "$1" = "unstartup" ]; then
  if [ -n "$PM2_UNSTARTUP_OUTPUT" ]; then
    echo "$PM2_UNSTARTUP_OUTPUT"
  fi
  exit "\${PM2_UNSTARTUP_EXIT:-0}"
fi
exit 0
`
    );
    chmodSync(pm2Path, 0o755);
    return { dir, logFile };
  }

  // Argument variants share one process; process-sensitive cases below retain bin/xangi.
  it.each(['workspace', 'agent', 'team'])('uses one management entrypoint for %s', async (name) => {
    const env = { XANGI_TOOL_SERVER: serverUrl };
    await runCliInProcess([name, 'list'], env);
    expect(requests.at(-1)?.body).toMatchObject({ command: name, flags: { action: 'list' } });
    const count = requests.length;
    await expect(runCliInProcess(['tool', name, '--action', 'list'], env)).rejects.toThrow(
      `Use xangi ${name} <action>`
    );
    expect(requests).toHaveLength(count);
    await runCliInProcess([name, '--help'], env);
    expect(requests.at(-1)?.body).toMatchObject({ command: 'help', flags: { topic: name } });
  });

  it.each([
    ['tool', '--help'],
    ['tool', '-h'],
    ['tool', 'system_restart', '--help'],
    ['agent', 'run', 'test-agent', '--help'],
    ['team', 'run', 'test-team', '-h'],
    ['workspace', 'delete', 'test-workspace', '--help'],
  ])('routes help without executing the action for %j', async (...args) => {
    await runCliInProcess(args, { XANGI_TOOL_SERVER: serverUrl });
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({
      command: 'help',
      flags:
        args[0] === 'tool'
          ? args[1].startsWith('-')
            ? {}
            : { topic: args[1] }
          : { topic: args[0] },
    });
  });

  it.each([['-h'], ['settings', '--help'], ['settings', '-h']])(
    'exits successfully through the launcher for help: %j',
    async (...args) => {
      const result = await runCli(args);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Usage:');
      if (args[0] === 'settings') expect(result.stdout).toContain('xangi settings');
      expect(result.stderr).toBe('');
      expect(requests).toHaveLength(0);
    }
  );

  it('documents managed install and update commands in help', async () => {
    const stdout = await runCliInProcess(['help']);
    expect(stdout).toContain('xangi --version');
    expect(stdout).toContain('xangi install');
    expect(stdout).toContain('xangi rescue');
    expect(stdout).toContain('xangi uninstall');
    expect(stdout).toContain('xangi update');
    expect(stdout).toContain('xangi worker install --pair');
    expect(stdout).not.toContain('notion-sync');
    expect(stdout).toContain('--allow-downgrade');
    expect(stdout).toContain('--purge');
    expect(stdout).toContain('--yes');
    expect(stdout).toContain('setup --apply');
    expect(stdout).toContain('--workspace-mode');
    expect(stdout).not.toContain('--browser');
  });

  it.each([
    ['extension', '--help'],
    ['extension', 'restart', '--help'],
    ['extension', 'restart', '-h'],
    ['extension', 'restart', 'xangi-studio', '--help'],
  ])('shows extension help without contacting the runtime for %s %s', async (...args) => {
    const stdout = await runCliInProcess(args, { XANGI_TOOL_SERVER: serverUrl });
    expect(stdout).toContain('xangi extension <start|stop|restart> --all');
    expect(stdout).toContain('xangi extension create');
    expect(requests).toHaveLength(0);
  });

  it('loads the extension development prompt without reading the registry or contacting the host', async () => {
    const stdout = await runCliInProcess(['extension', 'create'], {
      XANGI_TOOL_SERVER: serverUrl,
      XANGI_EXTENSIONS_FILE: '/missing-fixture-directory/extensions.json',
    });
    expect(stdout).toContain('Template publication target:');
    expect(stdout).toContain('ui,device,ai');
    expect(stdout).toContain("Continue the user's current request");
    expect(requests).toHaveLength(0);
  });

  it('shows create-specific help and rejects file creation arguments', async () => {
    expect(await runCliInProcess(['extension', 'create', '--help'])).toContain(
      'does not create files'
    );
    await expect(
      runCliInProcess(['extension', 'create', '--output', '/fixture-target'])
    ).rejects.toThrow('only prints guidance');
    await expect(runCliInProcess(['extension', 'create', 'fixture-name'])).rejects.toThrow(
      'only prints guidance'
    );
    expect(requests).toHaveLength(0);
  });

  it('does not initialize managed settings when printing the development guide', async () => {
    const root = mkdtempSync(join(tmpdir(), 'extension-create-readonly-'));
    try {
      const stdout = await runCliInProcess(['extension', 'create'], {
        XANGI_SKIP_ENV_FILE: 'false',
        XANGI_INSTALLATION_KIND: 'managed',
        XDG_CONFIG_HOME: join(root, 'configuration'),
        XDG_STATE_HOME: join(root, 'state'),
        XANGI_EXTENSIONS_FILE: join(root, 'registry', 'extensions.json'),
      });
      expect(stdout).toContain('Template publication target:');
      expect(() => readFileSync(join(root, 'registry', 'extensions.json'))).toThrow();
      expect(() => readFileSync(join(root, 'configuration', 'xangi', 'config.json'))).toThrow();
      expect(readdirSync(root)).toEqual([]);
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['start', 'stop', 'restart'])(
    'requires an ID or --all before %s can reach the runtime',
    async (action) => {
      await expect(
        runCliInProcess(['extension', action], { XANGI_TOOL_SERVER: serverUrl })
      ).rejects.toThrow('requires an ID or explicit --all');
      expect(requests).toHaveLength(0);
    }
  );

  it('forwards an explicit ID or --all and rejects their combination', async () => {
    const env = { XANGI_TOOL_SERVER: serverUrl };
    await runCliInProcess(['extension', 'restart', 'xangi-studio'], env);
    expect(requests[0].body).toMatchObject({
      command: 'extension_runtime',
      flags: { action: 'restart', id: 'xangi-studio' },
    });
    expect((requests[0].body as { flags: Record<string, string> }).flags).not.toHaveProperty('all');

    requests = [];
    await runCliInProcess(['extension', 'restart', '--all'], env);
    expect(requests[0].body).toMatchObject({
      command: 'extension_runtime',
      flags: { action: 'restart', all: 'true' },
    });
    expect((requests[0].body as { flags: Record<string, string> }).flags).not.toHaveProperty('id');

    requests = [];
    await expect(
      runCliInProcess(['extension', 'restart', 'xangi-studio', '--all'], env)
    ).rejects.toThrow('either an ID or --all');
    expect(requests).toHaveLength(0);
  });

  it('suggests AI rescue when service startup fails', async () => {
    const fakePm2 = createFakePm2();
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-rescue-guidance-'));
    try {
      const result = await runCli(['service', 'start', '--dir', xangiDir], {
        PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('ecosystem.config.cjs');
      expect(result.stderr).toContain('xangi rescue');
    } finally {
      rmSync(xangiDir, { recursive: true, force: true });
    }
  });

  it.each([['--help'], ['-h'], ['--managed', '--help']])(
    'prints update-specific help without running the updater for %s',
    async (...updateArgs) => {
      const stdout = await runCliInProcess(['update', ...updateArgs]);
      expect(stdout).toContain('Usage:');
      expect(stdout).toContain('xangi update --managed');
      expect(stdout).toContain('service is not restarted automatically');
    }
  );

  it.each([['--version'], ['-V'], ['version']])(
    'prints the Git description for a source checkout with %s',
    async (argument) => {
      const expected = spawnSync(
        'git',
        ['-C', join(__dirname, '..'), 'describe', '--tags', '--always', '--dirty'],
        { encoding: 'utf8' }
      )
        .stdout.trim()
        .replace(/^v(?=\d)/, '');

      const result = await runCli([argument]);

      expect(result).toEqual({ stdout: `xangi ${expected}\n`, stderr: '', code: 0 });
    }
  );

  it('connects to the port saved outside the managed release directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-cli-env-'));
    const configDir = join(root, 'xdg-config/xangi');
    mkdirSync(configDir, { recursive: true });
    const port = new URL(serverUrl).port;
    writeFileSync(
      join(configDir, 'runtime.env'),
      `WEB_CHAT_PORT=${port}\nXANGI_INSTALLATION_KIND=checkout\nXANGI_ENV_PATH=/wrong.env\n`
    );
    try {
      const result = await runCli(['sessions'], {
        XANGI_INSTALLATION_KIND: 'managed',
        XANGI_SKIP_ENV_FILE: 'false',
        XDG_CONFIG_HOME: join(root, 'xdg-config'),
        HOME: root,
        XANGI_URL: '',
        XANGI_CLI_URL: '',
        XANGI_TOKEN: 'test-token',
      });
      expect(result.code).toBe(0);
      expect(requests.some((request) => request.url?.startsWith('/api/sessions'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints the active managed release from the current version link', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'xangi-cli-version-'));
    const releaseDir = join(appRoot, 'versions', '1.2.3');
    mkdirSync(releaseDir, { recursive: true });
    symlinkSync(releaseDir, join(appRoot, 'current'), 'dir');
    try {
      const result = await runCli(['--version'], {
        XANGI_INSTALLATION_KIND: 'managed',
        XANGI_APP_ROOT: appRoot,
      });

      expect(result).toEqual({ stdout: 'xangi 1.2.3\n', stderr: '', code: 0 });
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it('starts when the CLI path includes the managed current symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xangi-cli-symlink-'));
    const projectRoot = join(__dirname, '..');
    const currentLink = join(root, 'current');
    symlinkSync(projectRoot, currentLink, 'dir');
    try {
      const result = await new Promise<{ stdout: string; stderr: string; code: number }>(
        (resolve) => {
          const proc = spawn(
            join(projectRoot, 'node_modules', '.bin', 'tsx'),
            [join(currentLink, 'src', 'cli', 'xangi-main.ts'), 'help'],
            { env: { ...process.env, XANGI_SKIP_ENV_FILE: 'true' } }
          );
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', (data) => {
            stdout += data.toString();
          });
          proc.stderr.on('data', (data) => {
            stderr += data.toString();
          });
          proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
        }
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('xangi — terminal client for xangi sessions');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies AI-guided setup choices through the deterministic CLI path', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'xangi-cli-guided-'));
    const binDir = join(homeDir, 'bin');
    const configHome = join(homeDir, 'config');
    const workspace = join(homeDir, 'workspace');
    mkdirSync(binDir, { recursive: true });
    const codex = join(binDir, 'codex');
    writeFileSync(codex, '#!/bin/sh\necho "codex test"\n');
    chmodSync(codex, 0o755);

    const result = await runCli(
      [
        'setup',
        '--apply',
        '--backend',
        'codex',
        '--workspace',
        workspace,
        '--workspace-mode',
        'blank',
        '--web-chat-access',
        'tailscale',
      ],
      {
        HOME: homeDir,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: join(homeDir, 'data'),
        XDG_STATE_HOME: join(homeDir, 'state'),
        PATH: `${binDir}:${process.env.PATH || ''}`,
      }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('AIとの対話を続けてください');
    const configPath = join(configHome, 'xangi', 'xangi.json');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      backend: 'codex',
      workspacePath: workspace,
      webChatAccess: 'tailscale',
    });
    expect(readFileSync(join(workspace, 'BOOTSTRAP.md'), 'utf8')).toContain(
      'Ask one question at a time in Japanese'
    );

    unlinkSync(join(workspace, 'BOOTSTRAP.md'));
    const complete = await runCli(['setup', '--complete'], {
      HOME: homeDir,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: join(homeDir, 'data'),
      XDG_STATE_HOME: join(homeDir, 'state'),
    });
    expect(complete.code).toBe(0);

    const access = await runCli(['setup', '--access', 'lan'], {
      HOME: homeDir,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: join(homeDir, 'data'),
      XDG_STATE_HOME: join(homeDir, 'state'),
    });
    expect(access.code).toBe(0);
    expect(access.stdout).toContain('Web Chat accessをlanに変更');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      workspacePath: workspace,
      webChatAccess: 'lan',
    });
  }, 15_000);

  it('lists sessions via the Even Terminal compatible API', async () => {
    const result = await runCli(['sessions', '--url', serverUrl, '--token', 'secret']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('sess-1');
    expect(result.stdout).toContain('Test Session');
    expect(requests[0].authorization).toBe('Bearer secret');
    expect(requests[0].url).toContain('/api/sessions');
  });

  it('runs service commands without Web API access and uses XANGI_PROCESS_NAME', async () => {
    const fakePm2 = createFakePm2();
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    writeFileSync(join(xangiDir, '.env'), 'XANGI_PROCESS_NAME=xangi-prod\n');
    writeFileSync(join(xangiDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');

    const result = await runCli(['service', 'restart', '--dir', xangiDir], {
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    const log = readFileSync(fakePm2.logFile, 'utf8');
    expect(log).toContain('describe xangi-prod');
    expect(log).toContain('delete xangi-prod');
    expect(log).toContain('start ecosystem.config.cjs --only xangi-prod');
  });

  it('selects an explicit checkout before loading the caller env or managed configuration', async () => {
    const fakePm2 = createFakePm2();
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    const callerEnv = join(fakePm2.dir, 'caller.env');
    writeFileSync(callerEnv, 'XANGI_PROCESS_NAME=wrong\nFUTURE_FEATURE_ENABLED=true\n');
    writeFileSync(join(xangiDir, '.env'), 'XANGI_PROCESS_NAME=target\n');
    writeFileSync(join(xangiDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');
    try {
      for (const mode of ['checkout', 'managed']) {
        const result = await runCli(['service', 'start', '--dir', xangiDir], {
          XANGI_SKIP_ENV_FILE: 'false',
          XANGI_ENV_PATH: callerEnv,
          XANGI_INSTALLATION_KIND: mode,
          XANGI_PROCESS_NAME: 'caller',
          REMOTE_WORKER_PORT: '18791',
          FUTURE_FEATURE_ENABLED: 'true',
          PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
        });
        expect(result.code, result.stderr).toBe(0);
      }
      const log = readFileSync(fakePm2.logFile, 'utf8');
      expect(log).toContain('start ecosystem.config.cjs --only target');
      expect(log).not.toContain('wrong');
      expect(log).not.toContain('18791');
      expect(log).not.toContain('true');
      expect(log).not.toContain(callerEnv);
    } finally {
      rmSync(xangiDir, { recursive: true, force: true });
      rmSync(fakePm2.dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'uses its own isolated checkout without --dir (checkout env: %s)',
    async (withCheckoutEnv) => {
      const fakePm2 = createFakePm2();
      const projectRoot = join(__dirname, '..');
      const checkout = mkdtempSync(join(tmpdir(), 'xangi-cli-checkout-'));
      try {
        // Copy source so import.meta.url resolves inside the fixture, never the
        // developer's checkout. Only dependencies are shared with this test run.
        cpSync(join(projectRoot, 'src'), join(checkout, 'src'), { recursive: true });
        cpSync(join(projectRoot, 'bin'), join(checkout, 'bin'), { recursive: true });
        cpSync(join(projectRoot, 'package.json'), join(checkout, 'package.json'));
        symlinkSync(join(projectRoot, 'node_modules'), join(checkout, 'node_modules'), 'dir');
        mkdirSync(join(checkout, '.git'));
        writeFileSync(join(fakePm2.dir, '.env'), 'XANGI_PROCESS_NAME=wrong\n');
        const fixturePath = `${fakePm2.dir}:${process.env.PATH || ''}`;
        if (withCheckoutEnv) {
          writeFileSync(
            join(checkout, '.env'),
            `XANGI_PROCESS_NAME=fixture-status\nPATH=${fixturePath}\n`
          );
        }
        const result = await runCli(
          ['service', 'status'],
          {
            XANGI_SKIP_ENV_FILE: 'false',
            XANGI_INSTALLATION_KIND: 'managed',
            XANGI_DIR: fakePm2.dir,
            XANGI_PROCESS_NAME: 'caller',
            XANGI_ENV_PATH: join(fakePm2.dir, '.env'),
            XDG_CONFIG_HOME: join(checkout, 'config'),
            HOME: checkout,
            PATH: fixturePath,
          },
          undefined,
          join(checkout, 'bin', 'xangi')
        );
        expect(result.code, result.stderr).toBe(0);
        const log = readFileSync(fakePm2.logFile, 'utf8');
        expect(log).toContain(
          `describe ${withCheckoutEnv ? 'fixture-status' : basename(checkout)}`
        );
        expect(log).not.toContain('wrong');
        expect(log).not.toContain('describe caller');
      } finally {
        rmSync(checkout, { recursive: true, force: true });
        rmSync(fakePm2.dir, { recursive: true, force: true });
      }
    }
  );

  it('uses the checkout workspace state with the saved setup config', async () => {
    const fakePm2 = createFakePm2();
    const homeDir = mkdtempSync(join(tmpdir(), 'xangi-checkout-setup-'));
    const configHome = join(homeDir, 'config');
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    const workspace = join(homeDir, 'workspace');
    mkdirSync(join(configHome, 'xangi'), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(xangiDir, '.git'));
    writeFileSync(
      join(configHome, 'xangi', 'xangi.json'),
      JSON.stringify({ backend: 'codex', workspacePath: workspace, webChatEnabled: true })
    );
    writeFileSync(join(xangiDir, '.env'), 'XANGI_PROCESS_NAME=xangi-dev\n');
    writeFileSync(join(xangiDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');

    const result = await runCli(['service', 'restart', '--dir', xangiDir], {
      HOME: homeDir,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: join(homeDir, 'data'),
      XDG_STATE_HOME: join(homeDir, 'state'),
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    const log = readFileSync(fakePm2.logFile, 'utf8');
    expect(log).toContain(
      `runtime=${join(configHome, 'xangi', 'xangi.json')}|${join(workspace, '.xangi')}`
    );
    expect(log).toContain('start ecosystem.config.cjs --only xangi-dev');
  });

  it('keeps an explicit checkout DATA_DIR when loading the saved setup config', async () => {
    const fakePm2 = createFakePm2();
    const homeDir = mkdtempSync(join(tmpdir(), 'xangi-checkout-data-dir-'));
    const configHome = join(homeDir, 'config');
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    const workspace = join(homeDir, 'workspace');
    const checkoutState = join(homeDir, 'checkout-state');
    mkdirSync(join(configHome, 'xangi'), { recursive: true });
    mkdirSync(join(xangiDir, '.git'));
    writeFileSync(
      join(configHome, 'xangi', 'xangi.json'),
      JSON.stringify({ backend: 'codex', workspacePath: workspace, webChatEnabled: true })
    );
    writeFileSync(
      join(xangiDir, '.env'),
      `XANGI_PROCESS_NAME=xangi-dev\nDATA_DIR=${checkoutState}\n`
    );
    writeFileSync(join(xangiDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');

    const result = await runCli(['service', 'restart', '--dir', xangiDir], {
      HOME: homeDir,
      XDG_CONFIG_HOME: configHome,
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    expect(readFileSync(fakePm2.logFile, 'utf8')).toContain(
      `runtime=${join(configHome, 'xangi', 'xangi.json')}|${checkoutState}`
    );
  });

  it('starts from PM2 config when the PM2 service is not registered yet', async () => {
    const fakePm2 = createFakePm2({ PM2_DESCRIBE_EXIT: '1' });
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    writeFileSync(join(xangiDir, '.env'), 'XANGI_INSTANCE_ID=xangi-dev\n');
    writeFileSync(join(xangiDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');

    const result = await runCli(['service', 'restart', '--dir', xangiDir], {
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    const log = readFileSync(fakePm2.logFile, 'utf8');
    expect(log).not.toContain('delete xangi-dev');
    expect(log).toContain('start ecosystem.config.cjs --only xangi-dev');
  });

  it('saves the PM2 process list and prints startup guidance for service autostart', async () => {
    const fakePm2 = createFakePm2();
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    writeFileSync(join(xangiDir, '.env'), 'XANGI_PROCESS_NAME=xangi-prod\n');

    const result = await runCli(['service', 'autostart', 'enable', '--dir', xangiDir], {
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('If pm2 printed a sudo command');
    const log = readFileSync(fakePm2.logFile, 'utf8');
    expect(log).toContain('save');
    expect(log).toContain('startup');
  });

  it('accepts PM2 startup sudo guidance even when pm2 exits non-zero', async () => {
    const fakePm2 = createFakePm2({
      PM2_STARTUP_EXIT: '1',
      PM2_STARTUP_OUTPUT: 'sudo env PATH=$PATH:/node/bin pm2 startup systemd',
    });
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    writeFileSync(join(xangiDir, '.env'), 'XANGI_PROCESS_NAME=xangi-prod\n');

    const result = await runCli(['service', 'autostart', 'enable', '--dir', xangiDir], {
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('sudo env PATH=');
    expect(result.stdout).toContain('If pm2 printed a sudo command');
    const log = readFileSync(fakePm2.logFile, 'utf8');
    expect(log).toContain('save');
    expect(log).toContain('startup');
  });

  it('removes the PM2 startup hook without stopping the current process', async () => {
    const fakePm2 = createFakePm2();
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    writeFileSync(join(xangiDir, '.env'), 'XANGI_PROCESS_NAME=xangi-prod\n');

    const result = await runCli(['service', 'autostart', 'disable', '--dir', xangiDir], {
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    const log = readFileSync(fakePm2.logFile, 'utf8');
    expect(log).toContain('unstartup');
    expect(log).not.toContain('stop');
    expect(log).not.toContain('save');
  });

  it('accepts PM2 unstartup sudo guidance even when pm2 exits non-zero', async () => {
    const fakePm2 = createFakePm2({
      PM2_UNSTARTUP_EXIT: '1',
      PM2_UNSTARTUP_OUTPUT: 'sudo env PATH=$PATH:/node/bin pm2 unstartup systemd',
    });
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    writeFileSync(join(xangiDir, '.env'), 'XANGI_PROCESS_NAME=xangi-prod\n');

    const result = await runCli(['service', 'autostart', 'disable', '--dir', xangiDir], {
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('pm2 unstartup');
    expect(result.stdout).toContain('sudo env PATH=');
  });

  it('loads token from XANGI_ENV_PATH when no token flag is provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xangi-cli-env-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'XANGI_EVEN_TERMINAL_TOKEN=env-secret\n');
    try {
      const result = await runCli(['sessions', '--url', serverUrl], {
        XANGI_ENV_PATH: envPath,
        XANGI_SKIP_ENV_FILE: 'false',
      });

      expect(result.code).toBe(0);
      expect(requests[0].authorization).toBe('Bearer env-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends prompts and waits for the final result by default', async () => {
    const result = await runCli([
      'send',
      '--url',
      serverUrl,
      '--session',
      'sess-1',
      '--timeout',
      '5000',
      'hello',
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('session: sess-1');
    expect(result.stdout).toContain('assistant reply');
    expect(requests.find((r) => r.url?.startsWith('/api/messages'))?.url).toContain('after=100');
    const prompt = requests.find((r) => r.url === '/api/prompt');
    expect(prompt?.body).toEqual({ text: 'hello', provider: 'codex', sessionId: 'sess-1' });
  });

  it('reads prompt text from stdin when send uses -', async () => {
    const result = await runCli(
      ['send', '--url', serverUrl, '--session', 'sess-1', '-', '--timeout', '5000'],
      {},
      'stdin prompt'
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('assistant reply');
    const prompt = requests.find((r) => r.url === '/api/prompt');
    expect(prompt?.body).toEqual({ text: 'stdin prompt', provider: 'codex', sessionId: 'sess-1' });
  });

  it('can send without waiting when --detach is set', async () => {
    const result = await runCli([
      'send',
      '--url',
      serverUrl,
      '--session',
      'sess-1',
      '--detach',
      'fire and forget',
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('session: sess-1');
    expect(result.stdout).not.toContain('assistant reply');
    expect(messagesPollCount).toBe(0);
    const prompt = requests.find((r) => r.url === '/api/prompt');
    expect(prompt?.body).toEqual({
      text: 'fire and forget',
      provider: 'codex',
      sessionId: 'sess-1',
    });
  });

  it('supports -d as shorthand for --detach', async () => {
    const result = await runCli([
      'send',
      '--url',
      serverUrl,
      '--session',
      'sess-1',
      '-d',
      'short detach',
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('session: sess-1');
    expect(messagesPollCount).toBe(0);
    const prompt = requests.find((r) => r.url === '/api/prompt');
    expect(prompt?.body).toEqual({
      text: 'short detach',
      provider: 'codex',
      sessionId: 'sess-1',
    });
  });

  it('shows API errors without hiding the server message', async () => {
    const result = await runCli(['status', '--url', serverUrl]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('status requires --session ID');
  });
});
