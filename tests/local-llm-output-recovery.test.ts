import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLMClient } from '../src/local-llm/llm-client.js';
import { LocalLlmRunner } from '../src/local-llm/runner.js';
import type { LLMChatResponse } from '../src/local-llm/types.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('output limit preservation', () => {
  it.each(['openai', 'ollama'])(
    'preserves length alongside a parsed tool call: %s',
    async (provider) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify(
            provider === 'openai'
              ? {
                  choices: [
                    {
                      finish_reason: 'length',
                      message: {
                        content: '',
                        tool_calls: [
                          {
                            id: 't',
                            function: { name: 'write', arguments: '{"path":"/tmp/file"}' },
                          },
                        ],
                      },
                    },
                  ],
                }
              : {
                  done_reason: 'length',
                  message: {
                    content: '',
                    tool_calls: [{ function: { name: 'write', arguments: { path: '/tmp/file' } } }],
                  },
                }
          ),
          { status: 200 }
        )
      );
      const c = new LLMClient(
        provider === 'openai' ? 'http://localhost:8001' : 'http://localhost:11434',
        'test'
      );
      const r = await c.chat([{ role: 'user', content: 'test' }]);
      expect(r.finishReason).toBe('length');
      expect(r.toolCalls?.[0].arguments).toEqual({ path: '/tmp/file' });
    }
  );
});

describe('agent output recovery', () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'xangi-output-limit-'));
    vi.stubEnv('LOCAL_LLM_MODE', 'agent');
    vi.stubEnv('LOCAL_LLM_TOOL_SEARCH_ENABLED', 'false');
    vi.stubEnv('LOCAL_LLM_SKILLS', 'false');
    vi.stubEnv('LOCAL_LLM_XANGI_COMMANDS', 'false');
  });
  afterEach(() => rmSync(workdir, { recursive: true, force: true }));
  for (const streaming of [false, true]) {
    for (const reason of ['length', 'missing'] as const) {
      it(`discards ${reason} calls and recovers with a small real write (stream=${streaming})`, async () => {
        const path = join(workdir, 'result.txt');
        const forbidden = join(workdir, 'must-not-exist.txt');
        const partial: LLMChatResponse = {
          content: 'discard this',
          finishReason: reason === 'length' ? 'length' : 'tool_calls',
          toolCalls: [
            {
              id: 'bad',
              name: 'write',
              arguments:
                reason === 'length' ? { path: forbidden, content: 'partial' } : { path: forbidden },
            },
          ],
          usage: { outputTokens: 8192 },
        };
        const chat = vi
          .spyOn(LLMClient.prototype, 'chat')
          .mockResolvedValueOnce(partial)
          .mockImplementationOnce(async (messages) => {
            expect(messages.some((m) => m.toolCalls?.some((c) => c.id === 'bad'))).toBe(false);
            expect(messages.at(-1)?.content).toContain('small section');
            return {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'good', name: 'write', arguments: { path, content: 'complete' } }],
            };
          })
          .mockResolvedValue({ content: 'done', finishReason: 'stop' });
        const runner = new LocalLlmRunner({ workdir, model: 'test' });
        const options = { sessionId: 'recovery', channelId: 'recovery' };
        const result = streaming
          ? await runner.runStream('write', {}, options)
          : await runner.run('write', options);
        expect(result.result).toBe('done');
        expect(existsSync(forbidden)).toBe(false);
        expect(readFileSync(path, 'utf8')).toBe('complete');
        expect(chat).toHaveBeenCalledTimes(3);
      });
    }
    it(`stops after two retries without writing (stream=${streaming})`, async () => {
      const path = join(workdir, 'forbidden');
      const chat = vi.spyOn(LLMClient.prototype, 'chat').mockResolvedValue({
        content: 'unfinished',
        finishReason: 'length',
        toolCalls: [{ id: 'bad', name: 'write', arguments: { path, content: 'partial' } }],
      });
      const runner = new LocalLlmRunner({ workdir, model: 'test' });
      const options = { sessionId: 'limit', channelId: 'limit' };
      const result = await (streaming
        ? runner.runStream('write', {}, options)
        : runner.run('write', options));
      expect(result.failed).toBe(true);
      expect(result.result).toContain('2回の再生成');
      expect(chat).toHaveBeenCalledTimes(3);
      expect(existsSync(path)).toBe(false);
    });
  }
});
