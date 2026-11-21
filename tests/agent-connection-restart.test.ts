import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import {
  attachParentRestartHandler,
  requestParentRestart,
} from '../src/agent-connection-restart.js';

class Endpoint extends EventEmitter {
  connected = true;
  peer?: Endpoint;
  send = vi.fn((message: object, callback: (error: Error | null) => void) => {
    this.peer?.emit('message', message);
    callback(null);
    return true;
  });
}
function pair() {
  const parent = new Endpoint();
  const child = new Endpoint();
  parent.peer = child;
  child.peer = parent;
  return { parent, child };
}
afterEach(() => vi.useRealTimers());

it('relays to the bound parent and returns its acceptance without leaking listeners', async () => {
  const { parent, child } = pair();
  const restart = vi.fn(async () => 'accepted, not completed');
  attachParentRestartHandler(parent as unknown as ChildProcess, restart, () => false);
  expect(await requestParentRestart(child)).toBe('accepted, not completed');
  expect(restart).toHaveBeenCalledTimes(1);
  expect(child.listenerCount('message')).toBe(0);
  expect(child.listenerCount('disconnect')).toBe(0);
});

it.each(['permission denied', 'invalid state'])(
  'returns parent %s without a fallback',
  async (reason) => {
    const { parent, child } = pair();
    const restart = vi.fn(async () => {
      if (reason === 'invalid state') throw new Error('private state path');
      return 'permission denied';
    });
    attachParentRestartHandler(parent as unknown as ChildProcess, restart, () => false);
    const result = await requestParentRestart(child);
    expect(result).toContain(
      reason === 'invalid state' ? '再起動前検証に失敗' : 'permission denied'
    );
    expect(result).not.toContain('private state path');
    expect(restart).toHaveBeenCalledTimes(1);
  }
);

it('does not execute requests while the parent is shutting down', async () => {
  const { parent, child } = pair();
  const restart = vi.fn();
  attachParentRestartHandler(parent as unknown as ChildProcess, restart, () => true);
  expect(await requestParentRestart(child)).toContain('終了処理中');
  expect(restart).not.toHaveBeenCalled();
});

it('does not execute duplicate IDs or unrelated malformed IPC', async () => {
  const { parent } = pair();
  const restart = vi.fn(async () => 'accepted');
  attachParentRestartHandler(parent as unknown as ChildProcess, restart, () => false);
  parent.emit('message', { type: 'another-command', requestId: 'wrong' });
  parent.emit('message', { type: 'agent-connection-parent-restart', requestId: 5 });
  const request = {
    type: 'agent-connection-parent-restart',
    requestId: '00000000-0000-0000-0000-000000000001',
  };
  parent.emit('message', request);
  parent.emit('message', request);
  await Promise.resolve();
  await Promise.resolve();
  expect(restart).toHaveBeenCalledTimes(1);
  parent.emit('close');
  expect(parent.listenerCount('message')).toBe(0);
});

it('refuses a missing IPC connection without sending anything', async () => {
  const child = new Endpoint();
  child.connected = false;
  await expect(requestParentRestart(child)).rejects.toThrow('送信していません');
  expect(child.send).not.toHaveBeenCalled();
});

it('does not restart if the child disconnects before the queued request executes', async () => {
  const { parent } = pair();
  const restart = vi.fn(async () => 'accepted');
  attachParentRestartHandler(parent as unknown as ChildProcess, restart, () => false);
  parent.emit('message', {
    type: 'agent-connection-parent-restart',
    requestId: '00000000-0000-0000-0000-000000000002',
  });
  parent.connected = false;
  await Promise.resolve();
  expect(restart).not.toHaveBeenCalled();
});

it('does not retry an accepted restart when replying to the child throws', async () => {
  const { parent } = pair();
  parent.send.mockImplementation(() => {
    throw new Error('closed');
  });
  const restart = vi.fn(async () => 'accepted');
  attachParentRestartHandler(parent as unknown as ChildProcess, restart, () => false);
  const request = {
    type: 'agent-connection-parent-restart',
    requestId: '00000000-0000-0000-0000-000000000003',
  };
  parent.emit('message', request);
  await new Promise((resolve) => setImmediate(resolve));
  parent.emit('message', request);
  await new Promise((resolve) => setImmediate(resolve));
  expect(restart).toHaveBeenCalledTimes(1);
});

it.each(['timeout', 'disconnect', 'callback error', 'throw'])(
  'reports unknown outcome on %s without retrying',
  async (failure) => {
    vi.useFakeTimers();
    const child = new Endpoint();
    if (failure === 'callback error')
      child.send.mockImplementation((_message, cb) => {
        cb(new Error('closed'));
        return false;
      });
    if (failure === 'throw')
      child.send.mockImplementation(() => {
        throw new Error('closed');
      });
    const pending = expect(requestParentRestart(child, 100)).rejects.toThrow('再実行しない');
    if (failure === 'disconnect') child.emit('disconnect');
    if (failure === 'timeout') {
      child.emit('message', {
        type: 'agent-connection-parent-restart-result',
        requestId: 'unrelated',
        result: 'wrong',
      });
      await vi.advanceTimersByTimeAsync(101);
    }
    await pending;
    expect(child.send).toHaveBeenCalledTimes(1);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('disconnect')).toBe(0);
  }
);
