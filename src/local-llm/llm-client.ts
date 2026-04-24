/**
 * OpenAI互換 + Ollama ネイティブAPI 対応 LLMクライアント
 */
import type { LLMMessage, LLMToolCall, LLMChatOptions, LLMChatResponse } from './types.js';

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
}

function toOpenAIMessages(messages: LLMMessage[], isOllama: boolean): OpenAIMessage[] {
  return messages.map((msg) => {
    const m: OpenAIMessage = { role: msg.role, content: msg.content };

    // マルチモーダル: 画像がある場合はcontent配列形式にする（OpenAI互換API向け）
    if (msg.images && msg.images.length > 0 && !isOllama) {
      const parts: OpenAIContentPart[] = [];
      if (msg.content) {
        parts.push({ type: 'text', text: msg.content });
      }
      for (const img of msg.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
        });
      }
      m.content = parts;
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      m.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
      m.content = null;
    }
    if (msg.toolCallId) {
      m.tool_call_id = msg.toolCallId;
    }
    return m;
  });
}

export class LLMClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string = '',
    private readonly thinking: boolean = true,
    private readonly defaultMaxTokens: number = 8192,
    private readonly numCtx?: number
  ) {
    this.timeoutMs = parseInt(process.env.TIMEOUT_MS || '300000', 10);
  }

  async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMChatResponse> {
    if (!this.thinking && this.isOllamaUrl()) {
      return this.chatOllamaNative(messages, options);
    }
    return this.chatOpenAI(messages, options);
  }

  private isOllamaUrl(): boolean {
    return this.baseUrl.includes('11434') || this.baseUrl.includes('ollama');
  }

  private async chatOllamaNative(
    messages: LLMMessage[],
    options?: LLMChatOptions
  ): Promise<LLMChatResponse> {
    // toolCallId → tool name の逆引きマップ（Ollamaはtool_nameで関連付ける）
    const toolCallNameById = new Map<string, string>();

    const ollamaMessages = messages.map((msg) => {
      const m: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };
      // Ollama形式: images フィールドにbase64画像を配列で渡す
      if (msg.images && msg.images.length > 0) {
        m.images = msg.images.map((img) => img.base64);
      }
      // assistant メッセージ: tool_calls を渡す
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        m.tool_calls = msg.toolCalls.map((tc) => {
          toolCallNameById.set(tc.id, tc.name);
          return {
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          };
        });
      }
      // tool メッセージ: tool_name で呼び出し元を関連付ける
      if (msg.role === 'tool' && msg.toolCallId) {
        const toolName = toolCallNameById.get(msg.toolCallId);
        if (toolName) {
          m.tool_name = toolName;
        }
      }
      return m;
    });

    if (options?.systemPrompt) {
      ollamaMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: false,
      think: false,
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    body.options = {
      num_predict: options?.maxTokens ?? this.defaultMaxTokens,
      ...(this.numCtx && { num_ctx: this.numCtx }),
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      message: {
        role: string;
        content: string;
        tool_calls?: Array<{
          function: { name: string; arguments: Record<string, unknown> };
        }>;
      };
      done_reason?: string;
    };

    const toolCalls: LLMToolCall[] = [];
    if (data.message.tool_calls) {
      for (const tc of data.message.tool_calls) {
        toolCalls.push({
          id: crypto.randomUUID(),
          name: tc.function.name,
          arguments: tc.function.arguments ?? {},
        });
      }
    }

    let finishReason: LLMChatResponse['finishReason'] = 'stop';
    if (toolCalls.length > 0) finishReason = 'tool_calls';
    else if (data.done_reason === 'length') finishReason = 'length';

    return {
      content: data.message.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
    };
  }

  private async chatOpenAI(
    messages: LLMMessage[],
    options?: LLMChatOptions
  ): Promise<LLMChatResponse> {
    const requestMessages = toOpenAIMessages(messages, this.isOllamaUrl());

    if (options?.systemPrompt) {
      requestMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: requestMessages,
      stream: false,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    // 外部からのAbortSignalも連携
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`LLM API error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const choice = data.choices[0];
    if (!choice) throw new Error('No choices in LLM response');

    const toolCalls: LLMToolCall[] = [];
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          args = { raw: tc.function.arguments };
        }
        toolCalls.push({
          id: tc.id || crypto.randomUUID(),
          name: tc.function.name,
          arguments: args,
        });
      }
    }

    let finishReason: LLMChatResponse['finishReason'] = 'stop';
    if (choice.finish_reason === 'tool_calls') finishReason = 'tool_calls';
    else if (choice.finish_reason === 'length') finishReason = 'length';

    // Thinking model: content が空で reasoning に推論が入ることがある
    let content = choice.message.content ?? '';
    if (!content && choice.message.reasoning) {
      content = choice.message.reasoning;
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
    };
  }

  async *chatStream(messages: LLMMessage[], options?: LLMChatOptions): AsyncGenerator<string> {
    // Thinking model + Ollama → ネイティブAPIでストリーミング（think:false対応）
    if (!this.thinking && this.isOllamaUrl()) {
      yield* this.chatStreamOllamaNative(messages, options);
      return;
    }

    const requestMessages = toOpenAIMessages(messages, this.isOllamaUrl());

    if (options?.systemPrompt) {
      requestMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: requestMessages,
      stream: true,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
    };

    if (options?.temperature !== undefined) body.temperature = options.temperature;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(`LLM API error ${response.status}: ${await response.text()}`);
    }

    if (!response.body) throw new Error('No response body for streaming');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let hasContent = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const chunk = JSON.parse(trimmed.slice(6)) as {
                choices: Array<{ delta: { content?: string; reasoning?: string } }>;
              };
              const delta = chunk.choices[0]?.delta;
              if (delta?.content) {
                hasContent = true;
                yield delta.content;
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Thinking model でcontentが空だった場合、non-streamingにフォールバック
    if (!hasContent) {
      const result = await this.chat(messages, options);
      if (result.content) yield result.content;
    }
  }

  /**
   * Ollama ネイティブ API (/api/chat) でストリーミング（think:false対応）
   */
  private async *chatStreamOllamaNative(
    messages: LLMMessage[],
    options?: LLMChatOptions
  ): AsyncGenerator<string> {
    const ollamaMessages = messages.map((msg) => {
      const m: { role: string; content: string; images?: string[] } = {
        role: msg.role,
        content: msg.content,
      };
      if (msg.images && msg.images.length > 0) {
        m.images = msg.images.map((img) => img.base64);
      }
      return m;
    });

    if (options?.systemPrompt) {
      ollamaMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: true,
      think: false,
    };

    body.options = {
      num_predict: options?.maxTokens ?? this.defaultMaxTokens,
      ...(this.numCtx && { num_ctx: this.numCtx }),
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
    }

    if (!response.body) throw new Error('No response body for streaming');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
            };
            if (chunk.message?.content) {
              yield chunk.message.content;
            }
          } catch {
            // skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
