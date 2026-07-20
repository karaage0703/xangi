import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDoctorChecks, doctorCmd } from '../src/cli/doctor-cmd.js';

const originalPlatform = process.platform;
const originalArch = process.arch;
const originalPath = process.env.PATH;
const originalPm2Log = process.env.PM2_LOG;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  Object.defineProperty(process, 'arch', { value: originalArch });
  process.env.PATH = originalPath;
  if (originalPm2Log === undefined) delete process.env.PM2_LOG;
  else process.env.PM2_LOG = originalPm2Log;
});

describe('collectDoctorChecks', () => {
  it('reports unsupported platforms without making network requests', async () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd' });
    const fetchImpl = vi.fn<typeof fetch>();
    const checks = await collectDoctorChecks({ fetchImpl });
    expect(checks).toEqual([expect.objectContaining({ name: 'platform', level: 'error' })]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports private config and healthy local service without exposing config values', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    const homeDir = join(tmpdir(), `xangi-doctor-${process.pid}-${Date.now()}`);
    const configPath = join(homeDir, 'config.json');
    await mkdir(homeDir, { recursive: true });
    const workspacePath = join(homeDir, 'workspace');
    await mkdir(workspacePath);
    const binPath = join(homeDir, 'bin');
    await mkdir(binPath);
    await writeFile(join(binPath, 'codex'), 'do-not-print', { mode: 0o700 });
    await writeFile(
      configPath,
      JSON.stringify({ backend: 'codex', workspacePath, webChatEnabled: true })
    );
    await chmod(configPath, 0o600);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      return url.endsWith('/api/sessions')
        ? new Response(JSON.stringify({ meta: { workdir: workspacePath } }), { status: 200 })
        : new Response('{}', { status: 200 });
    });
    const checks = await collectDoctorChecks({
      homeDir,
      configPath,
      pathEnv: binPath,
      serviceCheck: async () => ({ name: 'service', level: 'ok', detail: 'running' }),
      fetchImpl,
    });
    expect(checks).toContainEqual(expect.objectContaining({ name: 'config', level: 'ok' }));
    expect(checks).toContainEqual(expect.objectContaining({ name: 'health', level: 'ok' }));
    expect(checks).toContainEqual(expect.objectContaining({ name: 'backend', level: 'ok' }));
    expect(checks).toContainEqual(expect.objectContaining({ name: 'service', level: 'ok' }));
    expect(checks).toContainEqual(
      expect.objectContaining({ name: 'runtime-workspace', level: 'ok' })
    );
    expect(JSON.stringify(checks)).not.toContain('do-not-print');
  });

  it('fails when Web Chat is running with a different workspace', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    const homeDir = join(tmpdir(), `xangi-doctor-mismatch-${process.pid}-${Date.now()}`);
    const configPath = join(homeDir, 'config.json');
    const workspacePath = join(homeDir, 'workspace');
    const otherWorkspace = join(homeDir, 'checkout');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(otherWorkspace, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ backend: 'codex', workspacePath, webChatEnabled: true })
    );
    await chmod(configPath, 0o600);

    const checks = await collectDoctorChecks({
      homeDir,
      configPath,
      pathEnv: '',
      serviceCheck: async () => ({ name: 'service', level: 'ok', detail: 'running' }),
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) =>
          String(input).endsWith('/api/sessions')
            ? new Response(JSON.stringify({ meta: { workdir: otherWorkspace } }), { status: 200 })
            : new Response('{}', { status: 200 })
        ),
    });

    expect(checks).toContainEqual({
      name: 'runtime-workspace',
      level: 'error',
      detail: 'running service uses a different workspace',
    });

    await expect(
      doctorCmd({
        homeDir,
        configPath,
        pathEnv: '',
        serviceCheck: async () => ({ name: 'service', level: 'ok', detail: 'running' }),
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockImplementation(async (input) =>
            String(input).endsWith('/api/sessions')
              ? new Response(JSON.stringify({ meta: { workdir: otherWorkspace } }), { status: 200 })
              : new Response('{}', { status: 200 })
          ),
      })
    ).rejects.toThrow('ERROR runtime-workspace');
  });

  it('uses the checkout Web Chat port from .env', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    const homeDir = join(tmpdir(), `xangi-doctor-port-${process.pid}-${Date.now()}`);
    const checkoutDir = join(homeDir, 'checkout');
    await mkdir(checkoutDir, { recursive: true });
    await writeFile(join(checkoutDir, '.env'), 'WEB_CHAT_PORT=19991\n');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));

    await collectDoctorChecks({
      homeDir,
      checkoutDir,
      serviceCheck: async () => ({ name: 'service', level: 'ok', detail: 'running' }),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:19991/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('verifies the selected Tailscale Serve forwarding port', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    const homeDir = join(tmpdir(), `xangi-doctor-tailscale-${process.pid}-${Date.now()}`);
    const configPath = join(homeDir, 'config.json');
    const workspacePath = join(homeDir, 'workspace');
    const binPath = join(homeDir, 'bin');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(binPath);
    await writeFile(join(binPath, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(
      configPath,
      JSON.stringify({
        backend: 'codex',
        workspacePath,
        webChatEnabled: true,
        webChatAccess: 'tailscale',
      })
    );
    await chmod(configPath, 0o600);
    const tailscaleServeCheck = vi.fn(async (port: number) => ({
      name: 'tailscale-serve',
      level: 'ok' as const,
      detail: `port ${port}`,
    }));

    const checks = await collectDoctorChecks({
      homeDir,
      configPath,
      pathEnv: binPath,
      serviceCheck: async () => ({ name: 'service', level: 'ok', detail: 'running' }),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 })),
      tailscaleServeCheck,
    });

    expect(tailscaleServeCheck).toHaveBeenCalledWith(18888);
    expect(checks).toContainEqual({
      name: 'tailscale-serve',
      level: 'ok',
      detail: 'port 18888',
    });
  });

  it('checks checkout PM2 instead of LaunchAgent on macOS', async () => {
    const homeDir = join(tmpdir(), `xangi-doctor-pm2-${process.pid}-${Date.now()}`);
    const checkoutDir = join(homeDir, 'checkout');
    const binDir = join(homeDir, 'bin');
    const logPath = join(homeDir, 'commands.log');
    await mkdir(checkoutDir, { recursive: true });
    await mkdir(binDir);
    await writeFile(join(checkoutDir, 'package.json'), '{}\n');
    await writeFile(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(
      join(binDir, 'pm2'),
      '#!/bin/sh\nprintf "pm2:%s\\n" "$*" >> "$PM2_LOG"\nexit 0\n',
      { mode: 0o700 }
    );
    await writeFile(
      join(binDir, 'launchctl'),
      '#!/bin/sh\nprintf "launchctl:%s\\n" "$*" >> "$PM2_LOG"\nexit 1\n',
      { mode: 0o700 }
    );
    process.env.PATH = binDir;
    process.env.PM2_LOG = logPath;

    const checks = await collectDoctorChecks({
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      checkoutDir,
      pathEnv: binDir,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 })),
    });

    expect(checks).toContainEqual({
      name: 'service',
      level: 'ok',
      detail: 'checkout PM2 service is running',
    });
    const commandLog = await readFile(logPath, 'utf8');
    expect(commandLog).toContain(`pm2:describe ${checkoutDir.split('/').at(-1)}`);
    expect(commandLog).not.toContain('launchctl:');
  });
});
