import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { spawn } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const XANGI_CMD = join(__dirname, '..', 'bin', 'xangi-cmd');

/**
 * xangi-cmd CLI のリグレッションテスト。
 *
 * 過去に `curl -sf` で 4xx/5xx の body を捨てていたため、サーバー側の
 * 意味のあるエラーメッセージ（例: 「channel が未指定」）が「接続できません」
 * と誤訳されていた。それが退行しないことを保証する。
 */

interface MockResponse {
  status: number;
  body: string;
}

interface CapturedRequest {
  command?: string;
  flags?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

let mockServer: Server | null = null;
let mockUrl = '';
let mockResponse: MockResponse = { status: 200, body: '{"ok":true,"result":"default"}' };
let lastRequest: CapturedRequest = {};

function setMockResponse(res: MockResponse): void {
  mockResponse = res;
}

function runCli(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    // env に明示的に空文字を渡すと「未設定」扱いにしたいので、空文字キーは削る
    const baseEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    delete baseEnv.XANGI_CHANNEL_ID;
    delete baseEnv.XANGI_DEFAULT_CHANNEL;
    const finalEnv: Record<string, string> = {
      ...baseEnv,
      XANGI_TOOL_SERVER: mockUrl,
    };
    for (const [k, v] of Object.entries(env)) {
      if (v === '') {
        delete finalEnv[k];
      } else {
        finalEnv[k] = v;
      }
    }
    const proc = spawn(XANGI_CMD, args, { env: finalEnv });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

// mockServer はファイル全体で共有（複数 describe 間で再利用）
beforeAll(() => {
  return new Promise<void>((resolve) => {
    mockServer = createServer((req, res) => {
      if (req.url === '/api/execute' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            lastRequest = JSON.parse(body) as CapturedRequest;
          } catch {
            lastRequest = {};
          }
          res.statusCode = mockResponse.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(mockResponse.body);
        });
      } else {
        res.statusCode = 404;
        res.end('{"error":"not found"}');
      }
    });
    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      mockUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise<void>((resolve) => {
    mockServer?.close(() => resolve());
  });
});

describe('xangi-cmd CLI error handling', () => {
  it('shows server error message when server returns HTTP 400 with .error', async () => {
    setMockResponse({
      status: 400,
      body: JSON.stringify({
        ok: false,
        error: 'discord_history: channel が未指定です。',
      }),
    });

    const { stderr, code } = await runCli(['discord_history']);

    // 「接続できません」と誤訳されないこと（退行検出）
    expect(stderr).not.toContain('接続できません');
    // サーバー側のエラーメッセージが表示されること
    expect(stderr).toContain('channel が未指定');
    expect(code).not.toBe(0);
  });

  it('shows server error message when server returns HTTP 500 with .error', async () => {
    setMockResponse({
      status: 500,
      body: JSON.stringify({
        ok: false,
        error: 'Internal server error: db connection refused',
      }),
    });

    const { stderr, code } = await runCli(['discord_history']);

    expect(stderr).not.toContain('接続できません');
    expect(stderr).toContain('db connection refused');
    expect(code).not.toBe(0);
  });

  it('outputs result on HTTP 200 success', async () => {
    setMockResponse({
      status: 200,
      body: JSON.stringify({ ok: true, result: 'message history here' }),
    });

    const { stdout, code } = await runCli(['discord_history']);

    expect(stdout).toContain('message history here');
    expect(code).toBe(0);
  });

  it('reports connection error only when curl actually fails', async () => {
    // 存在しないURLを指定 → curl が exit != 0
    const { stderr, code } = await runCli(['discord_history'], {
      XANGI_TOOL_SERVER: 'http://127.0.0.1:1', // 接続不能ポート
    });

    expect(stderr).toContain('接続できません');
    expect(code).not.toBe(0);
  });
});

/**
 * PR #193 のリグレッションテスト。
 *
 * xangi-cmd CLI 単体実行時、`XANGI_CHANNEL_ID` が未設定だと
 * 「現在のチャンネル」が補完されず、サーバー側で channel 未指定エラーに
 * なっていた。`XANGI_DEFAULT_CHANNEL` をフォールバックとして拾うよう
 * 修正された。`XANGI_CHANNEL_ID` 優先のフォールバック順が退行しないこと
 * を保証する。
 */
describe('xangi-cmd CLI channelId completion', () => {
  beforeAll(() => {
    setMockResponse({
      status: 200,
      body: JSON.stringify({ ok: true, result: 'ok' }),
    });
  });

  it('uses XANGI_CHANNEL_ID when set', async () => {
    await runCli(['discord_history'], {
      XANGI_CHANNEL_ID: '111',
      XANGI_DEFAULT_CHANNEL: '',
    });
    expect(lastRequest.context).toEqual({ channelId: '111' });
  });

  it('falls back to XANGI_DEFAULT_CHANNEL when XANGI_CHANNEL_ID is unset', async () => {
    await runCli(['discord_history'], {
      XANGI_CHANNEL_ID: '',
      XANGI_DEFAULT_CHANNEL: '222',
    });
    expect(lastRequest.context).toEqual({ channelId: '222' });
  });

  it('prefers XANGI_CHANNEL_ID over XANGI_DEFAULT_CHANNEL when both set', async () => {
    await runCli(['discord_history'], {
      XANGI_CHANNEL_ID: '111',
      XANGI_DEFAULT_CHANNEL: '222',
    });
    expect(lastRequest.context).toEqual({ channelId: '111' });
  });

  it('sends empty context when neither env var is set', async () => {
    await runCli(['discord_history'], {
      XANGI_CHANNEL_ID: '',
      XANGI_DEFAULT_CHANNEL: '',
    });
    expect(lastRequest.context).toEqual({});
  });
});
