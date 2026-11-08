import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';

const compress = promisify(gzip);
type Asset = { raw: Buffer; zipped: Buffer; etag: string };
const assets = new Map<string, Promise<Asset>>();

/** Immutable build assets only. Never use this cache for private conversation files. */
export async function serveWebAsset(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  contentType: string
): Promise<void> {
  const info = await stat(path);
  const key = `${path}:${info.mtimeMs}:${info.size}`;
  let pending = assets.get(key);
  if (!pending) {
    if (assets.size >= 32) assets.clear();
    pending = readFile(path).then(async (raw) => ({
      raw,
      zipped: await compress(raw),
      etag: createHash('sha256').update(raw).digest('hex'),
    }));
    assets.set(key, pending);
    void pending.catch(() => assets.delete(key));
  }
  const asset = await pending;
  const compressed = (req.headers['accept-encoding'] || '').split(',').some((entry) => {
    const [encoding, ...params] = entry.trim().split(';');
    const q = params.find((param) => param.trim().startsWith('q='));
    return encoding === 'gzip' && (!q || Number(q.trim().slice(2)) > 0);
  });
  const etag = `"${asset.etag}${compressed ? '-gzip' : ''}"`;
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (
    req.headers['if-none-match']
      ?.split(',')
      .map((value) => value.trim())
      .includes(etag)
  ) {
    res.writeHead(304);
    res.end();
    return;
  }
  const body = compressed ? asset.zipped : asset.raw;
  if (compressed) res.setHeader('Content-Encoding', 'gzip');
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}
