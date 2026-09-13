/** Authenticated HTTP API for directed requests between xangi instances. */
import type { IncomingMessage, ServerResponse } from 'http';
import type { AgentRunner } from '../agent-runner.js';
import { sendJson } from '../web-http.js';
import { getInterChatConfig } from './index.js';
import { processDirectedHttpRequest, type DirectedHttpRequest } from './directed-request.js';

function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const jsonResponse = (res: ServerResponse, status: number, body: unknown): void =>
  sendJson(res, status, body, { 'Cache-Control': 'no-cache' });

/** Return true when the request belongs to the inter-instance HTTP API. */
export async function handleInterChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agentRunner?: AgentRunner,
  workdir?: string
): Promise<boolean> {
  const url = (req.url || '/').split('?')[0];
  if (!url.startsWith('/api/inter-chat')) return false;

  const cfg = getInterChatConfig();
  if (!cfg.enabled) {
    jsonResponse(res, 503, {
      error: 'inter-instance-chat is disabled',
      hint: 'Set INTER_INSTANCE_CHAT_ENABLED=true to enable',
    });
    return true;
  }

  if (req.method === 'POST' && url === '/api/inter-chat/ask') {
    if (!agentRunner) {
      jsonResponse(res, 503, { error: 'agent runner is unavailable' });
      return true;
    }
    try {
      const raw = await readBody(req, 72 * 1024);
      const body = raw ? (JSON.parse(raw) as Partial<DirectedHttpRequest>) : {};
      const result = await processDirectedHttpRequest(
        body,
        req.headers.authorization,
        agentRunner,
        workdir
      );
      jsonResponse(res, result.status, result.body);
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === 'GET' && url === '/api/inter-chat/config') {
    jsonResponse(res, 200, {
      enabled: cfg.enabled,
      selfInstanceId: cfg.selfInstanceId,
      selfLabel: cfg.selfLabel,
      peers: Object.keys(cfg.peers),
      tokenConfigured: Boolean(cfg.token),
      allowedPeers: cfg.allowedPeers,
    });
    return true;
  }

  jsonResponse(res, 404, { error: `not found: ${url}` });
  return true;
}
