import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { arch, cpus, freemem, hostname, platform, totalmem } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import WebSocket from 'ws';
import {
  REMOTE_WORKER_PROTOCOL,
  type GatewayMessage,
  type WorkerCapability,
  type WorkerResponse,
} from './protocol.js';

export interface RemoteWorkerNodeConfig {
  gatewayUrl: string;
  workerId: string;
  tokenFile: string;
  workspaceRoots: string[];
  allowedCommands: string[];
  reconnectMs?: number;
  maxOutputBytes?: number;
  maxTimeoutMs?: number;
}

interface ExecParams {
  argv: string[];
  cwd: string;
  timeoutMs?: number;
}

function readToken(file: string): string {
  if (platform() !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new Error('remote worker token file must not be readable by group or others');
  }
  const token = readFileSync(file, 'utf8').trim();
  if (!token) throw new Error('remote worker token file is empty');
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export function validateExecParams(raw: unknown, config: RemoteWorkerNodeConfig): ExecParams {
  if (!isRecord(raw) || !Array.isArray(raw.argv) || raw.argv.length === 0) {
    throw new Error('exec requires a non-empty argv array');
  }
  if (!raw.argv.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error('exec argv must contain non-empty strings');
  }
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd)) {
    throw new Error('exec cwd must be an absolute path');
  }
  const cwd = realpathSync(raw.cwd);
  const roots = config.workspaceRoots.map((item) => realpathSync(item));
  if (!roots.some((root) => isInside(root, cwd))) {
    throw new Error('exec cwd is outside configured workspace roots');
  }
  const command = raw.argv[0];
  const allowed = config.allowedCommands.includes(command);
  if (!allowed) throw new Error(`command is not allowlisted: ${command}`);
  const timeoutMs = raw.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1)) {
    throw new Error('timeoutMs must be a positive integer');
  }
  return { argv: raw.argv as string[], cwd, timeoutMs: timeoutMs as number | undefined };
}

async function runCommand(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let exceeded = false;
    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        exceeded = true;
        child.kill('SIGTERM');
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (exceeded) return reject(new Error(`command output exceeded ${maxOutputBytes} bytes`));
      resolvePromise({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        signal,
      });
    });
  });
}

async function usbList(maxOutputBytes: number): Promise<unknown> {
  if (platform() === 'darwin') {
    const result = await runCommand(
      ['/usr/sbin/system_profiler', '-json', 'SPUSBDataType'],
      process.cwd(),
      30_000,
      maxOutputBytes
    );
    if (result.exitCode !== 0) throw new Error(result.stderr || 'system_profiler failed');
    return JSON.parse(result.stdout);
  }
  if (platform() === 'linux') {
    const result = await runCommand(['lsusb'], process.cwd(), 30_000, maxOutputBytes);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'lsusb failed');
    return { devices: result.stdout.split('\n').filter(Boolean) };
  }
  if (platform() === 'win32') {
    const script =
      'Get-PnpDevice -PresentOnly | Where-Object {$_.InstanceId -like "USB*"} | Select-Object Status,Class,FriendlyName,InstanceId | ConvertTo-Json -Depth 3';
    const result = await runCommand(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
      process.cwd(),
      30_000,
      maxOutputBytes
    );
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Get-PnpDevice failed');
    return { devices: result.stdout.trim() ? JSON.parse(result.stdout) : [] };
  }
  throw new Error(`usb.list is unsupported on ${platform()}`);
}

export function workerCapabilities(): WorkerCapability[] {
  return ['system.info', 'exec', 'usb.list'];
}

export async function executeWorkerMethod(
  method: WorkerCapability,
  params: unknown,
  config: RemoteWorkerNodeConfig
): Promise<unknown> {
  if (method === 'system.info') {
    return {
      workerId: config.workerId,
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      capabilities: workerCapabilities(),
    };
  }
  const maxOutputBytes = config.maxOutputBytes ?? 1_000_000;
  if (method === 'usb.list') return usbList(maxOutputBytes);
  if (method === 'exec') {
    const request = validateExecParams(params, config);
    return runCommand(
      request.argv,
      request.cwd,
      Math.min(request.timeoutMs ?? 120_000, config.maxTimeoutMs ?? 300_000),
      maxOutputBytes
    );
  }
  throw new Error(`unsupported worker method: ${method}`);
}

export class RemoteWorkerNode {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly config: RemoteWorkerNodeConfig) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'worker stopping');
  }

  private connect(): void {
    const socket = new WebSocket(this.config.gatewayUrl, { handshakeTimeout: 10_000 });
    this.socket = socket;
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: REMOTE_WORKER_PROTOCOL,
          workerId: this.config.workerId,
          token: readToken(this.config.tokenFile),
          platform: platform(),
          arch: arch(),
          capabilities: workerCapabilities(),
        })
      );
    });
    socket.on('message', async (data) => {
      let message: GatewayMessage;
      try {
        message = JSON.parse(data.toString()) as GatewayMessage;
        if (message.type !== 'request') throw new Error('invalid gateway message');
        const result = await executeWorkerMethod(message.method, message.params, this.config);
        socket.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result }));
      } catch (error) {
        const id = typeof message! === 'object' && message! ? message!.id : 'unknown';
        const response: WorkerResponse = {
          type: 'response',
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.config.reconnectMs ?? 3_000);
      }
    });
  }
}

export function loadRemoteWorkerNodeConfig(path: string): RemoteWorkerNodeConfig {
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as RemoteWorkerNodeConfig;
  if (!parsed.gatewayUrl || !parsed.workerId || !parsed.tokenFile) {
    throw new Error('worker config requires gatewayUrl, workerId, and tokenFile');
  }
  if (!Array.isArray(parsed.workspaceRoots) || !Array.isArray(parsed.allowedCommands)) {
    throw new Error('worker config requires workspaceRoots and allowedCommands arrays');
  }
  return parsed;
}
