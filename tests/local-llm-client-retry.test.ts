import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatErrorDiagnostic } from '../src/errors.js';
import { LLMClient } from '../src/local-llm/llm-client.js';
import type { LLMMessage } from '../src/local-llm/types.js';

const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }];

function openAiResponse(content = 'ok'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function openAiStreamResponse(content = 'stream recovered'): Response {
  const encoder = new TextEncoder();
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` + 'data: [DONE]\n\n';
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

function fetchFailure(code = 'UND_ERR_SOCKET'): TypeError {
  const cause = Object.assign(new Error('other side closed'), {
    code,
    errno: -104,
    address: '127.0.0.1',
    port: 8001,
  });
  return new TypeError('fetch failed', { cause });
}

describe('LLMClient transient transport retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries one transient fetch failure and returns the second response', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(fetchFailure())
      .mockResolvedValueOnce(openAiResponse('recovered'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new LLMClient('http://localhost:8001', 'test-model');

    const result = await client.chat(messages);

    expect(result.content).toBe('recovered');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('code=UND_ERR_SOCKET');
  });

  it('stops after the single retry when the transport error persists', async () => {
    const error = fetchFailure('ECONNRESET');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new LLMClient('http://localhost:8001', 'test-model');

    await expect(client.chat(messages)).rejects.toBe(error);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries a stream request only before the HTTP response starts', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(fetchFailure())
      .mockResolvedValueOnce(openAiStreamResponse());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new LLMClient('http://localhost:8001', 'test-model');
    let output = '';

    for await (const chunk of client.chatStream(messages)) output += chunk;

    expect(output).toBe('stream recovered');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = fetchFailure();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    const client = new LLMClient('http://localhost:8001', 'test-model');

    await expect(client.chat(messages, { signal: controller.signal })).rejects.toBe(error);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-network error', async () => {
    const error = new TypeError('invalid request body');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    const client = new LLMClient('http://localhost:8001', 'test-model');

    await expect(client.chat(messages)).rejects.toBe(error);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry an HTTP server error response', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('temporary overload', { status: 503 }));
    const client = new LLMClient('http://localhost:8001', 'test-model');

    await expect(client.chat(messages)).rejects.toThrow('LLM API error 503');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('includes nested fetch cause fields in diagnostics', () => {
    expect(formatErrorDiagnostic(fetchFailure())).toContain(
      'cause(name=Error, message=other side closed, code=UND_ERR_SOCKET, errno=-104, address=127.0.0.1, port=8001)'
    );
  });
});
