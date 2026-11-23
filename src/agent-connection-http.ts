import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { connectionSessionId, connectionSessionRef } from './connection-session-id.js';
import { readJsonBody, sendJson } from './web-http.js';
import { agentConnectionStatus } from './agent-connections.js';
import { WebProjectError } from './web-projects.js';

type Endpoint = { port: number; key: string };
const endpoints = new Map<string, Endpoint>();
export const connectionApiHeader = 'x-xangi-connection-key';
export function receiveConnectionApi(connectionId: string, message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const value = message as Record<string, unknown>;
  if (
    value.type === 'agent-connection-api-ready' &&
    typeof value.port === 'number' &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65535 &&
    typeof value.key === 'string' &&
    /^[a-f0-9]{64}$/.test(value.key)
  )
    endpoints.set(connectionId, { port: value.port, key: value.key });
}
export function removeConnectionApi(connectionId: string): void {
  endpoints.delete(connectionId);
}

export function privateWorkChannelRoute(path: string) {
  const match = path.match(/^\/api\/connection\/(discord|slack)-(channels|session)$/);
  if (!match) return undefined;
  return {
    platform: match[1] as 'discord' | 'slack',
    method: match[2] === 'channels' ? 'GET' : 'POST',
  };
}

export async function requestDedicatedWorkChannel<T>(
  connectionId: string,
  platform: 'discord' | 'slack',
  body?: { projectId?: string; channelId: string; title: string }
): Promise<T> {
  const target = endpoints.get(connectionId);
  if (!target || agentConnectionStatus.get(connectionId) !== 'ready')
    throw new WebProjectError('専用Botに接続できません。接続状態を確認してください', 503);
  let response: Response;
  let result;
  try {
    response = await fetch(
      `http://127.0.0.1:${target.port}/api/connection/${platform}-${body ? 'session' : 'channels'}`,
      {
        method: body ? 'POST' : 'GET',
        headers: { [connectionApiHeader]: target.key, 'content-type': 'application/json' },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }
    );
    result = await response.json();
  } catch {
    throw new WebProjectError('専用Botとの通信に失敗しました', 502);
  }
  if (!response.ok)
    throw new WebProjectError(result.error || '専用Botとの通信に失敗しました', response.status);
  return result as T;
}

export async function closeConnectionWaiting(
  ids: string[]
): Promise<Array<{ id: string; status: string }>> {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const ref = connectionSessionRef(id);
    if (ref) groups.set(ref.connectionId, [...(groups.get(ref.connectionId) || []), ref.sessionId]);
  }
  const results = await Promise.all(
    [...groups].map(async ([connectionId, sessionIds]) => {
      const target = endpoints.get(connectionId);
      if (!target)
        return sessionIds.map((id) => ({
          id: connectionSessionId(connectionId, id),
          status: 'unavailable',
        }));
      try {
        const response = await fetch(`http://127.0.0.1:${target.port}/api/sessions/close-waiting`, {
          method: 'POST',
          headers: { [connectionApiHeader]: target.key, 'content-type': 'application/json' },
          body: JSON.stringify({ ids: sessionIds }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('Dedicated completion failed');
        const value = (await response.json()) as { results: Array<{ id: string; status: string }> };
        return sessionIds.map((id) => ({
          id: connectionSessionId(connectionId, id),
          status: value.results.find((row) => row.id === id)?.status || 'failed',
        }));
      } catch {
        return sessionIds.map((id) => ({
          id: connectionSessionId(connectionId, id),
          status: 'failed',
        }));
      }
    })
  );
  return results.flat();
}

const idKeys = new Set([
  'appSessionId',
  'parentAppSessionId',
  'sourceAppSessionId',
  'externalSourceSessionId',
]);
/** Rewrite identities, never conversation text, message IDs, request IDs or provider IDs. */
export function mapConnectionJson(
  value: unknown,
  connectionId: string,
  outgoing: boolean
): unknown {
  if (Array.isArray(value))
    return value.map((item) => mapConnectionJson(item, connectionId, outgoing));
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  const sessionObject = 'platform' in row || 'contextKey' in row;
  const sessionResult = row.ok === true || row.kind === 'session';
  return Object.fromEntries(
    Object.entries(row).map(([key, item]) => {
      if (
        typeof item === 'string' &&
        (idKeys.has(key) ||
          (key === 'id' && sessionObject) ||
          (sessionResult && ['sessionId', 'sourceId'].includes(key)))
      ) {
        if (outgoing) return [key, connectionSessionId(connectionId, item)];
        const ref = connectionSessionRef(item);
        if (ref && ref.connectionId !== connectionId)
          throw new Error('Conversation belongs to another Bot');
        return [key, ref?.sessionId ?? item];
      }
      return [key, mapConnectionJson(item, connectionId, outgoing)];
    })
  );
}

function responseTransform(connectionId: string, sse: boolean): Transform {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const frame = (text: string) =>
    text
      .split('\n')
      .map((line) => {
        if (!line.startsWith('data:')) return line;
        try {
          return (
            'data: ' +
            JSON.stringify(mapConnectionJson(JSON.parse(line.slice(5)), connectionId, true))
          );
        } catch {
          return line;
        }
      })
      .join('\n');
  return new Transform({
    transform(chunk, _encoding, done) {
      pending += decoder.write(chunk);
      if (!sse && Buffer.byteLength(pending) > 32 * 1024 * 1024) {
        done(new Error('Conversation response too large'));
        return;
      }
      if (sse) {
        let index;
        while ((index = pending.indexOf('\n\n')) >= 0) {
          this.push(frame(pending.slice(0, index)) + '\n\n');
          pending = pending.slice(index + 2);
        }
      }
      done();
    },
    flush(done) {
      pending += decoder.end();
      try {
        if (pending)
          this.push(
            sse
              ? frame(pending)
              : JSON.stringify(mapConnectionJson(JSON.parse(pending), connectionId, true))
          );
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

/** Only session-scoped operations are exposed by a dedicated worker's private listener. */
export function isConnectionSessionRoute(path: string): boolean {
  return (
    /^\/api\/sessions\/[^/]+(?:\/.*)?$/.test(path) ||
    /^\/api\/user-input\/[^/]+$/.test(path) ||
    path === '/api/chat' ||
    path === '/api/web-commands'
  );
}

export async function proxyConnectionSession(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId?: string,
  body?: Record<string, unknown>
): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  const match = url.pathname.match(/^\/api\/(?:sessions|user-input)\/([^/]+)(\/.*)?$/);
  const ref = connectionSessionRef(sessionId ?? (match ? decodeURIComponent(match[1]) : ''));
  if (!ref) return false;
  const target = endpoints.get(ref.connectionId);
  if (!target) {
    sendJson(res, 503, { error: '専用Botに接続できません。接続状態を確認してください' });
    return true;
  }
  if (!isConnectionSessionRoute(url.pathname)) {
    sendJson(res, 404, { error: 'Unknown conversation route' });
    return true;
  }
  if (match) url.pathname = url.pathname.replace(match[1], encodeURIComponent(ref.sessionId));
  if (url.pathname === '/api/web-commands' && req.method === 'GET')
    url.searchParams.set('appSessionId', ref.sessionId);
  let data: Buffer | undefined;
  try {
    if (!['GET', 'HEAD'].includes(req.method || ''))
      data = Buffer.from(
        JSON.stringify(
          mapConnectionJson(body ?? (await readJsonBody(req)), ref.connectionId, false)
        )
      );
  } catch {
    sendJson(res, 400, { error: 'Invalid conversation request' });
    return true;
  }
  const connectionId = ref.connectionId;
  await new Promise<void>((resolve) => {
    const headers: Record<string, string> = { [connectionApiHeader]: target.key };
    for (const name of ['content-type', 'accept', 'last-event-id']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    if (data) headers['content-length'] = String(data.length);
    const upstream = request(
      {
        host: '127.0.0.1',
        port: target.port,
        path: url.pathname + url.search,
        method: req.method,
        headers,
      },
      (remote) => {
        res.statusCode = remote.statusCode || 502;
        for (const [key, value] of Object.entries(remote.headers)) {
          if (
            value !== undefined &&
            ![
              'connection',
              'transfer-encoding',
              'content-length',
              'set-cookie',
              connectionApiHeader,
            ].includes(key)
          )
            res.setHeader(key, value);
        }
        const type = String(remote.headers['content-type'] || '');
        if (type.includes('application/json') || type.includes('text/event-stream')) {
          const transform = responseTransform(connectionId, type.includes('text/event-stream'));
          transform.on('error', () => {
            remote.destroy();
            res.destroy();
            resolve();
          });
          remote.pipe(transform).pipe(res);
        } else remote.pipe(res);
        remote.on('error', () => {
          res.destroy();
          resolve();
        });
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) sendJson(res, 502, { error: '専用Botとの通信に失敗しました' });
      else res.end();
      resolve();
    });
    res.once('close', () => {
      upstream.destroy();
      resolve();
    });
    res.once('finish', resolve);
    upstream.end(data);
  });
  return true;
}
