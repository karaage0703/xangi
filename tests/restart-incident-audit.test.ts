import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'child_process';
import { connectionEnvironment } from '../src/agent-connection-runtime.js';
import { systemCmd } from '../src/cli/system-cmd.js';
import { serviceCmd } from '../src/cli/service-cmd.js';
import { loadRuntimeEnvFile } from '../src/env-file.js';
import * as restartRelay from '../src/agent-connection-restart.js';

vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  spawnSync: vi.fn(),
}));
const savedEnv = { ...process.env };
const dirs: string[] = [];
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'restart-audit-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, '.env'),
    `XANGI_PROCESS_NAME=audit\nXANGI_SETUP_CONFIG_PATH=\nXANGI_SETUP_STATE_DIR=\nDATA_DIR=${dir}/state\nWORKSPACE_PATH=${dir}\n`
  );
  writeFileSync(join(dir, 'ecosystem.config.cjs'), 'module.exports = {};');
  return dir;
}

it('parent permission permits restart but dedicated connection overrides it to off', async () => {
  const root = fixture();
  process.env = {
    PATH: savedEnv.PATH,
    WORKSPACE_PATH: root,
    DATA_DIR: join(root, 'state'),
    XANGI_SELF_LIFECYCLE: 'restart-only',
  };
  vi.useFakeTimers();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(await systemCmd('system_restart', {})).toContain('再起動をリクエスト');
  await vi.advanceTimersByTimeAsync(150);
  expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  kill.mockClear();
  const child = connectionEnvironment(
    {
      id: 'audit',
      agentId: 'audit',
      platform: 'discord',
      name: 'audit',
      botToken: 'fake',
      allowedUsers: '1',
      enabled: true,
      createdAt: '',
      updatedAt: '',
    },
    join(root, 'child-state'),
    root,
    process.env
  );
  expect(child.XANGI_SELF_LIFECYCLE).toBe('off');
  process.env = child;
  const relay = vi.spyOn(restartRelay, 'requestParentRestart').mockResolvedValue('parent accepted');
  expect(await systemCmd('system_restart', {})).toBe('親本体からの応答: parent accepted');
  expect(relay).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(150);
  expect(kill).not.toHaveBeenCalled();
});

it('parent off alone explains rejection without dedicated connection', async () => {
  process.env.XANGI_SELF_LIFECYCLE = 'off';
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(await systemCmd('system_restart', {})).toContain('自己再起動が無効');
  expect(kill).not.toHaveBeenCalled();
});

it('startup env file overrides inherited off, so PM2 metadata alone cannot establish effective permission', async () => {
  const root = fixture();
  const envPath = join(root, 'runtime.env');
  writeFileSync(envPath, 'XANGI_SELF_LIFECYCLE=restart-only\n');
  process.env.XANGI_SELF_LIFECYCLE = 'off';
  process.env.XANGI_ENV_PATH = envPath;
  process.env.WORKSPACE_PATH = root;
  process.env.DATA_DIR = join(root, 'state');
  loadRuntimeEnvFile({ quiet: true });
  expect(process.env.XANGI_SELF_LIFECYCLE).toBe('restart-only');
  vi.useFakeTimers();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(await systemCmd('system_restart', {})).toContain('再起動をリクエスト');
  await vi.advanceTimersByTimeAsync(150);
  expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
});

it.each([null, 1])(
  'delete result status %s prevents subsequent start, matching incident output',
  async (status) => {
    const dir = fixture();
    const calls: string[][] = [];
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      expect(command).toBe('pm2');
      const list = args as string[];
      calls.push(list);
      return {
        pid: 0,
        output: [],
        stderr: '',
        stdout:
          list[0] === 'pid'
            ? '0'
            : list[0] === 'delete'
              ? '[PM2] Applying action deleteProcessId on app [audit]'
              : '',
        status: list[0] === 'delete' ? status : 0,
        signal: list[0] === 'delete' && status === null ? 'SIGTERM' : null,
      } as never;
    });
    await expect(serviceCmd('restart', { dir })).rejects.toThrow('Applying action deleteProcessId');
    expect(calls.map((args) => args[0])).toEqual(['--version', 'describe', 'pid', 'delete']);
  }
);

it('a stopped registration can still be replaced by a caller with lifecycle off', async () => {
  const dir = fixture();
  process.env.XANGI_SELF_LIFECYCLE = 'off';
  process.env.XANGI_AGENT_CONNECTION_ID = 'audit';
  const calls: string[][] = [];
  vi.mocked(spawnSync).mockImplementation((_command, args) => {
    calls.push(args as string[]);
    return {
      pid: 0,
      output: [],
      stderr: '',
      stdout: (args as string[])[0] === 'pid' ? '0' : 'ok',
      status: 0,
      signal: null,
    } as never;
  });
  await expect(serviceCmd('restart', { dir })).resolves.toBe('ok');
  expect(calls.map((args) => args[0])).toEqual(['--version', 'describe', 'pid', 'delete', 'start']);
});
