import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ValidationError } from '../errors.js';
import {
  REMOTE_WORKER_PROTOCOL,
  type NodeMessage,
  type WorkerCapability,
  type WorkerHello,
  type WorkerResponse,
} from './protocol.js';

export interface RemoteWorkerRegistration {
  id: string;
  tokenFile: string;
}

interface ConnectedWorker {
  hello: WorkerHello;
  socket: WebSocket;
}

interface PendingRequest {
  workerId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingPairing {
  workerId: string;
  gatewayUrl: string;
  expiresAt: number;
}

interface PairingPayload {
  version: 1;
  pairUrl: string;
  code: string;
  workerId: string;
  expiresAt: number;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function loadRegistrations(path?: string): RemoteWorkerRegistration[] {
  if (!path) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('remote workers config must be an array');
  return parsed.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as RemoteWorkerRegistration).id !== 'string' ||
      typeof (item as RemoteWorkerRegistration).tokenFile !== 'string'
    ) {
      throw new Error('each remote worker requires id and tokenFile');
    }
    return item as RemoteWorkerRegistration;
  });
}

function readToken(file: string): string {
  if (platform() !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new Error('remote worker token file must not be readable by group or others');
  }
  return readFileSync(file, 'utf8').trim();
}

export class RemoteWorkerGateway {
  private readonly workers = new Map<string, ConnectedWorker>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pairings = new Map<string, PendingPairing>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1_100_000 });
  private registrations: RemoteWorkerRegistration[] = [];
  private listener?: Server;

  constructor(private readonly configPath?: string) {
    this.registrations = loadRegistrations(configPath);
  }

  attach(server: Server): void {
    server.on('request', (request, response) => {
      if (request.method === 'POST' && request.url === '/api/remote-workers/pair') {
        this.handlePairRequest(request, response);
      }
    });
    const handler = (
      request: import('node:http').IncomingMessage,
      socket: import('node:stream').Duplex,
      head: Buffer
    ) => {
      if (request.url !== '/api/remote-workers/connect') return;
      this.wss.handleUpgrade(request, socket, head, (ws) => this.handleConnection(ws));
    };
    server.on('upgrade', handler);
  }

  listen(port: number, host = '127.0.0.1'): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('remote worker port must be between 1 and 65535');
    }
    const listener = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/remote-workers/pair') return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    this.listener = listener;
    this.attach(listener);
    listener.listen(port, host, () => {
      console.log(`[remote-worker] Gateway listening on ws://${host}:${port}`);
    });
  }

  createPairing(workerId: string, gatewayUrl: string, ttlMs = 600_000): string {
    if (!this.configPath) throw new ValidationError('remote worker registration config is missing');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workerId)) {
      throw new ValidationError(
        'worker id must use 1-64 letters, numbers, dot, underscore, or dash'
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(gatewayUrl);
    } catch {
      throw new ValidationError('gateway URL is invalid');
    }
    if (!['ws:', 'wss:'].includes(parsed.protocol)) {
      throw new ValidationError('gateway URL must use ws:// or wss://');
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 600_000) {
      throw new ValidationError('pairing TTL must be between 10 and 600 seconds');
    }
    for (const [code, pairing] of this.pairings) {
      if (pairing.expiresAt < Date.now()) this.pairings.delete(code);
    }
    if (this.pairings.size >= 100) {
      throw new ValidationError('too many pending remote worker pairings');
    }
    const code = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    this.pairings.set(code, { workerId, gatewayUrl: parsed.toString(), expiresAt });
    const pairUrl = new URL(parsed.toString());
    pairUrl.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    pairUrl.pathname = '/api/remote-workers/pair';
    pairUrl.search = '';
    pairUrl.hash = '';
    const payload: PairingPayload = {
      version: 1,
      pairUrl: pairUrl.toString(),
      code,
      workerId,
      expiresAt,
    };
    return `xangi-pair://${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  }

  close(): void {
    for (const worker of this.workers.values()) worker.socket.close(1001, 'gateway stopping');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('remote worker gateway stopped'));
    }
    this.pending.clear();
    this.wss.close();
    this.listener?.close();
    this.listener = undefined;
  }

  list(): unknown[] {
    this.registrations = loadRegistrations(this.configPath);
    return this.registrations.map(({ id }) => {
      const hello = this.workers.get(id)?.hello;
      return {
        id,
        connected: Boolean(hello),
        ...(hello
          ? {
              platform: hello.platform,
              arch: hello.arch,
              capabilities: hello.capabilities,
            }
          : {}),
      };
    });
  }

  async request(
    workerId: string,
    method: WorkerCapability,
    params?: Record<string, unknown>,
    timeoutMs = 130_000
  ): Promise<unknown> {
    const worker = this.workers.get(workerId);
    if (!worker || worker.socket.readyState !== WebSocket.OPEN) {
      throw new ValidationError(`Remote worker is not connected: ${workerId}`);
    }
    if (!worker.hello.capabilities.includes(method)) {
      throw new ValidationError(`Remote worker ${workerId} does not provide ${method}`);
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Remote worker request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { workerId, resolve, reject, timer });
      worker.socket.send(JSON.stringify({ type: 'request', id, method, params }));
    });
  }

  private handleConnection(socket: WebSocket): void {
    let workerId: string | undefined;
    const helloTimer = setTimeout(() => socket.close(1008, 'hello timeout'), 5_000);
    socket.on('message', (data) => {
      let message: NodeMessage;
      try {
        message = JSON.parse(data.toString()) as NodeMessage;
      } catch {
        socket.close(1007, 'invalid json');
        return;
      }
      if (!workerId) {
        if (message.type !== 'hello' || !this.acceptHello(message)) {
          socket.close(1008, 'unauthorized worker');
          return;
        }
        clearTimeout(helloTimer);
        workerId = message.workerId;
        this.workers.get(workerId)?.socket.close(1008, 'replaced by new connection');
        this.workers.set(workerId, { hello: message, socket });
        return;
      }
      if (message.type !== 'response') return;
      this.handleResponse(workerId, message);
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (workerId && this.workers.get(workerId)?.socket === socket) this.workers.delete(workerId);
    });
  }

  private acceptHello(hello: WorkerHello): boolean {
    if (hello.protocol !== REMOTE_WORKER_PROTOCOL) return false;
    this.registrations = loadRegistrations(this.configPath);
    const registration = this.registrations.find((item) => item.id === hello.workerId);
    if (!registration) return false;
    return safeEqual(readToken(registration.tokenFile), hello.token);
  }

  private handlePairRequest(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse
  ): void {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 16_384) request.destroy();
    });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { code?: unknown };
        if (typeof parsed.code !== 'string') throw new ValidationError('pairing code is required');
        const pending = this.pairings.get(parsed.code);
        this.pairings.delete(parsed.code);
        if (!pending || pending.expiresAt < Date.now()) {
          response.writeHead(401, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'pairing code is invalid or expired' }));
          return;
        }
        const token = randomBytes(32).toString('base64url');
        this.persistRegistration(pending.workerId, token);
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(
          JSON.stringify({
            workerId: pending.workerId,
            gatewayUrl: pending.gatewayUrl,
            token,
          })
        );
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request' })
        );
      }
    });
  }

  private persistRegistration(workerId: string, token: string): void {
    if (!this.configPath) throw new Error('remote worker registration config is missing');
    const directory = dirname(this.configPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const digest = createHash('sha256').update(workerId).digest('hex').slice(0, 16);
    const tokenFile = join(directory, `worker-${digest}.token`);
    const tokenTemp = `${tokenFile}.tmp-${process.pid}`;
    writeFileSync(tokenTemp, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenTemp, 0o600);
    renameSync(tokenTemp, tokenFile);
    const registrations = loadRegistrations(this.configPath).filter((item) => item.id !== workerId);
    registrations.push({ id: workerId, tokenFile });
    const configTemp = join(directory, `.${basename(this.configPath)}.tmp-${process.pid}`);
    writeFileSync(configTemp, `${JSON.stringify(registrations, null, 2)}\n`, { mode: 0o600 });
    chmodSync(configTemp, 0o600);
    renameSync(configTemp, this.configPath);
    this.registrations = registrations;
  }

  private handleResponse(workerId: string, response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending || pending.workerId !== workerId) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error || 'remote worker request failed'));
  }
}

export function executeRemoteWorkerCommand(
  gateway: RemoteWorkerGateway | null,
  flags: Record<string, string>
): Promise<string> | string {
  if (!gateway) throw new ValidationError('remote workers are not available on this instance');
  const action = flags.action || 'list';
  if (action === 'list') return JSON.stringify(gateway.list(), null, 2);
  const workerId = flags.worker?.trim();
  if (!workerId) throw new ValidationError('remote_worker requires --worker');
  if (action === 'pair-create') {
    const gatewayUrl = flags['gateway-url']?.trim();
    if (!gatewayUrl) throw new ValidationError('pair-create requires --gateway-url');
    const ttlMs = flags['ttl-seconds'] ? Number(flags['ttl-seconds']) * 1_000 : 600_000;
    return gateway.createPairing(workerId, gatewayUrl, ttlMs);
  }
  if (action === 'info') return gateway.request(workerId, 'system.info').then(format);
  if (action === 'usb-list') return gateway.request(workerId, 'usb.list').then(format);
  if (action === 'exec') {
    if (!flags['argv-json']) throw new ValidationError('remote_worker exec requires --argv-json');
    let argv: unknown;
    try {
      argv = JSON.parse(flags['argv-json']);
    } catch {
      throw new ValidationError('--argv-json must be valid JSON');
    }
    return gateway
      .request(workerId, 'exec', {
        argv,
        cwd: flags.cwd,
        ...(flags['timeout-ms'] ? { timeoutMs: Number(flags['timeout-ms']) } : {}),
      })
      .then(format);
  }
  throw new ValidationError(`unknown remote_worker action: ${action}`);
}

function format(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
