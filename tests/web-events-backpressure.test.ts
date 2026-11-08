import { it, expect, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { handleEventsStreamRequest } from '../src/events-stream-server.js';
import { events, _resetEventsConfigForTest } from '../src/events-emitter.js';

it('coalesces blocked deltas while retaining completion and drains without dropping the latest text', async () => {
  vi.stubEnv('XANGI_EVENTS_ENABLED', 'true');
  _resetEventsConfigForTest();
  let response!: ServerResponse;
  const server = createServer((req, res) => {
    response = res;
    handleEventsStreamRequest(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stream = await fetch(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/api/events/stream`
  );
  const reader = stream.body!.getReader();
  await reader.read();
  const write = response.write.bind(response);
  const spy = vi
    .spyOn(response, 'write')
    .mockImplementation((...args: Parameters<typeof response.write>) => {
      write(...args);
      return false;
    });
  const context = { threadId: 'web:fixture', turnId: 'fixture-turn', platform: 'web' as const };
  try {
    for (let i = 0; i < 100; i++)
      events.messageDelta({ ...context, chunk: String(i), fullText: String(i) });
    events.turnComplete({ ...context, text: 'final' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    response.emit('drain');
    let text = '';
    while (!text.includes('turn.complete'))
      text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"full_text":"99"');
    expect(text).toContain('"text":"final"');
  } finally {
    spy.mockRestore();
    await reader.cancel();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    _resetEventsConfigForTest();
  }
});
