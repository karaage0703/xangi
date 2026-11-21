import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discordApi } from '../src/cli/discord-api.js';
import { buildAttachmentResult } from '../src/file-utils.js';
import { executeTool } from '../src/local-llm/tools.js';
import { DynamicRunnerManager } from '../src/dynamic-runner.js';
import type { AgentRunner, StreamCallbacks } from '../src/agent-runner.js';
import type { Config } from '../src/config.js';
import type { BackendResolver } from '../src/backend-resolver.js';
import { SECRET_AI_WARNING } from '../src/secret-filter.js';

const token = 'secret-filter-integration-DUMMY-9pK7';
const replacement = '[REDACTED_SECRET]';
const blockNotice = '秘密情報を検出したため、送信を停止しました。';
let directory: string;

beforeEach(() => {
  vi.stubEnv('DISCORD_TOKEN', token);
  directory = mkdtempSync(join(tmpdir(), 'secret-filter-integration-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe('Discord send boundary', () => {
  it.each(['discord_send', 'discord_edit', 'discord_thread_rename'])(
    'blocks %s before any API request',
    async (command) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        discordApi(command, {
          channel: 'channel',
          'message-id': 'message',
          message: token,
          content: token,
          name: token,
        })
      ).rejects.toThrow(blockNotice);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('blocks file contents before multipart upload, but allows a normal attachment', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'message' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const file = join(directory, 'output.txt');
    writeFileSync(file, `prefix ${token} suffix`);
    await expect(discordApi('media_send', { channel: 'channel', file })).rejects.toThrow(
      blockNotice
    );
    expect(fetchMock).not.toHaveBeenCalled();
    writeFileSync(file, 'ordinary attachment');
    await discordApi('media_send', { channel: 'channel', file });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]).toBeDefined();
  });

  it('masks secrets returned by history tools, preserving normal messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 'message',
                content: `normal ${token}`,
                author: { id: 'user', username: 'user', discriminator: '0' },
                timestamp: '2026-01-01T00:00:00Z',
                attachments: [],
              },
            ]),
            { status: 200 }
          )
      )
    );
    const output = await discordApi('discord_history', { channel: 'channel' });
    expect(output).not.toContain(token);
    expect(output).toContain(replacement);
    expect(output).toContain('normal');
    expect(output).toContain(SECRET_AI_WARNING);
  });

  it('allows known values through when explicitly disabled, using only a mock API', async () => {
    vi.stubEnv('XANGI_SECRET_FILTER_ENABLED', 'false');
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'message' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      discordApi('discord_send', { channel: 'channel', message: token })
    ).resolves.toContain('送信しました');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(fetchMock.mock.calls)).toContain(token);
    const file = join(directory, 'off.txt');
    writeFileSync(file, token);
    expect(buildAttachmentResult('done', [file]).filePaths).toEqual([file]);
    const read = await executeTool('read', { path: file }, { workspace: directory });
    expect(read.output).toContain(token);
    expect(read.output).not.toContain(SECRET_AI_WARNING);
    const write = await executeTool(
      'write',
      { path: 'off-write.txt', content: token },
      { workspace: directory }
    );
    expect(write.success).toBe(true);
  });
});

it('rejects both MEDIA markers and structured attachments without a recovery retry', () => {
  const file = join(directory, 'output.txt');
  writeFileSync(file, token);
  for (const output of [
    buildAttachmentResult(`MEDIA:${file}`),
    buildAttachmentResult('done', [file]),
  ]) {
    expect(output.filePaths).toEqual([]);
    expect(output.displayText).toBe(blockNotice);
    expect(output.attachmentFailure).toBeUndefined();
  }
  writeFileSync(file, 'ordinary');
  expect(buildAttachmentResult(`MEDIA:${file}`).filePaths).toEqual([file]);
});

it('masks Local LLM read results and rejects secret-bearing write arguments before execution', async () => {
  writeFileSync(join(directory, 'input.txt'), `normal ${token}`);
  const read = await executeTool('read', { path: 'input.txt' }, { workspace: directory });
  expect(read.success).toBe(true);
  expect(read.output).not.toContain(token);
  expect(read.output).toContain(replacement);
  expect(read.output).toContain(SECRET_AI_WARNING);
  const write = await executeTool(
    'write',
    { path: 'output.txt', content: token },
    { workspace: directory }
  );
  expect(write.success).toBe(false);
  expect(write.error).toContain(SECRET_AI_WARNING);
  expect(existsSync(join(directory, 'output.txt'))).toBe(false);
  const unknown = await executeTool(token, {}, { workspace: directory });
  expect(unknown.error).not.toContain(token);
  expect(unknown.error).toContain(replacement);
});

function makeManager() {
  const resolved = { backend: 'local-llm' as const, model: 'test' };
  const config = {
    agent: { backend: resolved.backend, config: { workdir: directory }, platform: 'discord' },
  } as Config;
  const resolver = {
    getDefault: () => resolved,
    resolve: () => resolved,
  } as unknown as BackendResolver;
  return new DynamicRunnerManager(config, resolver);
}

it('masks DynamicRunner prompts and raw userText and blocks a secret-bearing final response', async () => {
  const manager = makeManager();
  const run = vi.fn(async () => ({ result: `answer ${token}`, sessionId: 'test-session' }));
  const getRunner = vi.spyOn(manager as unknown as { getRunner: () => AgentRunner }, 'getRunner');
  getRunner.mockReturnValue({ run, runStream: vi.fn() });
  try {
    const result = await manager.run(`prompt ${token}`, { userText: `input ${token}` });
    expect(JSON.stringify(run.mock.calls)).not.toContain(token);
    expect(JSON.stringify(run.mock.calls)).toContain(replacement);
    expect(run.mock.calls[0]?.[0]).toContain(SECRET_AI_WARNING);
    expect(result).toMatchObject({ result: blockNotice, failed: true });
    expect(run).toHaveBeenCalledOnce();
  } finally {
    manager.shutdown();
  }
});

it('does not mask prompts, responses, streams or tool displays when disabled', async () => {
  vi.stubEnv('XANGI_SECRET_FILTER_ENABLED', 'false');
  const manager = makeManager();
  const run = vi.fn(async (_prompt: string) => ({ result: token, sessionId: 'session' }));
  const runStream = vi.fn(async (_prompt: string, callbacks: StreamCallbacks) => {
    callbacks.onText?.(token, token);
    callbacks.onToolUse?.('read', { value: token });
    return { result: token, sessionId: 'session' };
  });
  vi.spyOn(manager as unknown as { getRunner: () => AgentRunner }, 'getRunner').mockReturnValue({
    run,
    runStream,
  });
  try {
    const result = await manager.run(token);
    expect(result.result).toBe(token);
    expect(run.mock.calls[0][0]).toBe(token);
    const onText = vi.fn(),
      onToolUse = vi.fn();
    expect((await manager.runStream(token, { onText, onToolUse })).result).toBe(token);
    expect(onText).toHaveBeenCalledWith(token, token);
    expect(onToolUse).toHaveBeenCalledWith('read', { value: token });
  } finally {
    manager.shutdown();
  }
});

it('blocks a split streaming leak even if the final response looks harmless', async () => {
  const manager = makeManager();
  const runStream = vi.fn(async (_prompt: string, callbacks: StreamCallbacks) => {
    callbacks.onText?.('safe ' + token.slice(0, 10), 'safe ' + token.slice(0, 10));
    callbacks.onText?.(token.slice(10), 'safe ' + token);
    callbacks.onToolUse?.('read', { value: token });
    return { result: 'done', sessionId: 'test-session' };
  });
  vi.spyOn(manager as unknown as { getRunner: () => AgentRunner }, 'getRunner').mockReturnValue({
    run: vi.fn(),
    runStream,
  });
  const onText = vi.fn(),
    onToolUse = vi.fn(),
    onComplete = vi.fn();
  try {
    const result = await manager.runStream(`prompt ${token}`, { onText, onToolUse, onComplete });
    expect(result).toMatchObject({ result: blockNotice, failed: true });
    expect(onText.mock.calls.map(([text]) => text).join('')).toBe('safe ');
    expect(JSON.stringify(onToolUse.mock.calls)).not.toContain(token);
    expect(onComplete).toHaveBeenCalledWith(result);
  } finally {
    manager.shutdown();
  }
});
