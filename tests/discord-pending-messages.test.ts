import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordPendingMessages } from '../src/discord/pending-messages.js';
import { DiscordTurnCoordinator } from '../src/discord/turn-coordinator.js';
import { reserveConversation } from '../src/conversation-locks.js';

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const coordinator = new DiscordTurnCoordinator();
  const pending = new DiscordPendingMessages(coordinator);
  let sequence = 0;
  async function offer(run = vi.fn(async () => {}), key = 'thread') {
    const reply = { id: String(++sequence), edit: vi.fn().mockResolvedValue(undefined) };
    const send = vi.fn().mockResolvedValue(reply);
    await pending.offer({ ownerId: 'author', channelId: key, key, run, send });
    const click = (action: string, user = 'author') => ({
      customId: `xangi_pending:${action}`,
      channelId: key,
      user: { id: user },
      message: reply,
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    });
    return { reply, send, run, click };
  }
  const handle = (click: ReturnType<Awaited<ReturnType<typeof offer>>['click']>, allowed = true) =>
    pending.handle(click as never, allowed);
  return { coordinator, pending, offer, handle };
}
afterEach(() => vi.useRealTimers());

describe('Discord pending messages', () => {
  it('requires opt-in, runs multiple posts in click order and cancels one independently', async () => {
    const { coordinator, offer, handle } = setup();
    const block = deferred();
    const active = coordinator.enqueue('thread', () => block.promise);
    const order: number[] = [];
    const first = await offer(
      vi.fn(async () => {
        order.push(1);
      })
    );
    const second = await offer(
      vi.fn(async () => {
        order.push(2);
      })
    );
    const third = await offer(
      vi.fn(async () => {
        order.push(3);
      })
    );
    expect(
      first.send.mock.calls[0][0].components[0]
        .toJSON()
        .components.map((b: { label: string }) => b.label)
    ).toEqual(['完了後に送信']);
    await handle(second.click('send'));
    await handle(first.click('send'));
    expect(
      first.reply.edit.mock.calls
        .at(-1)![0]
        .components[0].toJSON()
        .components.map((button: { label: string }) => button.label)
    ).toEqual(['予約をキャンセル']);
    await handle(third.click('send'));
    await handle(first.click('cancel'));
    expect(order).toEqual([]);
    block.resolve();
    await active;
    await flush();
    expect(order).toEqual([2, 3]);
    expect(first.reply.edit).toHaveBeenLastCalledWith({
      content: '送信予約をキャンセルしました。',
      components: [],
    });
    expect(coordinator.isBusy('thread')).toBe(false);
  });

  it('prevents double clicks and rejects operations by another or unauthorized user', async () => {
    const { coordinator, offer, handle } = setup();
    const block = deferred();
    const active = coordinator.enqueue('thread', () => block.promise);
    const post = await offer();
    const stranger = post.click('send', 'stranger');
    await handle(stranger);
    expect(stranger.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    const denied = post.click('send');
    await handle(denied, false);
    expect(denied.deferUpdate).not.toHaveBeenCalled();
    await Promise.all([handle(post.click('send')), handle(post.click('send'))]);
    block.resolve();
    await active;
    await flush();
    expect(post.run).toHaveBeenCalledOnce();
    const stale = post.click('send');
    await handle(stale);
    expect(stale.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('失効') })
    );
  });

  it('lets the author dismiss an offer before opting in', async () => {
    const { offer, handle } = setup();
    const post = await offer();
    await handle(post.click('cancel'));
    await handle(post.click('send'));
    expect(post.run).not.toHaveBeenCalled();
  });

  it('runs immediately after the conversation became idle and directs running cancellation to Stop', async () => {
    const { offer, handle } = setup();
    const block = deferred();
    const post = await offer(vi.fn(() => block.promise));
    await handle(post.click('send'));
    await flush();
    expect(post.run).toHaveBeenCalledOnce();
    const cancel = post.click('cancel');
    await handle(cancel);
    expect(cancel.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Stop') })
    );
    block.resolve();
    await flush();
    expect(post.reply.edit).toHaveBeenLastCalledWith({
      content: '✅ 予約した投稿の処理が終了しました。',
      components: [],
    });
  });

  it('honors the shared external lock and keeps separate conversations independent', async () => {
    const { offer, handle } = setup();
    const release = reserveConversation('external')!;
    try {
      const post = await offer(undefined, 'external');
      const other = await offer(undefined, 'other');
      await handle(post.click('send'));
      await handle(other.click('send'));
      await flush();
      expect(post.run).not.toHaveBeenCalled();
      expect(other.run).toHaveBeenCalledOnce();
      await handle(post.click('cancel'));
      release();
      await flush();
      expect(post.run).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('expires unselected offers but keeps selected reservations beyond 15 minutes', async () => {
    vi.useFakeTimers();
    const { coordinator, offer, handle } = setup();
    const block = deferred();
    const active = coordinator.enqueue('thread', () => block.promise);
    const expired = await offer();
    const queued = await offer();
    await handle(queued.click('send'));
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await handle(expired.click('send'));
    expect(expired.run).not.toHaveBeenCalled();
    expect(expired.reply.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining('期限') })
    );
    block.resolve();
    await active;
    await flush();
    expect(queued.run).toHaveBeenCalledOnce();
  });

  it('continues after a failure and does not retry the failed post', async () => {
    const { coordinator, offer, handle } = setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const block = deferred();
    const active = coordinator.enqueue('thread', () => block.promise);
    const failed = await offer(
      vi.fn(async () => {
        throw new Error('run failed');
      })
    );
    const next = await offer();
    await handle(failed.click('send'));
    await handle(next.click('send'));
    block.resolve();
    await active;
    await flush();
    expect(failed.run).toHaveBeenCalledOnce();
    expect(next.run).toHaveBeenCalledOnce();
    expect(failed.reply.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining('実行できません') })
    );
    log.mockRestore();
  });

  it('does not execute when the interaction acknowledgement fails', async () => {
    const { offer, handle } = setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const post = await offer();
    const click = post.click('send');
    click.deferUpdate.mockRejectedValue(new Error('Discord unavailable'));
    await handle(click);
    await flush();
    expect(post.run).not.toHaveBeenCalled();
    expect(post.reply.edit).toHaveBeenLastCalledWith(expect.objectContaining({ components: [] }));
    log.mockRestore();
  });
});
