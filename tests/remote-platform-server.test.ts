import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../src/agent-runner.js';
import {
  buildRemotePlatformPrompt,
  handleRemotePlatformRequest,
  parseRemotePlatformTurn,
} from '../src/remote-platform-server.js';
import { clearSessions, initSessions } from '../src/sessions.js';

class FakeRunner implements AgentRunner {
  prompts: string[] = [];
  options: RunOptions[] = [];
  release?: () => void;

  async run(): Promise<RunResult> {
    return { result: 'ok', sessionId: 'provider-session' };
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    this.prompts.push(prompt);
    this.options.push(options ?? {});
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    callbacks.onText?.('返答', '返答');
    const result = { result: '返答', sessionId: 'provider-session' };
    callbacks.onComplete?.(result);
    return result;
  }
}

function body(contextKey = 'discord:channel-1') {
  return {
    platform: 'discord',
    contextKey,
    settingsChannelId: 'channel-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    userId: 'user-1',
    userName: 'karaage',
    channelName: 'test',
    text: 'READMEを読んで',
  };
}

describe('remote platform server', () => {
  let dataDir: string;
  let server: Server;
  let baseUrl: string;
  let runner: FakeRunner;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'xangi-remote-platform-'));
    process.env.DATA_DIR = dataDir;
    process.env.XANGI_REMOTE_PLATFORM_ENABLED = 'true';
    process.env.XANGI_REMOTE_PLATFORM_TOKEN = 'test-secret';
    initSessions(dataDir);
    runner = new FakeRunner();
    server = createServer((req, res) => {
      void handleRemotePlatformRequest(req, res, { agentRunner: runner });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    clearSessions();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.XANGI_REMOTE_PLATFORM_ENABLED;
    delete process.env.XANGI_REMOTE_PLATFORM_TOKEN;
  });

  it('validates platform payloads and builds platform metadata', () => {
    expect(() => parseRemotePlatformTurn({ ...body(), platform: 'web' })).toThrow(
      'platform must be discord or slack'
    );
    expect(buildRemotePlatformPrompt(parseRemotePlatformTurn(body()))).toContain(
      '[プラットフォーム: Discord]'
    );
  });

  it('requires the adapter bearer token', async () => {
    const response = await fetch(`${baseUrl}/api/remote-platform/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(401);
  });

  it('streams a normal platform session and rejects a concurrent turn', async () => {
    const request = (payload = body()) =>
      fetch(`${baseUrl}/api/remote-platform/turn`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    const first = request();
    for (let index = 0; index < 50 && !runner.release; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runner.release).toBeTypeOf('function');
    const concurrent = await request();
    expect(concurrent.status).toBe(409);
    runner.release?.();
    const response = await first;
    const stream = await response.text();
    expect(stream).toContain('event: started');
    expect(stream).toContain('event: text');
    expect(stream).toContain('event: done');
    expect(runner.options[0]).toMatchObject({
      platform: 'discord',
      channelId: 'discord:channel-1',
      settingsChannelId: 'channel-1',
    });
  });
});
