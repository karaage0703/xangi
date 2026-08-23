import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import { processManager } from '../src/process-manager.js';

describe('processManager', () => {
  beforeEach(async () => {
    // 全プロセスを停止
    await processManager.stopAllAndWait();
  });

  it('should return false when stopping non-existent process', () => {
    const result = processManager.stop('non-existent-channel');
    expect(result).toBe(false);
  });

  it('should return false for isRunning on non-existent channel', () => {
    const result = processManager.isRunning('non-existent-channel');
    expect(result).toBe(false);
  });

  it('should register and track a process', () => {
    const proc = spawn('sleep', ['10']);
    processManager.register('test-channel', proc);

    expect(processManager.isRunning('test-channel')).toBe(true);

    // クリーンアップ
    processManager.stop('test-channel');
  });

  it('should stop a registered process and wait for exit', async () => {
    const proc = spawn('sleep', ['10']);
    processManager.register('test-channel', proc);

    const result = await processManager.stopAndWait('test-channel');
    expect(result).toBe(true);
    expect(processManager.isRunning('test-channel')).toBe(false);
  });

  it('should keep tracking a process until it actually exits', async () => {
    const proc = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100)); console.log('ready'); setInterval(()=>{},1000)",
    ]);
    await new Promise<void>((resolve) => proc.stdout?.once('data', () => resolve()));
    processManager.register('delayed-channel', proc);

    const stopping = processManager.stopAndWait('delayed-channel');
    expect(processManager.isRunning('delayed-channel')).toBe(true);

    await stopping;
    expect(processManager.isRunning('delayed-channel')).toBe(false);
  });

  it('should not replace a process that is still exiting', async () => {
    const first = spawn('sleep', ['10']);
    const replacement = spawn('sleep', ['10']);
    processManager.register('owned-channel', first);

    expect(() => processManager.register('owned-channel', replacement)).toThrow(
      'Process is still running for channel owned-channel'
    );
    expect(processManager.isRunning('owned-channel')).toBe(true);

    if (replacement.exitCode === null) {
      await new Promise<void>((resolve) => replacement.once('close', () => resolve()));
    }
    await processManager.stopAndWait('owned-channel');
  });

  it('should stop all processes', async () => {
    const proc1 = spawn('sleep', ['10']);
    const proc2 = spawn('sleep', ['10']);

    processManager.register('channel-1', proc1);
    processManager.register('channel-2', proc2);

    await processManager.stopAllAndWait();

    expect(processManager.isRunning('channel-1')).toBe(false);
    expect(processManager.isRunning('channel-2')).toBe(false);
  });
});
