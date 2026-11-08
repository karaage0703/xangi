import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConversationService, DeliveryUnavailable } from '../src/conversation-service.js';
import { DiscordTurnCoordinator } from '../src/discord/turn-coordinator.js';
import { reserveConversation } from '../src/conversation-locks.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const input = {
  appSessionId: 'session',
  contextKey: 'context',
  requestId: 'request-1234',
  message: '画像を確認',
  attachments: ['/tmp/photo.png'],
};
function setup(options: Partial<ConstructorParameters<typeof ConversationService>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'conversation-service-'));
  directories.push(directory);
  const execute = vi.fn(async () => ({ text: '結果' }));
  const deliver = vi.fn(async () => ['posted']);
  const config = { directory, busy: () => false, changed: () => {}, execute, deliver, ...options };
  return { service: new ConversationService(config), execute, deliver, config, directory };
}

describe('durable conversation receipts', () => {
  it('awaits only the selected completion receipt and preserves its source across restart', async () => {
    let finish!: () => void;
    const { service, config } = setup({
      execute: vi.fn(async (turn) => {
        if (turn.appSessionId === 'other') await new Promise<void>((resolve) => { finish = resolve; });
        return { text: 'result' };
      }),
    });
    service.submit({ ...input, appSessionId: 'other', contextKey: 'other' });
    service.submit({ ...input, source: 'agent-completion' });
    const receipt = await service.settled(input.appSessionId, input.requestId);
    expect(receipt).toMatchObject({ state: 'completed', delivery: 'delivered', source: 'agent-completion' });
    expect(service.lookup('other', input.requestId)?.state).toBe('running');
    finish();
    await service.idle();
    const restored = new ConversationService(config);
    expect(await restored.settled(input.appSessionId, input.requestId)).toMatchObject({ source: 'agent-completion' });
    expect(() => restored.submit(input)).toThrow('異なる入力');
  });

  it('keeps the answering identity and original input across offline delivery and restart', async () => {
    const { service, config, directory } = setup({
      execute: vi.fn(async () => ({ text: '確認しました', assistantName: 'ボルト' })),
      deliver: vi.fn().mockRejectedValue(new DeliveryUnavailable('offline')),
    });
    service.submit(input);
    await service.idle();
    const deliver = vi.fn().mockResolvedValue(['answer', 'input']);
    const restored = new ConversationService({ ...config, directory, deliver });
    await restored.retryDelivery(input.appSessionId, input.requestId);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: input.message,
      attachments: input.attachments,
      assistantName: 'ボルト',
    }));
    expect(config.execute).toHaveBeenCalledTimes(1);
  });

  it('persists acceptance before execution and deduplicates in-flight and completed requests', async () => {
    let finish!: () => void;
    const execute = vi.fn(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finish = () => resolve({ text: '結果' });
        })
    );
    const { service, directory, deliver } = setup({ execute });
    const accepted = service.submit(input);
    expect(accepted.state).toBe('accepted');
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')).state).toBe(
      'accepted'
    );
    expect(service.submit(input).id).toBe(accepted.id);
    expect(() => service.submit({ ...input, requestId: 'request-5678' })).toThrow('処理中');
    expect(() => service.submit({ ...input, message: '違う入力' })).toThrow('異なる入力');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const discord = new DiscordTurnCoordinator();
    expect((await discord.tryRun(input.contextKey, async () => 'native')).accepted).toBe(false);
    finish();
    await service.idle();
    expect(service.submit(input).state).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await discord.tryRun(input.contextKey, async () => 'native')).result).toBe('native');
  });

  it('retries only result delivery after a definite transport outage', async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new DeliveryUnavailable('offline'))
      .mockResolvedValue(['posted']);
    const { service, execute } = setup({ deliver });
    service.submit(input);
    await service.idle();
    expect(service.lookup('session', input.requestId)?.delivery).toBe('failed');
    await service.retryDelivery('session', input.requestId);
    expect(service.lookup('session', input.requestId)?.delivery).toBe('delivered');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('does not blindly retry an external post whose outcome is unknown', async () => {
    const { service, execute } = setup({
      deliver: async () => {
        throw new Error('response lost');
      },
    });
    service.submit(input);
    await service.idle();
    expect(service.lookup('session', input.requestId)?.state).toBe('completed');
    expect(service.lookup('session', input.requestId)?.delivery).toBe('unknown');
    await expect(service.retryDelivery('session', input.requestId)).rejects.toThrow('未確定');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('restores receipts across restart and never replays a running turn', async () => {
    const { service, directory, config, execute } = setup();
    service.submit(input);
    await service.idle();
    const path = join(directory, readdirSync(directory)[0]);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.state = 'running';
    record.delivery = 'sending';
    writeFileSync(path, JSON.stringify(record));
    const restarted = new ConversationService(config);
    restarted.resume();
    await restarted.idle();
    expect(restarted.lookup('session', input.requestId)).toMatchObject({
      state: 'interrupted',
      delivery: 'unknown',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('resumes an accepted but not started receipt', async () => {
    const { service, directory, config, execute } = setup();
    service.submit(input);
    await service.idle();
    const path = join(directory, readdirSync(directory)[0]);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.state = 'accepted';
    record.delivery = 'none';
    writeFileSync(path, JSON.stringify(record));
    const restarted = new ConversationService(config);
    restarted.resume();
    await restarted.idle();
    expect(restarted.lookup('session', input.requestId)?.state).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('releases admission when receipt persistence fails and rejects a native-held context', async () => {
    const { service, directory, execute } = setup();
    const release = reserveConversation(input.contextKey)!;
    expect(() => service.submit(input)).toThrow('処理中');
    release();
    rmSync(directory, { recursive: true });
    expect(() => service.submit(input)).toThrow();
    expect(execute).not.toHaveBeenCalled();
    const next = reserveConversation(input.contextKey);
    expect(next).toBeTypeOf('function');
    next?.();
  });

  it('cancels accepted work before it starts without restoring or executing the input', async () => {
    const { service, execute, deliver } = setup();
    service.submit(input);
    service.cancel(input.appSessionId);
    await service.idle();
    expect(service.lookup(input.appSessionId, input.requestId)?.state).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('removes durable receipt contents when a completed conversation is deleted', async () => {
    const { service, directory } = setup();
    service.submit(input);
    await service.idle();
    service.forget(input.appSessionId);
    expect(service.lookup(input.appSessionId, input.requestId)).toBeUndefined();
    expect(readdirSync(directory)).toHaveLength(0);
  });

  it('resumes pending result delivery after restart without running the AI again', async () => {
    const { service, directory, config, execute, deliver } = setup();
    service.submit(input);
    await service.idle();
    const path = join(directory, readdirSync(directory)[0]);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.delivery = 'pending';
    writeFileSync(path, JSON.stringify(record));
    const restarted = new ConversationService(config);
    restarted.resume();
    await restarted.idle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(restarted.lookup(input.appSessionId, input.requestId)?.delivery).toBe('delivered');
  });
});


describe('notification-backed receipt reads', () => {
  it('wakes on durable completion and also handles an already changed receipt', async () => {
    let finish!: (value: { text: string }) => void;
    const { service } = setup({ execute: () => new Promise((resolve) => { finish = resolve; }) });
    service.submit(input);
    await Promise.resolve();
    const running = service.lookup(input.appSessionId, input.requestId)!;
    const after = JSON.stringify([running.state, running.delivery, running.updatedAt]);
    const controller = new AbortController();
    const pending = service.waitForChange(input.appSessionId, input.requestId, after, controller.signal);
    finish({ text: 'finished' });
    expect((await pending)?.state).toBe('completed');
    await service.idle();
    expect((await service.waitForChange(input.appSessionId, input.requestId, after, controller.signal))?.delivery).toBe('delivered');
  });
  it('releases a disconnected wait without cancelling execution', async () => {
    let finish!: (value: { text: string }) => void;
    const { service } = setup({ execute: () => new Promise((resolve) => { finish = resolve; }) });
    service.submit(input);
    await Promise.resolve();
    const running = service.lookup(input.appSessionId, input.requestId)!;
    const controller = new AbortController();
    const pending = service.waitForChange(input.appSessionId, input.requestId, JSON.stringify([running.state, running.delivery, running.updatedAt]), controller.signal);
    controller.abort();
    expect((await pending)?.state).toBe('running');
    finish({ text: 'finished' });
    await service.idle();
    expect(service.lookup(input.appSessionId, input.requestId)?.state).toBe('completed');
  });
});
