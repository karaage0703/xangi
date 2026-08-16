import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExtensionAction, stopManagedExtensions } from '../../src/extensions.js';

export async function installExtensionBackendFixture(
  id = 'example-backend',
  displayName = 'Example backend'
): Promise<void> {
  await stopManagedExtensions();
  const root = mkdtempSync(join(tmpdir(), 'xangi-extension-backend-'));
  const manifestPath = join(root, 'xangi-extension.json');
  const configPath = join(root, 'extensions.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      id: 'test-extension',
      displayName: 'Test extension',
      version: '1.0.0',
      entrypoint: 'extension-cli',
      runtime: { kind: 'managed-http' },
      capabilities: [
        {
          id: 'test.agent',
          protocol: 'http',
          healthPath: '/health',
        },
      ],
      agentBackend: { id, displayName, capability: 'test.agent', path: '/agent' },
    })
  );
  writeFileSync(
    join(root, 'extension-cli'),
    `#!/usr/bin/env node
import http from 'node:http';
const workspace = process.argv[process.argv.indexOf('--workspace') + 1];
const token = process.env.XANGI_EXTENSION_AUTH_TOKEN;
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== \`Bearer \${token}\`) {
    response.writeHead(401).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(request.url === '/agent' ? { schemaVersion: 1, result: 'ok' } : { service: 'test-extension' }));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ schemaVersion: 2, event: 'ready', id: 'test-extension', baseUrl: \`http://127.0.0.1:\${address.port}\`, workspace }));
});
process.stdin.resume();
process.stdin.on('end', () => server.close());
`
  );
  chmodSync(join(root, 'extension-cli'), 0o755);
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      extensions: [{ id: 'test-extension', manifestPath, enabled: true, autostart: false }],
    }),
    { mode: 0o600 }
  );
  chmodSync(configPath, 0o600);
  process.env.XANGI_EXTENSIONS_FILE = configPath;
  await runExtensionAction(
    { id: 'test-extension', manifestPath, enabled: true, autostart: false },
    'start',
    { workspace: root }
  );
}
