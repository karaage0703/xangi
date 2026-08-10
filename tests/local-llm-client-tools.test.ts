import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LLMClient } from '../src/local-llm/llm-client.js';
import type { LLMMessage, LLMTool } from '../src/local-llm/types.js';

/**
 * chatStream で tools / tool_choice が正しく payload に乗ることを検証する。
 *
 * 背景: 旧実装の chatStream は body から tools パラメータが完全に欠落しており、
 * Gemma 4 等の OpenAI 互換モデルで streaming 経路の tool calling 機構が無効化されていた。
 * 結果として LLM が「tool 呼ぶべき」と判断した場面で擬似 tool_call 文字列を text として
 * 吐く format drift が発生。最終応答用には toolChoice='none' 時に tools 自体を
 * 外し、tool_choice を無視する OpenAI 互換サーバでも text 応答を強制する。
 */
describe('LLMClient chatStream payload', () => {
  let capturedBody: Record<string, unknown> | null = null;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedBody = null;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.body && typeof init.body === 'string') {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      // SSE ストリームを 1 chunk + [DONE] で返すスタブ
      const encoder = new TextEncoder();
      const sse = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' + 'data: [DONE]\n\n';
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sse));
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const buildClient = () =>
    new LLMClient('http://localhost:8001', 'gemma-4-26b-a4b', '', false, 1024, undefined, 0);

  const sampleTools: LLMTool[] = [
    {
      name: 'tool_search',
      description: '検索',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ];

  const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }];

  async function drain(gen: AsyncGenerator<string>) {
    for await (const _ of gen) {
      void _;
    }
  }

  it('tools 指定なし: body に tools/tool_choice を入れない', async () => {
    const client = buildClient();
    await drain(client.chatStream(messages));
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.stream).toBe(true);
    expect(capturedBody!.tools).toBeUndefined();
    expect(capturedBody!.tool_choice).toBeUndefined();
  });

  it('tools 指定あり、toolChoice 未指定: tools のみ入る (tool_choice は OpenAI デフォの auto)', async () => {
    const client = buildClient();
    await drain(client.chatStream(messages, { tools: sampleTools }));
    expect(capturedBody!.tools).toBeDefined();
    expect(Array.isArray(capturedBody!.tools)).toBe(true);
    expect((capturedBody!.tools as Array<{ function: { name: string } }>)[0].function.name).toBe(
      'tool_search'
    );
    expect(capturedBody!.tool_choice).toBeUndefined();
  });

  it("toolChoice='none': 最終応答用に tools/tool_choice を payload から外す", async () => {
    const client = buildClient();
    await drain(client.chatStream(messages, { tools: sampleTools, toolChoice: 'none' }));
    expect(capturedBody!.tools).toBeUndefined();
    expect(capturedBody!.tool_choice).toBeUndefined();
  });

  it("toolChoice='auto': 明示 auto も正しく載る", async () => {
    const client = buildClient();
    await drain(client.chatStream(messages, { tools: sampleTools, toolChoice: 'auto' }));
    expect(capturedBody!.tool_choice).toBe('auto');
  });

  it('toolChoice (function 指定): 特定 tool 強制も正しく載る', async () => {
    const client = buildClient();
    await drain(
      client.chatStream(messages, {
        tools: sampleTools,
        toolChoice: { type: 'function', function: { name: 'tool_search' } },
      })
    );
    expect(capturedBody!.tool_choice).toEqual({
      type: 'function',
      function: { name: 'tool_search' },
    });
  });

  it("chat (non-stream) でも toolChoice='none' は tools/tool_choice を外す", async () => {
    // non-stream の OpenAI レスポンスを返すモック
    fetchSpy.mockImplementation(async (_input, init) => {
      if (init?.body && typeof init.body === 'string') {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    const client = buildClient();
    await client.chat(messages, { tools: sampleTools, toolChoice: 'none' });
    expect(capturedBody!.tools).toBeUndefined();
    expect(capturedBody!.tool_choice).toBeUndefined();
  });

  it('OpenAI 互換応答の Step XML tool call を構造化 call へ復元する', async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content:
                    '<tool_call>\n<function=tool_search>\n<parameter=query>\n国歌\n</parameter>\n</function>\n</tool_call>',
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const client = buildClient();
    const result = await client.chat(messages, { tools: sampleTools });
    expect(result.content).toBe('');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({
      name: 'tool_search',
      arguments: { query: '国歌' },
    });
  });

  it('tools に存在しない XML function は実行用に復元しない', async () => {
    const leaked =
      '<tool_call>\n<function=unknown_tool>\n<parameter=query>\n国歌\n</parameter>\n</function>\n</tool_call>';
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: leaked }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const client = buildClient();
    const result = await client.chat(messages, { tools: sampleTools });
    expect(result.content).toBe(leaked);
    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe('stop');
  });
});
