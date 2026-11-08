import { it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationService } from '../src/conversation-service.js';
import { followConversationTurn } from '../web-ui/src/conversationTurns.js';

it.skipIf(!process.env.XANGI_TURN_PERF_OUTPUT)(
  'measures receipt observation overhead with a fixed 20ms execution',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'receipt-benchmark-'));
    const service = new ConversationService({
      directory,
      busy: () => false,
      changed: () => {},
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { text: 'done' };
      },
      deliver: async () => undefined,
    });
    vi.stubGlobal('window', { sessionStorage: { setItem: () => {} } });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const parsed = new URL(String(url), 'http://localhost');
      const id = parsed.pathname.split('/')[3];
      let turn;
      if (init?.method === 'POST') {
        const input = JSON.parse(String(init.body));
        turn = service.submit({ ...input, appSessionId: id, contextKey: id, attachments: [] });
      } else {
        const requestId = parsed.pathname.split('/')[5];
        const after = parsed.searchParams.get('after');
        // The same harness runs on the base revision, which never requests notification waits.
        turn =
          after === null
            ? service.lookup(id, requestId)
            : await service.waitForChange(id, requestId, after, init!.signal!);
      }
      return new Response(JSON.stringify({ turn }), {
        status: init?.method === 'POST' ? 202 : 200,
      });
    });
    try {
      const samples: number[] = [];
      for (let i = 0; i < 10; i++) {
        const started = performance.now();
        await followConversationTurn(
          `fixture-${i}`,
          { requestId: `request-${i}`, message: 'fixture', files: [] },
          new AbortController().signal,
          () => {},
          () => {}
        );
        samples.push(performance.now() - started);
        await service.idle();
      }
      samples.sort((a, b) => a - b);
      writeFileSync(
        process.env.XANGI_TURN_PERF_OUTPUT!,
        JSON.stringify(
          { samples, p50ms: samples[4], p95ms: samples[9], executionDelayMs: 20 },
          null,
          2
        ) + '\n'
      );
    } finally {
      await service.close();
      fetcher.mockRestore();
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000
);
