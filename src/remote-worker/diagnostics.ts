import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

type ConnectionState =
  'connecting' | 'awaiting-confirmation' | 'connected' | 'disconnected' | 'stopped';

export interface WorkerConnectionStatus {
  pid: number;
  state: ConnectionState;
  updatedAt: string;
  lastConnectedAt?: string;
  lastError?: string;
  nextRetryAt?: string;
  closeCode?: number;
  cli: string;
  node: string;
}

// Never persist raw errors, URLs, tokens, or peer-supplied close reasons.
export function connectionError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (
    code &&
    /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(
      code
    )
  )
    return code;
  const message = error instanceof Error ? error.message : '';
  const http = /^Unexpected server response: (\d{3})$/.exec(message);
  if (http) return `HTTP ${http[1]}`;
  if (message === 'Opening handshake has timed out') return 'handshake timeout';
  return 'connection error (details withheld)';
}

export function closeReason(reason: string): string {
  return [
    'hello timeout',
    'unauthorized worker',
    'replaced by new connection',
    'gateway stopping',
    'invalid json',
    'invalid message',
  ].includes(reason)
    ? reason
    : 'peer closed connection (details withheld)';
}

export class WorkerDiagnostics {
  private status: WorkerConnectionStatus = {
    pid: process.pid,
    state: 'stopped',
    updatedAt: new Date().toISOString(),
    cli: process.argv[1] || 'unknown',
    node: process.execPath,
  };
  private writeFailed = false;

  constructor(private readonly path?: string) {}

  update(
    state: ConnectionState,
    fields: Partial<Pick<WorkerConnectionStatus, 'lastError' | 'nextRetryAt' | 'closeCode'>> = {}
  ): void {
    const now = new Date().toISOString();
    this.status = { ...this.status, state, updatedAt: now, nextRetryAt: undefined, ...fields };
    if (state === 'connected') this.status.lastConnectedAt = now;
    console.info(JSON.stringify({ event: 'remote-worker.connection', ...this.status }));
    if (!this.path) return;
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(this.status)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
      this.writeFailed = false;
    } catch {
      if (!this.writeFailed) console.error('Remote worker connection status could not be saved');
      this.writeFailed = true;
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Diagnostics must not stop the worker. */
      }
    }
  }
}

export function formatWorkerConnectionStatus(path: string, pid: number): string {
  try {
    const status = JSON.parse(readFileSync(path, 'utf8')) as WorkerConnectionStatus;
    if (
      status.pid !== pid ||
      !['connecting', 'awaiting-confirmation', 'connected', 'disconnected', 'stopped'].includes(
        status.state
      )
    ) {
      return '\nGateway: unknown (no status for the running PID)';
    }
    return [
      `Gateway: ${status.state} (last reported; no heartbeat verification)`,
      `Status updated: ${status.updatedAt}`,
      `Last connection confirmed: ${status.lastConnectedAt || 'never'}`,
      `Last error: ${status.lastError || 'none'}`,
      `Last close code: ${status.closeCode ?? 'none'}`,
      `Next retry: ${status.nextRetryAt || 'none'}`,
      `Running CLI: ${status.cli}`,
      `Node: ${status.node}`,
    ]
      .map((line) => `\n${line}`)
      .join('');
  } catch {
    return '\nGateway: unknown (connection status unavailable; restart with the current CLI)';
  }
}
