import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'child_process';
import { serviceCmd } from '../src/cli/service-cmd.js';
import { systemCmd } from '../src/cli/system-cmd.js';
import * as restartRelay from '../src/agent-connection-restart.js';

vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  spawnSync: vi.fn(),
}));

let root: string;
let targetPids: string;
let processTable: string;
let inspectionFailed: boolean;
let calls: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service-self-restart-'));
  writeFileSync(
    join(root, '.env'),
    `XANGI_PROCESS_NAME=test\nXANGI_SETUP_CONFIG_PATH=\nXANGI_SETUP_STATE_DIR=\nWORKSPACE_PATH=${root}\nDATA_DIR=${root}/state\n`
  );
  writeFileSync(join(root, 'ecosystem.config.cjs'), 'module.exports = {};');
  targetPids = '9000001\n';
  processTable = `${process.pid} 9000002\n9000002 9000001\n9000001 1\n1 0\n`;
  inspectionFailed = false;
  calls = [];
  vi.mocked(spawnSync).mockImplementation((command, args) => {
    const action = (args as string[])[0];
    calls.push(`${command} ${action}`);
    return {
      pid: 0,
      output: [],
      stderr: '',
      stdout: command === 'ps' ? processTable : action === 'pid' ? targetPids : 'ok',
      status: command === 'ps' && inspectionFailed ? 1 : 0,
      signal: null,
    } as never;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

it.each(['start', 'restart'])('refuses %s before deleting an ancestor app', async (action) => {
  await expect(serviceCmd(action, { dir: root })).rejects.toThrow('ancestor');
  expect(calls).not.toContain('pm2 delete');
  expect(calls).not.toContain('pm2 start');
});

it('refuses replacement of its own process', async () => {
  targetPids = String(process.pid);
  await expect(serviceCmd('restart', { dir: root })).rejects.toThrow('ancestor');
  expect(calls).not.toContain('pm2 delete');
});

it('checks every PID when the PM2 name selects several processes', async () => {
  targetPids = '9000003\n9000001\n';
  await expect(serviceCmd('restart', { dir: root })).rejects.toThrow('ancestor');
  expect(calls).not.toContain('pm2 delete');
});

it('preserves replacement from an independent caller even with dedicated bot env', async () => {
  vi.stubEnv('XANGI_AGENT_CONNECTION_ID', 'dedicated');
  targetPids = '9000003\n';
  await expect(serviceCmd('restart', { dir: root })).resolves.toBe('ok');
  expect(calls.slice(-2)).toEqual(['pm2 delete', 'pm2 start']);
});

it('permits starting a stopped registration', async () => {
  targetPids = '0\n';
  await expect(serviceCmd('start', { dir: root })).resolves.toBe('ok');
  expect(calls).not.toContain('ps -A');
  expect(calls.slice(-2)).toEqual(['pm2 delete', 'pm2 start']);
});

it.each(['failure', 'missing ancestor', 'cycle', 'malformed pid'])(
  'fails closed on %s without deleting',
  async (reason) => {
    if (reason === 'failure') inspectionFailed = true;
    if (reason === 'missing ancestor') processTable = `${process.pid} 9000002\n`;
    if (reason === 'cycle') processTable = `${process.pid} 9000002\n9000002 ${process.pid}\n`;
    if (reason === 'malformed pid') targetPids = 'not a pid';
    await expect(serviceCmd('restart', { dir: root })).rejects.toThrow();
    expect(calls).not.toContain('pm2 delete');
  }
);

it('delegates a dedicated bot request without restarting the child itself', async () => {
  vi.useFakeTimers();
  vi.stubEnv('XANGI_AGENT_CONNECTION_ID', 'dedicated');
  vi.stubEnv('XANGI_SELF_LIFECYCLE', 'restart-only');
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const relay = vi.spyOn(restartRelay, 'requestParentRestart').mockResolvedValue('parent accepted');
  const result = await systemCmd('system_restart', {});
  expect(result).toBe('親本体からの応答: parent accepted');
  expect(relay).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(150);
  expect(kill).not.toHaveBeenCalled();
});
