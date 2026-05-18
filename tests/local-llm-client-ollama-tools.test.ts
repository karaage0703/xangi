import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LLMClient, __testables } from '../src/local-llm/llm-client.js';
import type { LLMMessage, LLMTool } from '../src/local-llm/types.js';

const { applyOpenAITools, applyOllamaTools, toOllamaMessages } = __testables;

/**
 * Ollama ネイティブ API (/api/chat) 経路の chat / chatStream で tools / tool_choice が
 * 正しく payload に乗ることを検証する。
 *
 * tool_choice='none' は Ollama ネイティブ API が公式サポートしていないため、
 * tools 自体を渡さないことでエミュレートする。
 */
describe('LLMClient Ollama-native chatStream / chat payload', () => {
  let capturedUrl: string | null = null;
  let capturedBody: Record<string, unknown> | null = null;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedUrl = null;
    capturedBody = null;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      if (init?.body && typeof init.body === 'string') {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      // Ollama ストリーミングは NDJSON (1 行 1 chunk JSON)
      const encoder = new TextEncoder();
      const ndjson =
        JSON.stringify({ message: { content: 'hello' }, done: false }) +
        '\n' +
        JSON.stringify({ message: { content: '' }, done: true }) +
        '\n';
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(ndjson));
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
      );
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // Ollama 判定: URL に "11434" を含む + thinking=false で Ollama ネイティブ経路へ
  const buildClient = () =>
    new LLMClient('http://localhost:11434', 'qwen3.6:35b-a3b', '', false, 1024, 32768, 0);

  const sampleTools: LLMTool[] = [
    {
      name: 'tool_search',
      description: '検索',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  ];

  const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }];

  async function drain(gen: AsyncGenerator<string>) {
    for await (const _ of gen) {
      void _;
    }
  }

  describe('chatStream (Ollama native /api/chat)', () => {
    it('Ollama URL + thinking=false → /api/chat 経路を通る', async () => {
      const client = buildClient();
      await drain(client.chatStream(messages));
      expect(capturedUrl).toContain('/api/chat');
      expect(capturedUrl).not.toContain('/v1/chat/completions');
    });

    it('tools 指定なし: body に tools を入れない', async () => {
      const client = buildClient();
      await drain(client.chatStream(messages));
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.stream).toBe(true);
      expect(capturedBody!.think).toBe(false);
      expect(capturedBody!.tools).toBeUndefined();
    });

    it('tools 指定あり、toolChoice 未指定: tools を載せて tool calling を有効化', async () => {
      const client = buildClient();
      await drain(client.chatStream(messages, { tools: sampleTools }));
      expect(capturedBody!.tools).toBeDefined();
      expect(Array.isArray(capturedBody!.tools)).toBe(true);
      const tools = capturedBody!.tools as Array<{ function: { name: string } }>;
      expect(tools[0].function.name).toBe('tool_search');
    });

    it("toolChoice='none': tools を渡さないことで text 応答を強制エミュレート", async () => {
      const client = buildClient();
      await drain(client.chatStream(messages, { tools: sampleTools, toolChoice: 'none' }));
      // Ollama ネイティブ API は tool_choice 未サポート → tools 自体を外す
      expect(capturedBody!.tools).toBeUndefined();
      // 万が一 tool_choice を素通しさせていないことも確認 (実害は無いが意図しない混入を防ぐ)
      expect(capturedBody!.tool_choice).toBeUndefined();
    });

    it("toolChoice='auto': tools を載せる (Ollama では tool_choice は無視されるベストエフォート)", async () => {
      const client = buildClient();
      await drain(client.chatStream(messages, { tools: sampleTools, toolChoice: 'auto' }));
      expect(capturedBody!.tools).toBeDefined();
      expect(capturedBody!.tool_choice).toBeUndefined();
    });

    it('assistant の tool_calls 履歴を Ollama 形式 (function.name / function.arguments) に変換', async () => {
      const client = buildClient();
      const conv: LLMMessage[] = [
        { role: 'user', content: 'search arxiv please' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'tool_search', arguments: { query: 'arxiv' } },
          ],
        },
        { role: 'tool', content: 'Available skills: arxiv', toolCallId: 'call-1' },
      ];
      await drain(client.chatStream(conv));
      const sent = capturedBody!.messages as Array<Record<string, unknown>>;
      expect(sent).toHaveLength(3);
      // assistant メッセージは tool_calls を持つ
      const assistantMsg = sent[1];
      expect(assistantMsg.tool_calls).toBeDefined();
      const tcs = assistantMsg.tool_calls as Array<{
        type: string;
        function: { name: string; arguments: Record<string, unknown> };
      }>;
      expect(tcs[0].type).toBe('function');
      expect(tcs[0].function.name).toBe('tool_search');
      expect(tcs[0].function.arguments).toEqual({ query: 'arxiv' });
      // tool メッセージは tool_name で関連付け (Ollama は OpenAI の tool_call_id ではなく tool_name)
      const toolMsg = sent[2];
      expect(toolMsg.tool_name).toBe('tool_search');
    });
  });

  describe('chat (non-stream Ollama native /api/chat)', () => {
    beforeEach(() => {
      // non-stream の Ollama レスポンスに差し替え
      fetchSpy.mockImplementation(async (input, init) => {
        capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
        if (init?.body && typeof init.body === 'string') {
          capturedBody = JSON.parse(init.body) as Record<string, unknown>;
        }
        return new Response(
          JSON.stringify({
            message: { role: 'assistant', content: 'ok' },
            done_reason: 'stop',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });
    });

    it('Ollama URL + thinking=false → /api/chat 経路を通る', async () => {
      const client = buildClient();
      await client.chat(messages);
      expect(capturedUrl).toContain('/api/chat');
    });

    it('tools 指定あり: 既存挙動 (Ollama 形式の tools が body に載る) を維持', async () => {
      const client = buildClient();
      await client.chat(messages, { tools: sampleTools });
      expect(capturedBody!.tools).toBeDefined();
      const tools = capturedBody!.tools as Array<{ function: { name: string } }>;
      expect(tools[0].function.name).toBe('tool_search');
    });

    it("toolChoice='none': chat (非 streaming) でも tools を外して text 応答を強制", async () => {
      const client = buildClient();
      await client.chat(messages, { tools: sampleTools, toolChoice: 'none' });
      expect(capturedBody!.tools).toBeUndefined();
      expect(capturedBody!.tool_choice).toBeUndefined();
    });
  });
});

/**
 * 共通ヘルパ単体テスト。chat / chatStream × OpenAI / Ollama の 4 経路から
 * 呼ばれる中核ロジックなので、ここで挙動を一箇所に集約検証する。
 */
describe('LLMClient internal helpers', () => {
  const sampleTools: LLMTool[] = [
    {
      name: 'tool_search',
      description: '検索',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  ];

  describe('applyOpenAITools', () => {
    it('tools 未指定 → body 触らない', () => {
      const body: Record<string, unknown> = { model: 'x' };
      applyOpenAITools(body);
      expect(body).toEqual({ model: 'x' });
    });

    it('tools 空配列 → body 触らない', () => {
      const body: Record<string, unknown> = { model: 'x' };
      applyOpenAITools(body, { tools: [] });
      expect(body.tools).toBeUndefined();
    });

    it('tools 指定 → body.tools に function 形式で展開', () => {
      const body: Record<string, unknown> = { model: 'x' };
      applyOpenAITools(body, { tools: sampleTools });
      const tools = body.tools as Array<{ type: string; function: { name: string } }>;
      expect(tools[0].type).toBe('function');
      expect(tools[0].function.name).toBe('tool_search');
    });

    it("toolChoice 'none' / 'auto' / 'required' / function 指定すべて body.tool_choice に反映", () => {
      for (const choice of [
        'none',
        'auto',
        'required',
        { type: 'function' as const, function: { name: 'tool_search' } },
      ] as const) {
        const body: Record<string, unknown> = { model: 'x' };
        applyOpenAITools(body, { tools: sampleTools, toolChoice: choice });
        expect(body.tool_choice).toEqual(choice);
      }
    });
  });

  describe('applyOllamaTools', () => {
    it('tools 未指定 → body 触らない', () => {
      const body: Record<string, unknown> = { model: 'x' };
      applyOllamaTools(body);
      expect(body).toEqual({ model: 'x' });
    });

    it('tools 指定 → body.tools に function 形式で展開', () => {
      const body: Record<string, unknown> = { model: 'x' };
      applyOllamaTools(body, { tools: sampleTools });
      const tools = body.tools as Array<{ type: string; function: { name: string } }>;
      expect(tools[0].type).toBe('function');
      expect(tools[0].function.name).toBe('tool_search');
    });

    it("toolChoice='none' → tools を載せない (Ollama では tool_choice 未サポートのためエミュレート)", () => {
      const body: Record<string, unknown> = { model: 'x' };
      applyOllamaTools(body, { tools: sampleTools, toolChoice: 'none' });
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });

    it("toolChoice='auto' / 'required' → tools は載るが tool_choice は素通ししない", () => {
      for (const choice of ['auto', 'required'] as const) {
        const body: Record<string, unknown> = { model: 'x' };
        applyOllamaTools(body, { tools: sampleTools, toolChoice: choice });
        expect(body.tools).toBeDefined();
        expect(body.tool_choice).toBeUndefined();
      }
    });
  });

  describe('toOllamaMessages', () => {
    it('plain text メッセージは role + content のみ', () => {
      const result = toOllamaMessages([{ role: 'user', content: 'hi' }]);
      expect(result).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('images は base64 配列で渡す (data URI prefix 無し)', () => {
      const result = toOllamaMessages([
        {
          role: 'user',
          content: '',
          images: [{ base64: 'abc==', mimeType: 'image/png' }],
        },
      ]);
      expect(result[0].images).toEqual(['abc==']);
    });

    it('assistant の tool_calls は function 形式に変換', () => {
      const result = toOllamaMessages([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'tool_search', arguments: { query: 'arxiv' } }],
        },
      ]);
      const tcs = result[0].tool_calls as Array<{
        type: string;
        function: { name: string; arguments: Record<string, unknown> };
      }>;
      expect(tcs[0].type).toBe('function');
      expect(tcs[0].function.name).toBe('tool_search');
      expect(tcs[0].function.arguments).toEqual({ query: 'arxiv' });
    });

    it('tool ロールは toolCallId → tool_name に関連付け (同一会話内の assistant 履歴から逆引き)', () => {
      const result = toOllamaMessages([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'tool_search', arguments: {} }],
        },
        { role: 'tool', content: 'result', toolCallId: 'c1' },
      ]);
      expect(result[1].tool_name).toBe('tool_search');
    });

    it('tool ロールで対応する assistant 履歴が無ければ tool_name は付かない', () => {
      const result = toOllamaMessages([
        { role: 'tool', content: 'orphan', toolCallId: 'c-missing' },
      ]);
      expect(result[0].tool_name).toBeUndefined();
    });
  });
});
