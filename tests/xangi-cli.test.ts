import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { spawn } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
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
  stdinText?: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(XANGI, args, {
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
      json(res, 202, { ok: true, sessionId: 'sess-1', provider: 'codex' });
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
            ? [{ id: 1, type: 'result', success: true, text: 'assistant reply' }]
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
  function createFakePm2(): { dir: string; logFile: string } {
    const dir = mkdtempSync(join(tmpdir(), 'xangi-cli-pm2-'));
    const logFile = join(dir, 'pm2.log');
    const pm2Path = join(dir, 'pm2');
    writeFileSync(
      pm2Path,
      `#!/bin/sh
echo "$@" >> "$PM2_LOG"
echo "runtime=$XANGI_SETUP_CONFIG_PATH|$XANGI_SETUP_STATE_DIR" >> "$PM2_LOG"
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
exit 0
`
    );
    chmodSync(pm2Path, 0o755);
    return { dir, logFile };
  }

  it('documents managed install and update commands in help', async () => {
    const result = await runCli(['help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('xangi install');
    expect(result.stdout).toContain('xangi uninstall');
    expect(result.stdout).toContain('xangi update');
    expect(result.stdout).toContain('xangi notion-sync');
    expect(result.stdout).toContain('status|enable|disable|run');
    expect(result.stdout).toContain('--once');
    expect(result.stdout).toContain('--allow-downgrade');
    expect(result.stdout).toContain('--purge');
    expect(result.stdout).toContain('--yes');
    expect(result.stdout).toContain('setup --apply');
    expect(result.stdout).toContain('--workspace-mode');
    expect(result.stdout).not.toContain('--browser');
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
            [join(currentLink, 'src', 'cli', 'xangi.ts'), 'help'],
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
    expect(JSON.parse(readFileSync(join(configHome, 'xangi', 'xangi.json'), 'utf8'))).toMatchObject(
      {
        backend: 'codex',
        workspacePath: workspace,
        webChatAccess: 'tailscale',
        notionSyncEnabled: false,
      }
    );
    expect(readFileSync(join(workspace, 'BOOTSTRAP.md'), 'utf8')).toContain(
      'すべて日本語で一度に一つずつ質問'
    );
  });

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
      PM2_LOG: fakePm2.logFile,
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    const log = readFileSync(fakePm2.logFile, 'utf8');
    expect(log).toContain('describe xangi-prod');
    expect(log).toContain('delete xangi-prod');
    expect(log).toContain('start ecosystem.config.cjs --only xangi-prod');
  });

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
      PM2_LOG: fakePm2.logFile,
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
      PM2_LOG: fakePm2.logFile,
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    expect(readFileSync(fakePm2.logFile, 'utf8')).toContain(
      `runtime=${join(configHome, 'xangi', 'xangi.json')}|${checkoutState}`
    );
  });

  it('starts from PM2 config when the PM2 service is not registered yet', async () => {
    const fakePm2 = createFakePm2();
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    writeFileSync(join(xangiDir, '.env'), 'XANGI_INSTANCE_ID=xangi-dev\n');
    writeFileSync(join(xangiDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');

    const result = await runCli(['service', 'restart', '--dir', xangiDir], {
      PM2_LOG: fakePm2.logFile,
      PM2_DESCRIBE_EXIT: '1',
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

    const result = await runCli(['service', 'autostart', '--dir', xangiDir], {
      PM2_LOG: fakePm2.logFile,
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('If pm2 printed a sudo command');
    const log = readFileSync(fakePm2.logFile, 'utf8');
    expect(log).toContain('save');
    expect(log).toContain('startup');
  });

  it('accepts PM2 startup sudo guidance even when pm2 exits non-zero', async () => {
    const fakePm2 = createFakePm2();
    const xangiDir = mkdtempSync(join(tmpdir(), 'xangi-dir-'));
    writeFileSync(join(xangiDir, '.env'), 'XANGI_PROCESS_NAME=xangi-prod\n');

    const result = await runCli(['service', 'autostart', '--dir', xangiDir], {
      PM2_LOG: fakePm2.logFile,
      PM2_STARTUP_EXIT: '1',
      PM2_STARTUP_OUTPUT:
        'sudo env PATH=$PATH:/node/bin /node/lib/node_modules/pm2/bin/pm2 startup systemd -u karaage --hp /home/karaage',
      PATH: `${fakePm2.dir}:${process.env.PATH || ''}`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('sudo env PATH=');
    expect(result.stdout).toContain('If pm2 printed a sudo command');
    const log = readFileSync(fakePm2.logFile, 'utf8');
    expect(log).toContain('save');
    expect(log).toContain('startup');
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
