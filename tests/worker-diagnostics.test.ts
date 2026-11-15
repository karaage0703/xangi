import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  WorkerDiagnostics,
  connectionError,
  closeReason,
  formatWorkerConnectionStatus,
  type WorkerConnectionStatus,
} from '../src/remote-worker/diagnostics.js';
import { RemoteWorkerNode } from '../src/remote-worker/node.js';
import { RemoteWorkerGateway } from '../src/remote-worker/gateway.js';

let root: string;
let statusPath: string;
const cleanup: Array<() => void> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worker-diagnostics-'));
  statusPath = join(root, 'worker-status.json');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function status(): WorkerConnectionStatus {
  return JSON.parse(readFileSync(statusPath, 'utf8')) as WorkerConnectionStatus;
}
function node(url: string): RemoteWorkerNode {
  const tokenFile = join(root, 'token');
  writeFileSync(tokenFile, 'super-secret-token', { mode: 0o600 });
  const worker = new RemoteWorkerNode(
    {
      gatewayUrl: url,
      workerId: 'test',
      tokenFile,
      workspaceRoots: [root],
      allowedCommands: [],
      reconnectMs: 50,
    },
    new WorkerDiagnostics(statusPath)
  );
  cleanup.push(() => worker.stop());
  return worker;
}
async function server() {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => http.close());
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { http, url: `ws://127.0.0.1:${address.port}/api/remote-workers/connect` };
}

describe('worker connection diagnostics', () => {
  it('does not expose raw secrets from errors or close reasons', () => {
    expect(connectionError(new Error('ws://user:super-secret-token@host/?token=secret'))).toBe(
      'connection error (details withheld)'
    );
    expect(connectionError(Object.assign(new Error('secret'), { code: 'ECONNREFUSED' }))).toBe(
      'ECONNREFUSED'
    );
    expect(connectionError(new Error('Unexpected server response: 401'))).toBe('HTTP 401');
    expect(closeReason('super-secret-token')).not.toContain('super-secret-token');
    expect(closeReason('unauthorized worker')).toBe('unauthorized worker');
  });

  it('confirms authentication, persists private status and records reconnect history', async () => {
    const { http, url } = await server();
    const registrations = join(root, 'workers.json');
    writeFileSync(join(root, 'expected-token'), 'super-secret-token', { mode: 0o600 });
    writeFileSync(
      registrations,
      JSON.stringify([{ id: 'test', tokenFile: join(root, 'expected-token') }])
    );
    const gateway = new RemoteWorkerGateway(registrations);
    gateway.attach(http);
    cleanup.push(() => gateway.close());
    const worker = node(url);
    worker.start();
    await expect.poll(() => status().state).toBe('connected');
    const connectedAt = status().lastConnectedAt;
    expect(connectedAt).toBeTruthy();
    expect(statSync(statusPath).mode & 0o777).toBe(0o600);
    expect(formatWorkerConnectionStatus(statusPath, process.pid)).toContain('Gateway: connected');
    gateway.close();
    await expect.poll(() => status().lastError).toBe('gateway stopping');
    expect(status().lastConnectedAt).toBe(connectedAt);
    await expect.poll(() => status().nextRetryAt).toBeTruthy();
    worker.stop();
    expect(status().state).toBe('stopped');
    expect(status().nextRetryAt).toBeUndefined();
    expect(readFileSync(statusPath, 'utf8')).not.toContain('super-secret-token');
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('super-secret-token');
  });

  it('does not treat WebSocket open as authenticated and supports older gateways', async () => {
    const { http, url } = await server();
    const wss = new WebSocketServer({ server: http });
    cleanup.push(() => {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    });
    wss.on('connection', (socket) =>
      socket.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'hello') {
          setTimeout(() => {
            if (socket.readyState === 1)
              socket.send(JSON.stringify({ type: 'request', id: 'test', method: 'system.info' }));
          }, 100);
        }
      })
    );
    const worker = node(url);
    worker.start();
    await expect.poll(() => status().state, { interval: 5 }).toBe('awaiting-confirmation');
    expect(status().lastConnectedAt).toBeUndefined();
    await expect.poll(() => status().state).toBe('connected');
  });

  it('records refused connections and retry time without claiming success', async () => {
    const { http, url } = await server();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    const worker = node(url);
    worker.start();
    await expect.poll(() => status().lastError).toBe('ECONNREFUSED');
    await expect.poll(() => status().nextRetryAt).toBeTruthy();
    expect(status().lastConnectedAt).toBeUndefined();
  });

  it('records authentication rejection without a successful connection', async () => {
    const { http, url } = await server();
    const registrations = join(root, 'workers.json');
    writeFileSync(registrations, '[]');
    const gateway = new RemoteWorkerGateway(registrations);
    gateway.attach(http);
    cleanup.push(() => gateway.close());
    node(url).start();
    await expect.poll(() => status().lastError).toBe('unauthorized worker');
    expect(status().closeCode).toBe(1008);
    expect(status().lastConnectedAt).toBeUndefined();
  });

  it('reconnects and confirms a new session after a peer disconnect', async () => {
    const { http, url } = await server();
    const wss = new WebSocketServer({ server: http });
    cleanup.push(() => {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    });
    let connections = 0;
    wss.on('connection', (socket) => {
      connections++;
      socket.on('message', (data) => {
        if (JSON.parse(data.toString()).type !== 'hello') return;
        if (connections === 1) socket.close(1008, 'super-secret-token');
        else socket.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
      });
    });
    const worker = node(url);
    worker.start();
    await expect.poll(() => status().state).toBe('connected');
    expect(connections).toBe(2);
    expect(status().nextRetryAt).toBeUndefined();
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('super-secret-token');
    worker.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connections).toBe(2);
  });

  it('handles invalid URLs and a missing token file without uncaught exceptions', async () => {
    const badUrl = node('invalid-url');
    expect(() => badUrl.start()).not.toThrow();
    expect(status().state).toBe('disconnected');
    expect(status().nextRetryAt).toBeTruthy();
    badUrl.stop();
    const { http, url } = await server();
    const wss = new WebSocketServer({ server: http });
    cleanup.push(() => {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    });
    const worker = node(url);
    rmSync(join(root, 'token'));
    worker.start();
    await expect
      .poll(() => status().lastError)
      .toBe('worker hello failed (check local token file)');
    expect(status().lastConnectedAt).toBeUndefined();
  });

  it('rejects stale PID status and handles missing or corrupt status', () => {
    expect(formatWorkerConnectionStatus(statusPath, process.pid)).toContain('unknown');
    new WorkerDiagnostics(statusPath).update('connected');
    expect(formatWorkerConnectionStatus(statusPath, process.pid + 1)).toContain('unknown');
    writeFileSync(statusPath, '{');
    expect(formatWorkerConnectionStatus(statusPath, process.pid)).toContain('unknown');
  });

  it('continues when diagnostic storage fails and reports that failure once', () => {
    const diagnostics = new WorkerDiagnostics(join(root, 'missing', 'state'));
    expect(() => diagnostics.update('connecting')).not.toThrow();
    diagnostics.update('disconnected');
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
