import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyAgentError, formatErrorDiagnostic } from '../src/errors.js';
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
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: expect.anything() })
    );
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

  it('does not duplicate a generation after a late transport failure', async () => {
    const error = fetchFailure('UND_ERR_SOCKET');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(31_001);
    const client = new LLMClient('http://localhost:8001', 'test-model');

    await expect(client.chat(messages)).rejects.toBe(error);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

    await expect(client.chat(messages, { signal: controller.signal })).rejects.toThrow(
      'Request cancelled by user'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
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

describe('LLMClient timeout and cancellation reasons', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function pendingFetch() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('This operation was aborted', 'AbortError')),
            { once: true }
          );
        })
    );
  }

  it.each(['http://localhost:8001', 'http://localhost:11434'])(
    'classifies the real request deadline as timeout for %s without retry',
    async (url) => {
      vi.useFakeTimers();
      vi.stubEnv('LOCAL_LLM_TIMEOUT_MS', '50');
      const fetchSpy = pendingFetch();
      const external = new AbortController();
      const removeListener = vi.spyOn(external.signal, 'removeEventListener');
      const client = new LLMClient(url, 'test-model');
      const outcome = client.chat(messages, { signal: external.signal }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(50);
      const error = await outcome;
      expect(error.message).toBe('LLM request timed out after 50ms');
      expect(classifyAgentError(error)).toBe('timeout');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('preserves manual cancellation before the deadline and removes the listener', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LOCAL_LLM_TIMEOUT_MS', '50');
    const fetchSpy = pendingFetch();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const client = new LLMClient('http://localhost:8001', 'test-model');
    const outcome = client.chat(messages, { signal: controller.signal }).catch((error) => error);
    controller.abort();
    const error = await outcome;
    expect(classifyAgentError(error)).toBe('cancelled');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the first abort reason when cancellation arrives after timeout', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LOCAL_LLM_TIMEOUT_MS', '50');
    pendingFetch();
    const controller = new AbortController();
    const client = new LLMClient('http://localhost:8001', 'test-model');
    const outcome = client.chat(messages, { signal: controller.signal }).catch((error) => error);
    vi.advanceTimersByTime(50);
    controller.abort(new Error('Request cancelled by user'));
    expect(classifyAgentError(await outcome)).toBe('timeout');
  });
});

describe('LLM timeout budgets and stream liveness', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, '', 'invalid', '0', '-1'])(
    'uses the 30 minute model default for %s independently of TIMEOUT_MS',
    async (value) => {
      vi.useFakeTimers();
      vi.stubEnv('TIMEOUT_MS', '10');
      vi.stubEnv('LOCAL_LLM_TIMEOUT_MS', value);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
              once: true,
            });
          })
      );
      const client = new LLMClient('http://localhost:8001', 'test');
      let finished = false;
      const outcome = client.chat(messages).catch((error) => {
        finished = true;
        return error;
      });
      await vi.advanceTimersByTimeAsync(1_800_000 - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await outcome).timeoutMs).toBe(1_800_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['http://localhost:8001', 'http://localhost:11434'])(
    'resets the idle deadline on received data and aborts stalled streams for %s',
    async (url) => {
      vi.useFakeTimers();
      vi.stubEnv('LOCAL_LLM_TIMEOUT_MS', '50');
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel,
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));
      const client = new LLMClient(url, 'test');
      const chunks: string[] = [];
      const outcome = (async () => {
        for await (const chunk of client.chatStream(messages)) chunks.push(chunk);
      })().catch((e) => e);
      const encoder = new TextEncoder();
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(40);
        const data = url.includes('11434')
          ? JSON.stringify({ message: { content: 'a' } }) + '\n'
          : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'a' } }] }) + '\n\n';
        controller.enqueue(encoder.encode(data));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(chunks).toEqual(['a', 'a', 'a', 'a']);
      await vi.advanceTimersByTimeAsync(50);
      const error = await outcome;
      expect(error.streaming).toBe(true);
      expect(classifyAgentError(error)).toBe('timeout');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('keeps the non-streaming deadline through body consumption', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LOCAL_LLM_TIMEOUT_MS', '50');
    const cancel = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const outcome = new LLMClient('http://localhost:8001', 'test').chat(messages).catch((e) => e);
    await vi.advanceTimersByTimeAsync(50);
    const error = await outcome;
    expect(error.streaming).toBe(false);
    expect(classifyAgentError(error)).toBe('timeout');
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['http://localhost:8001', 'http://localhost:11434'])(
    'cancels a silent stream promptly for %s',
    async (url) => {
      vi.useFakeTimers();
      vi.stubEnv('LOCAL_LLM_TIMEOUT_MS', '50');
      const cancel = vi.fn();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel })));
      const controller = new AbortController();
      const client = new LLMClient(url, 'test');
      const outcome = (async () => {
        for await (const _chunk of client.chatStream(messages, { signal: controller.signal })) {
          /* drain */
        }
      })().catch((e) => e);
      await vi.advanceTimersByTimeAsync(1);
      controller.abort(new Error('Request cancelled by user'));
      expect(classifyAgentError(await outcome)).toBe('cancelled');
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
