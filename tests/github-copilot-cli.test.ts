import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubCopilotRunner } from '../src/github-copilot-cli.js';

vi.mock('child_process', () => {
  const EventEmitter = require('events');
  class MockProcess extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed = false;
    kill() {
      this.killed = true;
      this.emit('close', 0);
    }
  }
  let mockProcess: MockProcess;
  return {
    spawn: vi.fn(() => {
      mockProcess = new MockProcess();
      return mockProcess;
    }),
    getMockProcess: () => mockProcess,
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

describe('GitHubCopilotRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  async function start(
    runner: GitHubCopilotRunner,
    callbacks: Parameters<GitHubCopilotRunner['runStream']>[1] = {},
    options: Parameters<GitHubCopilotRunner['runStream']>[2] = {}
  ) {
    const childProcess = await import('child_process');
    const promise = runner.runStream('hello', callbacks, options);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const spawnMock = childProcess.spawn as ReturnType<typeof vi.fn>;
    const process = (childProcess.getMockProcess as () => any)();
    return { promise, process, args: spawnMock.mock.calls[0][1] as string[] };
  }

  function emitJson(process: any, value: unknown) {
    process.stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`));
  }

  it('uses Copilot yolo mode when SKIP_PERMISSIONS is enabled', async () => {
    const { promise, process, args } = await start(
      new GitHubCopilotRunner({ skipPermissions: true })
    );
    expect(args).toContain('--yolo');
    expect(args).not.toContain('--available-tools=view,glob,grep');
    expect(args).not.toContain('--allow-tool=read');
    expect(args).not.toContain('--disallow-temp-dir');
    expect(args).not.toContain('--disable-builtin-mcps');
    emitJson(process, { type: 'result', sessionId: 'session-1', exitCode: 0 });
    process.emit('close', 0);
    await expect(promise).resolves.toEqual({ result: '', sessionId: 'session-1' });
  });

  it('uses fail-closed read-only tools when SKIP_PERMISSIONS is disabled', async () => {
    const { promise, process, args } = await start(
      new GitHubCopilotRunner({ skipPermissions: false })
    );
    expect(args).toContain('--available-tools=view,glob,grep');
    expect(args).toContain('--allow-tool=read');
    expect(args).not.toContain('--yolo');
    expect(args).toContain('--disallow-temp-dir');
    emitJson(process, { type: 'result', sessionId: 'session-1', exitCode: 0 });
    process.emit('close', 0);
    await expect(promise).resolves.toEqual({ result: '', sessionId: 'session-1' });
  });

  it('enables only file editing in workspace-write mode', async () => {
    const { promise, process, args } = await start(
      new GitHubCopilotRunner({
        skipPermissions: false,
        copilotPermissionMode: 'workspace-write',
      })
    );
    expect(args).toContain('--available-tools=view,glob,grep,edit,create');
    expect(args).toContain('--allow-tool=read,write');
    expect(args.join(' ')).not.toContain('bash');
    emitJson(process, { type: 'result', sessionId: 'session-2', exitCode: 0 });
    process.emit('close', 0);
    await promise;
  });

  it('honors a per-request permission override', async () => {
    const { promise, process, args } = await start(
      new GitHubCopilotRunner({ skipPermissions: false }),
      {},
      { skipPermissions: true }
    );
    expect(args).toContain('--yolo');
    expect(args).not.toContain('--available-tools=view,glob,grep');
    emitJson(process, { type: 'result', sessionId: 'session-override', exitCode: 0 });
    process.emit('close', 0);
    await promise;
  });

  it('passes model, effort, workdir, session and optional credit limit', async () => {
    const { promise, process, args } = await start(
      new GitHubCopilotRunner({
        model: 'account-model',
        workdir: '/tmp/project',
        copilotMaxAiCredits: 30,
      }),
      {},
      { sessionId: 'session-old', effort: 'high' }
    );
    expect(args[args.indexOf('--model') + 1]).toBe('account-model');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args[args.indexOf('-C') + 1]).toBe('/tmp/project');
    expect(args[args.indexOf('--session-id') + 1]).toBe('session-old');
    expect(args[args.indexOf('--max-ai-credits') + 1]).toBe('30');
    emitJson(process, { type: 'result', sessionId: 'session-old', exitCode: 0 });
    process.emit('close', 0);
    await promise;
  });

  it('passes only the dedicated Copilot token to the child process', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'copilot-user-token';
    process.env.GH_TOKEN = 'unrelated-installation-token';
    const childProcess = await import('child_process');
    const promise = new GitHubCopilotRunner().runStream('hello', {}, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const spawnMock = childProcess.spawn as ReturnType<typeof vi.fn>;
    const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env.COPILOT_GITHUB_TOKEN).toBe('copilot-user-token');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(spawnMock.mock.calls[0][1]).toContain('--secret-env-vars=COPILOT_GITHUB_TOKEN');
    const child = (childProcess.getMockProcess as () => any)();
    emitJson(child, { type: 'result', sessionId: 'session-token', exitCode: 0 });
    child.emit('close', 0);
    await promise;
  });

  it('streams delta text and avoids duplicating the final message', async () => {
    const onText = vi.fn();
    const { promise, process } = await start(new GitHubCopilotRunner(), { onText });
    emitJson(process, {
      type: 'assistant.message_delta',
      data: { messageId: 'message-1', deltaContent: 'P' },
    });
    emitJson(process, {
      type: 'assistant.message_delta',
      data: { messageId: 'message-1', deltaContent: 'ONG' },
    });
    emitJson(process, {
      type: 'assistant.message',
      data: { messageId: 'message-1', content: 'PONG', toolRequests: [] },
    });
    emitJson(process, { type: 'result', sessionId: 'session-3', exitCode: 0 });
    process.emit('close', 0);
    await expect(promise).resolves.toEqual({ result: 'PONG', sessionId: 'session-3' });
    expect(onText).toHaveBeenNthCalledWith(1, 'P', 'P');
    expect(onText).toHaveBeenNthCalledWith(2, 'ONG', 'PONG');
    expect(onText).toHaveBeenCalledTimes(2);
  });

  it('returns official session context usage events', async () => {
    const { promise, process } = await start(new GitHubCopilotRunner());
    emitJson(process, {
      type: 'session.usage_info',
      data: { currentTokens: 12_345, tokenLimit: 128_000, messagesLength: 4 },
    });
    emitJson(process, { type: 'result', sessionId: 'session-usage', exitCode: 0 });
    process.emit('close', 0);
    await expect(promise).resolves.toEqual({
      result: '',
      sessionId: 'session-usage',
      usage: { contextTokens: 12_345, contextWindow: 128_000 },
    });
  });

  it('reconciles a partial delta stream with the canonical final message', async () => {
    const onText = vi.fn();
    const { promise, process } = await start(new GitHubCopilotRunner(), { onText });
    emitJson(process, {
      type: 'assistant.message_delta',
      data: { messageId: 'message-partial', deltaContent: 'P' },
    });
    emitJson(process, {
      type: 'assistant.message',
      data: { messageId: 'message-partial', content: 'PONG', toolRequests: [] },
    });
    emitJson(process, { type: 'result', sessionId: 'session-partial', exitCode: 0 });
    process.emit('close', 0);
    await expect(promise).resolves.toEqual({ result: 'PONG', sessionId: 'session-partial' });
    expect(onText).toHaveBeenNthCalledWith(2, 'ONG', 'PONG');
  });

  it('reports complete tool requests once', async () => {
    const onToolUse = vi.fn();
    const { promise, process } = await start(new GitHubCopilotRunner(), { onToolUse });
    const event = {
      type: 'assistant.message',
      data: {
        messageId: 'message-tool',
        content: '',
        toolRequests: [{ toolCallId: 'call-1', name: 'view', arguments: { path: 'package.json' } }],
      },
    };
    emitJson(process, event);
    emitJson(process, event);
    emitJson(process, { type: 'result', sessionId: 'session-4', exitCode: 0 });
    process.emit('close', 0);
    await promise;
    expect(onToolUse).toHaveBeenCalledOnce();
    expect(onToolUse).toHaveBeenCalledWith('view', { path: 'package.json' });
  });

  it('signals backend readiness at the first assistant turn', async () => {
    const onBackendReady = vi.fn();
    const { promise, process } = await start(new GitHubCopilotRunner(), { onBackendReady });
    emitJson(process, { type: 'assistant.turn_start', data: { turnId: '0' } });
    emitJson(process, { type: 'assistant.turn_start', data: { turnId: '1' } });
    emitJson(process, { type: 'result', sessionId: 'session-5', exitCode: 0 });
    process.emit('close', 0);
    await promise;
    expect(onBackendReady).toHaveBeenCalledOnce();
  });

  it('rejects a successful process without a result event', async () => {
    const { promise, process } = await start(new GitHubCopilotRunner());
    process.emit('close', 0);
    await expect(promise).rejects.toThrow('stream ended without a result event');
  });

  it('surfaces authentication stderr on a failed process', async () => {
    const onError = vi.fn();
    const { promise, process } = await start(new GitHubCopilotRunner(), { onError });
    process.stderr.emit('data', Buffer.from('Authentication token could not be validated'));
    process.emit('close', 1);
    await expect(promise).rejects.toThrow('Authentication token could not be validated');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects a non-zero Copilot result even when the process exits zero', async () => {
    const onError = vi.fn();
    const { promise, process } = await start(new GitHubCopilotRunner(), { onError });
    emitJson(process, { type: 'result', sessionId: 'session-error', exitCode: 1 });
    process.emit('close', 0);
    await expect(promise).rejects.toThrow('Copilot result exit code 1');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects an error event even when it includes a session and the process exits zero', async () => {
    const onError = vi.fn();
    const { promise, process } = await start(new GitHubCopilotRunner(), { onError });
    emitJson(process, { type: 'error', message: 'Copilot request failed' });
    emitJson(process, { type: 'result', sessionId: 'session-error-event', exitCode: 0 });
    process.emit('close', 0);
    await expect(promise).rejects.toThrow('Copilot request failed');
    expect(onError).toHaveBeenCalledOnce();
  });
});
