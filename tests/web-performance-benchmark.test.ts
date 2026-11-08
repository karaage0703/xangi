import { it, vi } from 'vitest';
vi.mock('../src/backend-auth-status.js', () => ({ backendAuthenticationSnapshot: async () => [] }));
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { startWebChat } from '../src/web-chat.js';
import { initSessions, clearSessions } from '../src/sessions.js';
import { initSettings, clearSettingsCache } from '../src/settings.js';
import type { AgentRunner } from '../src/agent-runner.js';

it.skipIf(!process.env.XANGI_PERF_OUTPUT)(
  'measures synthetic session list scaling without external backends',
  async () => {
    const results: unknown[] = [];
    for (const mode of ['managed', 'unmanaged']) {
      for (const count of [100, 1000, 5000]) {
        const root = mkdtempSync(join(tmpdir(), 'xangi-web-audit-'));
        const dataDir = join(root, '.xangi');
        mkdirSync(dataDir);
        mkdirSync(join(root, 'logs', 'sessions'), { recursive: true });
        const sessions: Record<string, unknown> = {};
        const stamp = new Date().toISOString();
        for (let i = 0; i < count; i++) {
          const id = `fixture-${String(i).padStart(6, '0')}`;
          writeFileSync(
            join(root, 'logs', 'sessions', `${id}.jsonl`),
            JSON.stringify({
              role: 'user',
              content: `synthetic message ${i}`,
              createdAt: stamp,
            }) + '\n'
          );
          if (mode === 'managed')
            sessions[id] = {
              id,
              contextKey: `fixture:${i}`,
              platform: 'web',
              scope: 'interactive',
              title: `Synthetic ${i}`,
              createdAt: stamp,
              updatedAt: stamp,
              lifecycle: 'closed',
              messageCount: 1,
            };
        }
        writeFileSync(
          join(dataDir, 'sessions.json'),
          JSON.stringify({ sessions, activeByContext: {} })
        );
        process.env.WORKSPACE_PATH = root;
        process.env.DATA_DIR = dataDir;
        process.env.XANGI_EXTENSIONS_FILE = join(dataDir, 'extensions.json');
        process.env.XANGI_SESSION_RETENTION_DAYS = '0';
        initSessions(dataDir);
        initSettings(dataDir);
        const probe = createServer().listen(0, '127.0.0.1');
        await once(probe, 'listening');
        const port = (probe.address() as { port: number }).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        const server = startWebChat({ port, host: '127.0.0.1', agentRunner: {} as AgentRunner });
        if (!server.listening) await once(server, 'listening');
        try {
          const samples: number[] = [];
          let bytes = 0;
          let coldMs = 0;
          for (let i = 0; i < 22; i++) {
            const start = performance.now();
            const response = await fetch(`http://127.0.0.1:${port}/api/sessions?limit=100`);
            const body = await response.text();
            if (!response.ok || JSON.parse(body).sessions.length !== 100) throw new Error(body);
            bytes = Buffer.byteLength(body);
            if (i === 0) coldMs = performance.now() - start;
            if (i >= 2) samples.push(performance.now() - start);
          }
          samples.sort((a, b) => a - b);
          results.push({
            mode,
            count,
            coldMs: +coldMs.toFixed(2),
            samples: samples.length,
            bytes,
            p50ms: +samples[9].toFixed(2),
            p95ms: +samples[18].toFixed(2),
          });
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          clearSessions();
          clearSettingsCache();
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
    writeFileSync(process.env.XANGI_PERF_OUTPUT!, JSON.stringify(results, null, 2) + '\n');
  },
  120_000
);
