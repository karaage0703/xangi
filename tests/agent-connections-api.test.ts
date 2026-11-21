import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../src/backend-auth-status.js', () => ({ backendAuthenticationSnapshot: async () => [] }));
import { startWebChat } from '../src/web-chat.js';
import { ProjectCatalog } from '../src/project-catalog.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { initSessions, clearSessions } from '../src/sessions.js';
import { initSettings, clearSettingsCache } from '../src/settings.js';
import type { AgentRunner } from '../src/agent-runner.js';

let root: string, base: string, endpoint: string;
let server: ReturnType<typeof startWebChat>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'connection-api-'));
  const dataDir = join(root, '.xangi');
  vi.stubEnv('WORKSPACE_PATH', root);
  vi.stubEnv('DATA_DIR', dataDir);
  vi.stubEnv('XANGI_EXTENSIONS_FILE', join(dataDir, 'extensions.json'));
  vi.stubEnv('XANGI_CONNECTION_AGENT_ID', '');
  vi.stubEnv('XANGI_AGENT_CONNECTION_ID', '');
  initSessions(dataDir);
  initSettings(dataDir);
  const registry = await WorkspaceRegistry.open({ dataDir, defaultWorkspacePath: root });
  const catalog = new ProjectCatalog(dataDir);
  const agent = catalog.saveAgent({ name: 'Dedicated worker', workspaceId: 'default' });
  server = startWebChat({
    initializeOnly: true,
    agentRunner: {} as AgentRunner,
    workspaceRegistry: registry,
  });
  // The worker bootstrap must initialize Agent services without opening an HTTP port.
  expect(server.listening).toBe(false);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  endpoint = `/api/agents/${encodeURIComponent(agent.id)}/connections`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearSessions();
  clearSettingsCache();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

it.each(['discord', 'slack'])(
  'manages %s credentials from Agent settings without exposing them',
  async (platform) => {
    const response = await fetch(
      base + endpoint,
      json('POST', {
        platform,
        botToken: 'secret-test-bot',
        appToken: 'secret-test-app',
        allowedUsers: platform === 'discord' ? '123' : 'U123',
      })
    );
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(JSON.stringify(created)).not.toContain('secret-test');
    expect(created.applyMode).toBe('restart');
    const listing = await fetch(base + endpoint);
    expect(listing.headers.get('cache-control')).toBe('no-store');
    expect(await listing.json()).toMatchObject({
      connections: [{ id: created.connection.id, name: '' }],
    });
    const update = await fetch(
      `${base}${endpoint}/${created.connection.id}`,
      json('PATCH', { name: 'Changed', botToken: '', appToken: '', enabled: false })
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ connection: { enabled: false, name: 'Changed' } });
    const cleared = await fetch(
      `${base}${endpoint}/${created.connection.id}`,
      json('PATCH', { name: '' })
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ connection: { name: '' } });
    const agentEndpoint = endpoint.replace('/connections', '');
    expect((await fetch(base + agentEndpoint, json('DELETE'))).status).toBe(409);
    expect(
      (await fetch(`${base}${endpoint}/${created.connection.id}`, json('DELETE'))).status
    ).toBe(200);
    expect(await (await fetch(base + endpoint)).json()).toEqual({ connections: [] });
  }
);

it('rejects cross-origin credential changes, unknown owners and invalid credentials', async () => {
  const rejected = await fetch(base + endpoint, {
    ...json('POST', {}),
    headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.invalid' },
  });
  expect(rejected.status).toBe(403);
  expect((await fetch(base + endpoint, json('POST', { platform: 'slack' }))).status).toBe(400);
  expect((await fetch(base + '/api/agents/missing/connections')).status).toBe(404);
  vi.stubEnv('XANGI_AGENT_CONNECTION_ID', 'worker');
  expect((await fetch(base + endpoint)).status).toBe(403);
});
