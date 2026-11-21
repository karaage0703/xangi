import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { AgentConnectionRuntimes } from '../src/agent-connection-runtime.js';
import { AgentConnectionStore, agentConnectionStatus } from '../src/agent-connections.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { ProjectCatalog } from '../src/project-catalog.js';

let root: string;
let runtimes: AgentConnectionRuntimes | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'restart-relay-'));
  vi.stubEnv('XANGI_AGENT_CONNECTION_ID', '');
  vi.stubEnv('WORKSPACE_PATH', root);
  vi.stubEnv('DATA_DIR', join(root, 'state'));
});
afterEach(async () => {
  await runtimes?.stop();
  await new Promise((r) => setTimeout(r, 150));
  runtimes = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  agentConnectionStatus.clear();
  await rm(root, { recursive: true, force: true });
});

it.each(['restart-only', 'off', 'invalid-state'])(
  'dedicated Bot with off delegates to actual parent policy: %s',
  async (policy) => {
    vi.stubEnv('XANGI_SELF_LIFECYCLE', policy === 'off' ? 'off' : 'restart-only');
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const state = join(root, 'state');
    const registry = await WorkspaceRegistry.open({ dataDir: state, defaultWorkspacePath: root });
    const agent = new ProjectCatalog(state).saveAgent({ name: 'test', workspaceId: 'default' });
    await new AgentConnectionStore(state).save(agent.id, {
      name: 'test',
      platform: 'discord',
      botToken: 'fake',
      allowedUsers: '1',
    });
    const worker = join(root, 'worker.mjs');
    const output = join(root, 'result.json');
    const module = pathToFileURL(resolve('src/cli/system-cmd.ts')).href;
    await writeFile(
      worker,
      `
    import { writeFileSync, existsSync } from 'node:fs';
    import { systemCmd } from ${JSON.stringify(module)};
    process.on('SIGTERM', () => process.exit(0));
    process.on('disconnect', () => process.exit(0));
    process.send({ type: 'agent-connection-ready' });
    while (!existsSync(${JSON.stringify(join(root, 'ready'))})) await new Promise(r => setTimeout(r, 10));
    try {
      const result = await systemCmd('system_restart', {});
      writeFileSync(${JSON.stringify(output)}, JSON.stringify({ result, permission: process.env.XANGI_SELF_LIFECYCLE }));
    } catch (error) {
      writeFileSync(${JSON.stringify(output)}, JSON.stringify({ error: String(error) }));
    }
  `
    );
    runtimes = new AgentConnectionRuntimes(state, root, registry, { entry: worker });
    const previous = process.execArgv;
    try {
      process.execArgv = ['--import', createRequire(import.meta.url).resolve('tsx')];
      await runtimes.start();
    } finally {
      process.execArgv = previous;
    }
    if (policy === 'invalid-state') {
      vi.stubEnv('WEB_CHAT_ENABLED', 'true');
      await mkdir(state, { recursive: true });
      const catalog = JSON.parse(await readFile(join(state, 'project-catalog.json'), 'utf8'));
      catalog.projects = [
        {
          id: 'bad',
          name: 'bad',
          prompt: '',
          backend: 'removed-backend',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];
      await writeFile(join(state, 'project-catalog.json'), JSON.stringify(catalog));
    }
    await writeFile(join(root, 'ready'), 'ready');
    let observed: { result?: string; error?: string; permission?: string } | undefined;
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      try {
        observed = JSON.parse(await readFile(output, 'utf8'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    expect(observed).toBeDefined();
    expect(observed?.error).toBeUndefined();
    expect(observed?.permission).toBe('off');
    expect(observed?.result).toContain(
      policy === 'restart-only'
        ? '再起動をリクエスト'
        : policy === 'off'
          ? '自己再起動が無効'
          : '再起動前検証に失敗'
    );
    await new Promise((r) => setTimeout(r, 150));
    if (policy === 'restart-only') expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    else expect(kill).not.toHaveBeenCalled();
  },
  10_000
);
