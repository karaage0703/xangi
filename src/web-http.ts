import { createReadStream, statSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';

const MEBIBYTE = 1024 * 1024;
const DEFAULT_UPLOAD_MAX_BYTES = 64 * MEBIBYTE;

export function acceptsSameHostMutation(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function uploadMaxBytes(value = process.env.WEB_CHAT_UPLOAD_MAX_MB): number {
  const configuredMb = Number(value);
  if (!Number.isSafeInteger(configuredMb) || configuredMb <= 0) {
    return DEFAULT_UPLOAD_MAX_BYTES;
  }
  const configuredBytes = configuredMb * MEBIBYTE;
  return Number.isSafeInteger(configuredBytes) ? configuredBytes : DEFAULT_UPLOAD_MAX_BYTES;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

export function readJsonObjectBody(
  req: IncomingMessage,
  maxChars: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > maxChars) {
        reject(new Error(`Body too large (max ${maxChars} bytes)`));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  mime: string,
  disposition?: string,
  extraHeaders: Record<string, string> = {}
): void {
  const size = statSync(filePath).size;
  const baseHeaders: Record<string, string | number> = {
    'Content-Type': mime,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };
  if (disposition) baseHeaders['Content-Disposition'] = disposition;

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = 0;
    let end = size - 1;
    if (match && size > 0) {
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
      } else if (match[2]) {
        const suffixLength = Number(match[2]);
        start = Math.max(0, size - suffixLength);
      }
    }
    if (
      !match ||
      (!match[1] && !match[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      res.writeHead(416, {
        'Content-Range': `bytes */${size}`,
        'Accept-Ranges': 'bytes',
      });
      res.end();
      return;
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, baseHeaders);
  if (req.method === 'HEAD') res.end();
  else createReadStream(filePath).pipe(res);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  const raw = await readRawBody(req, Number.MAX_SAFE_INTEGER);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw new Error('extension request body is too large');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
