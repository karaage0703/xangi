import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLlmRunner } from '../src/local-llm/runner.js';
import { executeTool } from '../src/local-llm/tools.js';
import type { LLMChatOptions, LLMMessage } from '../src/local-llm/types.js';

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'local-cancel-'));
  vi.stubEnv('LOCAL_LLM_MODE', 'agent');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(workspace, { recursive: true, force: true });
});
const cancelled = () => new Error('Request cancelled by user');
function setup(chat: ReturnType<typeof vi.fn>) {
  const runner = new LocalLlmRunner({ workdir: workspace, model: 'test' });
  Object.assign(runner, { llm: { chat, chatStream: vi.fn() } });
  return runner;
}
const calls = {
  content: '',
  finishReason: 'tool_calls',
  toolCalls: [
    { id: 'one', name: 'write', arguments: { path: 'one.txt', content: 'one' } },
    { id: 'two', name: 'write', arguments: { path: 'two.txt', content: 'two' } },
  ],
};

describe('local LLM cancellation', () => {
  it('rejects an already cancelled tool before any file mutation', async () => {
    const signal = AbortSignal.abort(cancelled());
    await expect(
      executeTool('write', { path: 'blocked', content: 'x' }, { workspace, signal })
    ).rejects.toThrow('Request cancelled by user');
    expect(existsSync(join(workspace, 'blocked'))).toBe(false);
  });

  it('interrupts an actual running command', async () => {
    const controller = new AbortController();
    const pending = executeTool(
      'exec',
      { command: `exec "${process.execPath}" -e 'setInterval(() => {}, 1000)'` },
      { workspace, signal: controller.signal }
    );
    const assertion = expect(pending).rejects.toThrow('Request cancelled by user');
    const timer = setTimeout(() => controller.abort(cancelled()), 100);
    try {
      await assertion;
    } finally {
      clearTimeout(timer);
    }
  }, 3000);

  it('stops a batch before the next tool and permits a valid resumed turn', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(calls)
      .mockImplementation(async (messages: LLMMessage[]) => {
        const replies = messages.filter((m) => m.role === 'tool');
        expect(replies.map((m) => m.toolCallId)).toEqual(['one', 'two']);
        return { content: '再開できました', finishReason: 'stop', toolCalls: [] };
      });
    const runner = setup(chat);
    const onComplete = vi.fn();
    const options = { channelId: 'batch', sessionId: 'batch' };
    let count = 0;
    await expect(
      runner.runStream(
        'write twice',
        {
          onComplete,
          onToolUse: () => {
            if (++count === 2) runner.cancel('batch');
          },
        },
        options
      )
    ).rejects.toThrow('Request cancelled by user');
    expect(existsSync(join(workspace, 'one.txt'))).toBe(true);
    expect(existsSync(join(workspace, 'two.txt'))).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    expect((await runner.run('continue', options)).result).toBe('再開できました');
  });

  it.each(['run', 'runStream'] as const)(
    'cancels %s during inference without retrying a session-like error',
    async (method) => {
      let runner: LocalLlmRunner;
      const chat = vi.fn(async () => {
        runner.cancel('inference');
        throw new Error('400 Bad Request');
      });
      runner = setup(chat);
      const options = { channelId: 'inference', sessionId: 'inference' };
      chat.mockResolvedValueOnce({
        content: 'ready',
        finishReason: 'stop',
        toolCalls: [],
      } as never);
      await runner.run('warm up', options);
      chat.mockClear();
      const pending =
        method === 'run' ? runner.run('hello', options) : runner.runStream('hello', {}, options);
      await expect(pending).rejects.toThrow('Request cancelled by user');
      expect(chat).toHaveBeenCalledTimes(1);
    }
  );

  it('does not cancel another channel when the requested channel is idle', async () => {
    let runner: LocalLlmRunner;
    const chat = vi.fn(async (_messages: LLMMessage[], options: LLMChatOptions) => {
      expect(runner.cancel('idle')).toBe(false);
      expect(options.signal?.aborted).toBe(false);
      return { content: 'done', finishReason: 'stop', toolCalls: [] };
    });
    runner = setup(chat);
    expect((await runner.run('hello', { channelId: 'active' })).result).toBe('done');
  });

  it('interrupts web_fetch through its request signal', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {
              once: true,
            });
            started();
          })
      )
    );
    const pending = executeTool(
      'web_fetch',
      { url: 'https://example.com' },
      { workspace, signal: controller.signal }
    );
    const assertion = expect(pending).rejects.toThrow('Request cancelled by user');
    await ready;
    controller.abort(cancelled());
    await assertion;
  });

  it.each(['run', 'runStream'] as const)(
    'preserves cancellation during %s session recovery',
    async (method) => {
      let runner: LocalLlmRunner;
      const chat = vi
        .fn()
        .mockResolvedValueOnce({ content: 'ready', finishReason: 'stop', toolCalls: [] })
        .mockRejectedValueOnce(new Error('400 Bad Request'))
        .mockImplementationOnce(async () => {
          runner.cancel('retry');
          throw new Error('400 Bad Request');
        });
      runner = setup(chat);
      const options = { channelId: 'retry', sessionId: 'retry' };
      await runner.run('warm up', options);
      chat.mockClear();
      const pending =
        method === 'run' ? runner.run('hello', options) : runner.runStream('hello', {}, options);
      await expect(pending).rejects.toThrow('Request cancelled by user');
      expect(chat).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps timeout distinct from a user cancellation', async () => {
    const chat = vi.fn(async () => {
      const controllers = (
        runner as unknown as { activeAbortControllers: Map<string, AbortController> }
      ).activeAbortControllers;
      controllers.get('timeout')!.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const runner = setup(chat);
    const result = await runner.run('hello', { channelId: 'timeout' });
    expect(result.failed).toBe(true);
    expect(result.result).toContain('タイムアウト');
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
