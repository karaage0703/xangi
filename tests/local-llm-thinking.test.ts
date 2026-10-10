import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMClient } from '../src/local-llm/llm-client.js';
import type { LocalLlmReasoningEffort } from '../src/local-llm/reasoning-effort.js';

afterEach(() => vi.restoreAllMocks());

describe.each([false, true])('Qwen thinking (stream=%s)', (stream) => {
  async function request(
    model: string,
    thinking: boolean,
    effort?: LocalLlmReasoningEffort,
    defaultEffort?: LocalLlmReasoningEffort,
    provider?: 'openrouter',
    baseUrl = 'http://localhost:8001'
  ) {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      if (stream) {
        return new Response('data: {"choices":[{"delta":{"content":"2"}}]}\n\ndata: [DONE]\n\n');
      }
      return Response.json({ choices: [{ message: { content: '2' }, finish_reason: 'stop' }] });
    });
    const client = new LLMClient(
      baseUrl,
      model,
      'test-key',
      thinking,
      128,
      undefined,
      0,
      defaultEffort,
      provider
    );
    const messages = [{ role: 'user' as const, content: '1+1?' }];
    if (stream) {
      for await (const _ of client.chatStream(messages, { reasoningEffort: effort })) void _;
    } else {
      await client.chat(messages, { reasoningEffort: effort });
    }
    return body;
  }

  it.each(['qwen3.8-flash-next', 'dspark/qwen3.8-27b', 'Qwen/Qwen3-32B'])(
    'sends explicit OFF and ON for hybrid alias %s',
    async (model) => {
      expect((await request(model, false)).chat_template_kwargs).toEqual({
        enable_thinking: false,
      });
      expect((await request(model, true)).chat_template_kwargs).toEqual({ enable_thinking: true });
    }
  );
  it('per-call none disables thinking even with default high', async () => {
    expect(
      (await request('qwen3.8-flash-next', true, 'none', 'high')).chat_template_kwargs
    ).toEqual({ enable_thinking: false });
  });
  it('explicit effort enables thinking and keeps the requested effort', async () => {
    const body = await request('qwen3.8-flash-next', false, 'low', 'none');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(body.reasoning_effort).toBe('low');
  });
  it('environment effort takes precedence over the thinking flag', async () => {
    expect(
      (await request('qwen3.8-flash-next', false, undefined, 'high')).chat_template_kwargs
    ).toEqual({ enable_thinking: true });
  });
  it.each(['gemma-4-26b-a4b', 'Qwen/Qwen3-235B-A22B-Thinking-2507'])(
    'does not send a hybrid extension for %s',
    async (model) => {
      expect((await request(model, false)).chat_template_kwargs).toBeUndefined();
    }
  );
  it('does not send the local extension to OpenRouter', async () => {
    const body = await request('qwen/qwen3-32b', false, 'low', undefined, 'openrouter');
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: 'low' });
  });
  it('does not change the Ollama OpenAI route', async () => {
    expect(
      (await request('qwen3:32b', true, undefined, undefined, undefined, 'http://localhost:11434'))
        .chat_template_kwargs
    ).toBeUndefined();
  });
});
