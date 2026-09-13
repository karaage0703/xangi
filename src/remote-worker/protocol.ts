export const REMOTE_WORKER_PROTOCOL = 1;

export type WorkerCapability = 'system.info' | 'exec' | 'usb.list';

export interface WorkerHello {
  type: 'hello';
  protocol: number;
  workerId: string;
  token: string;
  platform: NodeJS.Platform;
  arch: string;
  capabilities: WorkerCapability[];
}

export interface WorkerRequest {
  type: 'request';
  id: string;
  method: WorkerCapability;
  params?: Record<string, unknown>;
}

export interface WorkerResponse {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type GatewayMessage = WorkerRequest;
export type NodeMessage = WorkerHello | WorkerResponse;
