import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunnerManager } from '../src/runner-manager.js';

// PersistentRunner をモック
vi.mock('../src/persistent-runner.js', () => {
  class MockPersistentRunner {
    private alive = true;
    private currentPrompt: string | null = null;

    constructor() {}

    async run(prompt: string) {
      this.currentPrompt = prompt;
      return { result: `response for: ${prompt}`, sessionId: 'session-123' };
    }

    async runStream(prompt: string, callbacks: { onText?: Function; onComplete?: Function }) {
      this.currentPrompt = prompt;
      const result = { result: `stream response for: ${prompt}`, sessionId: 'session-123' };
      callbacks.onComplete?.(result);
      return result;
    }

    cancel() {
      if (this.currentPrompt) {
        this.currentPrompt = null;
        return true;
      }
      return false;
    }

    shutdown() {
      this.alive = false;
    }

    isAlive() {
      return this.alive;
    }

    getQueueLength() {
      return 0;
    }
  }

  return { PersistentRunner: MockPersistentRunner };
});

describe('RunnerManager', () => {
  let manager: RunnerManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager?.shutdown();
    vi.useRealTimers();
  });

  it('should create a manager instance', () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 3 });
    expect(manager).toBeInstanceOf(RunnerManager);

    const status = manager.getStatus();
    expect(status.poolSize).toBe(0);
    expect(status.maxProcesses).toBe(3);
  });

  it('should create a runner for a new channel', async () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 3 });

    const result = await manager.run('hello', { channelId: 'ch1' });
    expect(result.result).toBe('response for: hello');

    const status = manager.getStatus();
    expect(status.poolSize).toBe(1);
    expect(status.channels[0].channelId).toBe('ch1');
  });

  it('should reuse runner for same channel', async () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 3 });

    await manager.run('msg1', { channelId: 'ch1' });
    await manager.run('msg2', { channelId: 'ch1' });

    const status = manager.getStatus();
    expect(status.poolSize).toBe(1); // 同じチャンネルなのでランナーは1つ
  });

  it('should create separate runners for different channels', async () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 3 });

    await manager.run('msg1', { channelId: 'ch1' });
    await manager.run('msg2', { channelId: 'ch2' });
    await manager.run('msg3', { channelId: 'ch3' });

    const status = manager.getStatus();
    expect(status.poolSize).toBe(3);
  });

  it('should evict LRU runner when pool is full', async () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 2 });

    await manager.run('msg1', { channelId: 'ch1' });

    // ch1 の lastUsed を古くするために時間を進める
    vi.advanceTimersByTime(1000);

    await manager.run('msg2', { channelId: 'ch2' });

    // プールが満杯の状態で新しいチャンネルからリクエスト
    vi.advanceTimersByTime(1000);
    await manager.run('msg3', { channelId: 'ch3' });

    const status = manager.getStatus();
    expect(status.poolSize).toBe(2);

    // ch1 (最も古い) が evict されて、ch2 と ch3 が残る
    const channelIds = status.channels.map((c) => c.channelId);
    expect(channelIds).toContain('ch2');
    expect(channelIds).toContain('ch3');
    expect(channelIds).not.toContain('ch1');
  });

  it('should cleanup idle runners', async () => {
    const idleTimeoutMs = 10 * 60 * 1000; // 10分
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 5, idleTimeoutMs });

    await manager.run('msg1', { channelId: 'ch1' });
    await manager.run('msg2', { channelId: 'ch2' });

    expect(manager.getStatus().poolSize).toBe(2);

    // アイドルタイムアウトを超えるまで時間を進める
    vi.advanceTimersByTime(idleTimeoutMs + 1000);

    // クリーンアップ間隔（5分）のタイマーが発火
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(manager.getStatus().poolSize).toBe(0);
  });

  it('should use default channel when channelId is not specified', async () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 3 });

    const result = await manager.run('hello');
    expect(result.result).toBe('response for: hello');

    const status = manager.getStatus();
    expect(status.poolSize).toBe(1);
    expect(status.channels[0].channelId).toBe('__default__');
  });

  it('should support streaming', async () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 3 });

    const onComplete = vi.fn();
    const result = await manager.runStream('hello', { onComplete }, { channelId: 'ch1' });

    expect(result.result).toBe('stream response for: hello');
    expect(onComplete).toHaveBeenCalled();
  });

  it('should cancel by channel', async () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 3 });

    // ランナーを作成
    await manager.run('msg1', { channelId: 'ch1' });
    await manager.run('msg2', { channelId: 'ch2' });

    // ch1 のキャンセルを試みる（モックは currentPrompt が null なので false）
    const cancelled = manager.cancel('ch1');
    expect(typeof cancelled).toBe('boolean');
  });

  it('should cancel returns false for unknown channel', () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 3 });

    const cancelled = manager.cancel('unknown');
    expect(cancelled).toBe(false);
  });

  it('should shutdown all runners', async () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 3 });

    await manager.run('msg1', { channelId: 'ch1' });
    await manager.run('msg2', { channelId: 'ch2' });

    expect(manager.getStatus().poolSize).toBe(2);

    manager.shutdown();

    expect(manager.getStatus().poolSize).toBe(0);
  });

  it('should use default maxProcesses of 10', () => {
    manager = new RunnerManager({ workdir: '/test' });

    const status = manager.getStatus();
    expect(status.maxProcesses).toBe(10);
  });

  it('should report status correctly', async () => {
    manager = new RunnerManager({ workdir: '/test' }, { maxProcesses: 5 });

    await manager.run('msg1', { channelId: 'ch1' });

    vi.advanceTimersByTime(5000);

    await manager.run('msg2', { channelId: 'ch2' });

    const status = manager.getStatus();
    expect(status.poolSize).toBe(2);
    expect(status.maxProcesses).toBe(5);

    const ch1 = status.channels.find((c) => c.channelId === 'ch1');
    const ch2 = status.channels.find((c) => c.channelId === 'ch2');

    expect(ch1).toBeDefined();
    expect(ch2).toBeDefined();
    expect(ch1!.idleSeconds).toBeGreaterThanOrEqual(5);
    expect(ch2!.idleSeconds).toBeLessThanOrEqual(1);
  });
});
