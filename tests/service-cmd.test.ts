import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceCmd } from '../src/cli/service-cmd.js';
import type { ServiceAdapter } from '../src/installer/platform/service.js';

describe('service command', () => {
  it('restarts a managed service through its OS service adapter', async () => {
    let starts = 0;
    let stops = 0;
    const autostarts: boolean[] = [];
    let restarts = 0;
    const service: ServiceAdapter = {
      async install() {},
      async start() {
        starts += 1;
      },
      async stop() {
        stops += 1;
      },
      async autostart(enabled) {
        autostarts.push(enabled);
      },
      async uninstall() {},
      async restart() {
        restarts += 1;
      },
      async status() {
        return { running: true, detail: 'active' };
      },
      async openBrowser() {},
    };

    await expect(
      serviceCmd('start', {}, { installationKind: 'managed', managedService: service })
    ).resolves.toBe('Started xangi service');
    await expect(
      serviceCmd('stop', {}, { installationKind: 'managed', managedService: service })
    ).resolves.toBe('Stopped xangi service');
    await expect(
      serviceCmd('restart', {}, { installationKind: 'managed', managedService: service })
    ).resolves.toBe('Restarted xangi service');
    await expect(
      serviceCmd(
        'autostart',
        {},
        { installationKind: 'managed', managedService: service },
        'enable'
      )
    ).resolves.toBe('Enabled xangi service autostart');
    await expect(
      serviceCmd(
        'autostart',
        {},
        { installationKind: 'managed', managedService: service },
        'disable'
      )
    ).resolves.toBe('Disabled xangi service autostart');
    expect(starts).toBe(1);
    expect(stops).toBe(1);
    expect(autostarts).toEqual([true, false]);
    expect(restarts).toBe(1);
  });

  it('shows the same service actions for managed and checkout installations', async () => {
    const managed = await serviceCmd('help', {}, { installationKind: 'managed' });
    const checkout = await serviceCmd('help', {}, { installationKind: 'checkout' });
    expect(managed).toBe(checkout);
    expect(managed).toContain('autostart <enable|disable>');
  });

  it('requires an explicit autostart operation', async () => {
    await expect(serviceCmd('autostart', {}, { installationKind: 'managed' })).rejects.toThrow(
      'autostart <enable|disable>'
    );
  });

  it('validates persisted state before restarting a managed service', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'xangi-service-state-'));
    const dataDir = join(workspace, '.xangi');
    mkdirSync(dataDir);
    writeFileSync(
      join(dataDir, 'web-projects.json'),
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: 'legacy',
            name: 'Legacy',
            prompt: '',
            backend: 'removed-backend',
            createdAt: '2026-08-12T00:00:00.000Z',
            updatedAt: '2026-08-12T00:00:00.000Z',
          },
        ],
      })
    );
    const originalEnv = { ...process.env };
    let restarts = 0;
    process.env.WEB_CHAT_ENABLED = 'true';
    process.env.WORKSPACE_PATH = workspace;
    process.env.DATA_DIR = dataDir;
    try {
      await expect(
        serviceCmd(
          'restart',
          { dir: workspace },
          {
            installationKind: 'managed',
            managedService: {
              async install() {},
              async start() {},
              async stop() {},
              async autostart() {},
              async uninstall() {},
              async restart() {
                restarts += 1;
              },
              async status() {
                return { running: true };
              },
              async openBrowser() {},
            },
          }
        )
      ).rejects.toThrow('再起動前のstate検証に失敗しました');
      expect(restarts).toBe(0);
    } finally {
      process.env = originalEnv;
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
