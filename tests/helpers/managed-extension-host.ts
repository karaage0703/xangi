import { createServer } from 'node:http';
import {
  resolveExtensionCapability,
  startAutostartExtensions,
  stopManagedExtensions,
} from '../../src/extensions.js';

const [, , extensionsFile, workspace] = process.argv;
if (!extensionsFile || !workspace) throw new Error('extensions file and workspace are required');
process.env.XANGI_EXTENSIONS_FILE = extensionsFile;

await startAutostartExtensions({ workspace });
const target = resolveExtensionCapability('isolated-search', 'workspace.search');
if (!target) throw new Error('managed extension target is unavailable');

const gateway = createServer(async (request, response) => {
  const upstream = await fetch(`${target.baseUrl}${request.url}`, {
    headers: { Authorization: target.authorization },
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    'Content-Length': String(body.length),
  });
  response.end(body);
});

await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const address = gateway.address();
if (!address || typeof address === 'string') throw new Error('gateway did not bind');
console.log(
  JSON.stringify({
    schemaVersion: 1,
    event: 'ready',
    childBaseUrl: target.baseUrl,
    gatewayBaseUrl: `http://127.0.0.1:${address.port}`,
  })
);

process.stdin.resume();
process.stdin.once('end', async () => {
  await new Promise<void>((resolve, reject) =>
    gateway.close((error) => (error ? reject(error) : resolve()))
  );
  await stopManagedExtensions();
});
