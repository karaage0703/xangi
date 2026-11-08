import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { serveWebAsset } from '../src/web-assets.js';

it('negotiates compressed assets, validates the selected representation, and refreshes changed files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'web-asset-test-'));
  const path = join(directory, 'asset.js');
  const source = 'const fixture = true;\n'.repeat(100);
  writeFileSync(path, source);
  const server = createServer((req, res) => {
    void serveWebAsset(req, res, path, 'text/javascript').catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/asset`;
  try {
    const raw = await fetch(url, { headers: { 'accept-encoding': 'gzip;q=0' } });
    expect(raw.headers.get('content-encoding')).toBeNull();
    expect(await raw.text()).toBe(source);
    const zipped = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
    expect(zipped.headers.get('content-encoding')).toBe('gzip');
    expect(Number(zipped.headers.get('content-length'))).toBeLessThan(source.length);
    expect(await zipped.text()).toBe(source);
    const etag = zipped.headers.get('etag')!;
    const unchanged = await fetch(url, {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': etag },
    });
    expect(unchanged.status).toBe(304);
    writeFileSync(path, source + '// changed\n');
    const changed = await fetch(url, {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': etag },
    });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toContain('// changed');
    expect(changed.headers.get('etag')).not.toBe(etag);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
