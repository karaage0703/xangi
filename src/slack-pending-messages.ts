import { randomUUID } from 'node:crypto';
import type { KnownBlock, WebClient } from '@slack/web-api';
import { waitForConversation } from './conversation-locks.js';

export const SLACK_PENDING_SEND = 'xangi_pending_send';
export const SLACK_PENDING_CANCEL = 'xangi_pending_cancel';
const OFFER_TTL_MS = 15 * 60_000;

type Entry = {
  id: string;
  key: string;
  channelId: string;
  ownerId: string;
  messageTs: string;
  state: 'offered' | 'queued' | 'running' | 'cancelled';
  client: WebClient;
  run: (release: () => void) => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  updates: Promise<unknown>;
};

function blocks(id: string, text: string, queued: boolean): KnownBlock[] {
  return [
    { type: 'section', text: { type: 'plain_text', text } },
    {
      type: 'actions',
      elements: [
        ...(!queued
          ? [
              {
                type: 'button' as const,
                text: { type: 'plain_text' as const, text: '完了後に送信' },
                action_id: SLACK_PENDING_SEND,
                value: id,
                style: 'primary' as const,
              },
            ]
          : []),
        ...(queued
          ? [
              {
                type: 'button' as const,
                text: { type: 'plain_text' as const, text: '予約をキャンセル' },
                action_id: SLACK_PENDING_CANCEL,
                value: id,
              },
            ]
          : []),
      ],
    },
  ];
}

/** Slack receipts are channel/thread scoped; button values contain no prompt or credentials. */
export class SlackPendingMessages {
  private readonly entries = new Map<string, Entry>();
  private readonly tails = new Map<string, Promise<void>>();

  isBusy(key: string, includeThreads = false): boolean {
    return (
      this.tails.has(key) ||
      (includeThreads && [...this.tails.keys()].some((k) => k.startsWith(`${key}:`)))
    );
  }

  async offer(input: {
    key: string;
    channelId: string;
    threadTs?: string;
    ownerId: string;
    client: WebClient;
    run: Entry['run'];
  }): Promise<void> {
    const id = randomUUID();
    const text =
      '⏳ 現在処理中です。「完了後に送信」で、この投稿を順番に自動送信できます（15分以内に選択）。';
    const posted = await input.client.chat.postMessage({
      channel: input.channelId,
      ...(input.threadTs && { thread_ts: input.threadTs }),
      text,
      blocks: blocks(id, text, false),
    });
    if (!posted.ts) throw new Error('Slackの送信予約メッセージを確認できません');
    const entry: Entry = {
      ...input,
      id,
      messageTs: posted.ts,
      state: 'offered',
      updates: Promise.resolve(),
      timer: setTimeout(() => {
        this.entries.delete(id);
        void this.update(entry, '送信予約の受付期限が切れました。必要なら再投稿してください。');
      }, OFFER_TTL_MS),
    };
    entry.timer.unref();
    this.entries.set(id, entry);
  }

  private update(entry: Entry, text: string, queued = false): Promise<unknown> {
    entry.updates = entry.updates
      .then(() =>
        entry.client.chat.update({
          channel: entry.channelId,
          ts: entry.messageTs,
          text,
          blocks: queued ? blocks(entry.id, text, true) : [],
        })
      )
      .catch((error) => console.error('[slack] Failed to update pending message:', error));
    return entry.updates;
  }

  async handle(input: {
    id: string;
    action: string;
    channelId: string;
    messageTs: string;
    userId: string;
    allowed: boolean;
    ack: () => Promise<unknown>;
    respond: (message: {
      text: string;
      response_type: 'ephemeral';
      replace_original: false;
    }) => Promise<unknown>;
  }): Promise<void> {
    const entry = this.entries.get(input.id);
    const notify = async (text: string) => {
      await input.ack();
      await input.respond({ text, response_type: 'ephemeral', replace_original: false });
    };
    if (!input.allowed || (entry && input.userId !== entry.ownerId)) {
      await notify('投稿した本人だけが操作できます。');
      return;
    }
    if (!entry || entry.channelId !== input.channelId || entry.messageTs !== input.messageTs) {
      await notify(
        'この予約は終了・期限切れ、または再起動により失効しています。必要なら再投稿してください。'
      );
      return;
    }
    if (input.action === SLACK_PENDING_CANCEL) {
      if (entry.state === 'running') {
        await notify('開始済みです。処理の Stop ボタンを使ってください。');
        return;
      }
      entry.state = 'cancelled';
      clearTimeout(entry.timer);
      this.entries.delete(entry.id);
      try {
        await input.ack();
      } finally {
        await this.update(entry, '送信予約をキャンセルしました。');
      }
      return;
    }
    if (input.action !== SLACK_PENDING_SEND || entry.state !== 'offered') {
      await notify('この投稿は既に予約されています。');
      return;
    }
    // Reserve click order before awaiting the Slack acknowledgement.
    entry.state = 'queued';
    clearTimeout(entry.timer);
    const acknowledged = input.ack().then(
      () => true,
      (error) => {
        entry.state = 'cancelled';
        console.error('[slack] Failed to acknowledge pending message:', error);
        return false;
      }
    );
    const previous = this.tails.get(entry.key) ?? Promise.resolve();
    const run = previous
      .then(async () => {
        if (!(await acknowledged)) {
          await this.update(
            entry,
            '送信予約を受け付けられませんでした。必要なら再投稿してください。'
          );
          return;
        }
        if (entry.state !== 'queued') return;
        const release = await waitForConversation(entry.key);
        try {
          if (entry.state !== 'queued') return;
          entry.state = 'running';
          await this.update(entry, '▶ 予約した投稿の処理を開始しました。');
          await entry.run(release);
          await this.update(entry, '✅ 予約した投稿の処理が終了しました。');
        } finally {
          release();
        }
      })
      .catch(async (error) => {
        console.error('[slack] Failed to run pending message:', error);
        await this.update(entry, '送信予約を実行できませんでした。必要なら再投稿してください。');
      })
      .finally(() => this.entries.delete(entry.id));
    this.tails.set(entry.key, run);
    void run.then(() => {
      if (this.tails.get(entry.key) === run) this.tails.delete(entry.key);
    });
    await acknowledged;
    if (entry.state === 'queued')
      await this.update(
        entry,
        '⏳ 送信予約済みです。予約した順に処理します。開始前までキャンセルできます。',
        true
      );
  }

  reset(): void {
    for (const entry of this.entries.values()) {
      entry.state = 'cancelled';
      clearTimeout(entry.timer);
    }
    this.entries.clear();
    this.tails.clear();
  }
}
