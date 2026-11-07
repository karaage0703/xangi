import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
  SlackPendingMessages,
  SLACK_PENDING_SEND,
  SLACK_PENDING_CANCEL,
} from '../src/slack-pending-messages.js';
import { conversationBusy, reserveConversation } from '../src/conversation-locks.js';

const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const queues: SlackPendingMessages[] = [];
afterEach(() => {
  queues.splice(0).forEach((q) => q.reset());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup() {
  const pending = new SlackPendingMessages();
  queues.push(pending);
  let sequence = 0;
  const postMessage = vi.fn().mockImplementation(async () => ({ ts: String(++sequence) }));
  const update = vi.fn().mockResolvedValue({});
  const client = { chat: { postMessage, update } } as unknown as WebClient;
  async function offer(run = vi.fn(async (_release: () => void) => {}), key = 'channel:thread') {
    await pending.offer({
      key,
      channelId: 'channel',
      threadTs: key.split(':')[1],
      ownerId: 'author',
      client,
      run,
    });
    const payload = postMessage.mock.calls.at(-1)![0];
    const id = payload.blocks[1].elements[0].value;
    const messageTs = String(sequence);
    const click = (action = SLACK_PENDING_SEND, userId = 'author') => ({
      id,
      action,
      userId,
      channelId: 'channel',
      messageTs,
      allowed: true,
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });
    return { run, id, messageTs, click, payload };
  }
  return { pending, offer, postMessage, update };
}

describe('Slack pending messages', () => {
  it('requires opt-in and processes multiple reservations in click order with individual cancellation', async () => {
    const { pending, offer, update } = setup();
    const release = reserveConversation('channel:thread')!;
    try {
      const order: number[] = [];
      const a = await offer(
        vi.fn(async () => {
          order.push(1);
        })
      );
      const b = await offer(
        vi.fn(async () => {
          order.push(2);
        })
      );
      const c = await offer(
        vi.fn(async () => {
          order.push(3);
        })
      );
      expect(a.payload.thread_ts).toBe('thread');
      expect(
        a.payload.blocks[1].elements.map((b: { text: { text: string } }) => b.text.text)
      ).toEqual(['完了後に送信']);
      expect(a.payload.blocks[1].elements[0].value).not.toContain('author');
      await pending.handle(b.click());
      await pending.handle(a.click());
      expect(
        update.mock.calls
          .at(-1)![0]
          .blocks[1].elements.map((button: { text: { text: string } }) => button.text.text)
      ).toEqual(['予約をキャンセル']);
      await pending.handle(c.click());
      await pending.handle(a.click(SLACK_PENDING_CANCEL));
      expect(order).toEqual([]);
      expect(pending.isBusy('channel', true)).toBe(true);
      release();
      await flush();
      expect(order).toEqual([2, 3]);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          ts: a.messageTs,
          text: '送信予約をキャンセルしました。',
          blocks: [],
        })
      );
      expect(pending.isBusy('channel:thread')).toBe(false);
    } finally {
      release();
    }
  });

  it('denies other users, unauthorized users and mismatched message/channel IDs without altering the receipt', async () => {
    const { pending, offer, update } = setup();
    const post = await offer();
    for (const click of [
      post.click(SLACK_PENDING_SEND, 'stranger'),
      { ...post.click(), allowed: false },
      { ...post.click(), messageTs: 'forged' },
      { ...post.click(), channelId: 'other' },
    ]) {
      await pending.handle(click);
      expect(click.respond).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'ephemeral', replace_original: false })
      );
    }
    expect(post.run).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    await pending.handle(post.click(SLACK_PENDING_CANCEL));
    await pending.handle(post.click());
    expect(post.run).not.toHaveBeenCalled();
  });

  it('reserves FIFO position before a slow acknowledgement and deduplicates repeated clicks', async () => {
    const { pending, offer } = setup();
    const ack = deferred();
    const order: number[] = [];
    const first = await offer(
      vi.fn(async () => {
        order.push(1);
      })
    );
    const next = await offer(
      vi.fn(async () => {
        order.push(2);
      })
    );
    const click = first.click();
    click.ack.mockReturnValue(ack.promise);
    const handling = pending.handle(click);
    await pending.handle(next.click());
    await pending.handle(first.click());
    expect(order).toEqual([]);
    ack.resolve();
    await handling;
    await flush();
    expect(order).toEqual([1, 2]);
  });

  it('holds the external conversation lock during execution and isolates threads', async () => {
    const { pending, offer } = setup();
    const block = deferred();
    const first = await offer(
      vi.fn(async () => {
        expect(conversationBusy('channel:one')).toBe(true);
        await block.promise;
      }),
      'channel:one'
    );
    const next = await offer(undefined, 'channel:two');
    await pending.handle(first.click());
    await pending.handle(next.click());
    await flush();
    expect(first.run).toHaveBeenCalledOnce();
    expect(next.run).toHaveBeenCalledOnce();
    expect(reserveConversation('channel:one')).toBeUndefined();
    const cancel = first.click(SLACK_PENDING_CANCEL);
    await pending.handle(cancel);
    expect(cancel.respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Stop') })
    );
    block.resolve();
    await flush();
    expect(conversationBusy('channel:one')).toBe(false);
  });

  it('starts immediately when idle and does not let late receipt updates overwrite completion', async () => {
    const { pending, offer, update } = setup();
    const edit = deferred();
    update.mockImplementationOnce(() => edit.promise);
    const post = await offer();
    const handling = pending.handle(post.click());
    await flush();
    expect(post.run).not.toHaveBeenCalled();
    edit.resolve();
    await handling;
    await flush();
    expect(post.run).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '✅ 予約した投稿の処理が終了しました。', blocks: [] })
    );
  });

  it('expires only unselected offers and treats stale buttons as expired', async () => {
    vi.useFakeTimers();
    const { pending, offer } = setup();
    const release = reserveConversation('channel:thread')!;
    try {
      const expired = await offer();
      const queued = await offer();
      await pending.handle(queued.click());
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      const stale = expired.click();
      await pending.handle(stale);
      expect(stale.respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('失効') })
      );
      release();
      await flush();
      expect(expired.run).not.toHaveBeenCalled();
      expect(queued.run).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });

  it('does not execute a failed acknowledgement and continues after run/update failures without retries', async () => {
    const { pending, offer, update } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = reserveConversation('channel:thread')!;
    try {
      const rejected = await offer();
      const failed = await offer(
        vi.fn(async () => {
          throw new Error('runner failed');
        })
      );
      const next = await offer();
      const click = rejected.click();
      click.ack.mockRejectedValue(new Error('ack failed'));
      await pending.handle(click);
      await pending.handle(failed.click());
      await pending.handle(next.click());
      update.mockRejectedValueOnce(new Error('edit failed'));
      release();
      await flush();
      expect(rejected.run).not.toHaveBeenCalled();
      expect(failed.run).toHaveBeenCalledOnce();
      expect(next.run).toHaveBeenCalledOnce();
      expect(conversationBusy('channel:thread')).toBe(false);
    } finally {
      release();
    }
  });
});
