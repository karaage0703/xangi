import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import type { DiscordTurnCoordinator } from './turn-coordinator.js';

export const PENDING_MESSAGE_PREFIX = 'xangi_pending:';
const OFFER_TTL_MS = 15 * 60_000;

type PendingMessage = {
  ownerId: string;
  channelId: string;
  key: string;
  state: 'offered' | 'queued' | 'running' | 'cancelled';
  run: () => Promise<unknown>;
  reply: Message;
  expiry: ReturnType<typeof setTimeout>;
  updates: Promise<unknown>;
};

function buttons(queued: boolean) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (!queued) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${PENDING_MESSAGE_PREFIX}send`)
        .setLabel('完了後に送信')
        .setStyle(ButtonStyle.Primary)
    );
  }
  if (queued) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${PENDING_MESSAGE_PREFIX}cancel`)
        .setLabel('予約をキャンセル')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  return [row];
}

/** Explicit opt-in only. Queued closures share the native/Web/scheduler conversation lock. */
export class DiscordPendingMessages {
  private readonly entries = new Map<string, PendingMessage>();

  constructor(private readonly coordinator: DiscordTurnCoordinator) {}

  async offer(input: {
    ownerId: string;
    channelId: string;
    key: string;
    run: () => Promise<unknown>;
    send: (options: Parameters<Message['reply']>[0]) => Promise<Message>;
  }): Promise<void> {
    const reply = await input.send({
      content:
        '⏳ 現在処理中です。「完了後に送信」で、この投稿を順番に自動送信できます（15分以内に選択）。',
      components: buttons(false),
      allowedMentions: { parse: [], repliedUser: false },
    });
    const entry: PendingMessage = {
      ...input,
      reply,
      state: 'offered',
      updates: Promise.resolve(),
      expiry: setTimeout(() => {
        this.entries.delete(reply.id);
        void this.update(entry, '送信予約の受付期限が切れました。必要なら再投稿してください。');
      }, OFFER_TTL_MS),
    };
    entry.expiry.unref();
    this.entries.set(reply.id, entry);
  }

  private update(entry: PendingMessage, content: string, queued = false): Promise<unknown> {
    // Serialize edits so a slow "queued" response cannot overwrite "running" or "cancelled".
    entry.updates = entry.updates
      .then(() => entry.reply.edit({ content, components: queued ? buttons(true) : [] }))
      .catch((error) => console.error('[xangi] Failed to update pending Discord message:', error));
    return entry.updates;
  }

  async handle(interaction: ButtonInteraction, allowed: boolean): Promise<void> {
    const entry = this.entries.get(interaction.message.id);
    if (!allowed || (entry && entry.ownerId !== interaction.user.id)) {
      await interaction.reply({ content: '投稿した本人だけが操作できます。', ephemeral: true });
      return;
    }
    if (!entry || entry.channelId !== interaction.channelId) {
      await interaction.reply({
        content:
          'この予約は終了・期限切れ、または再起動により失効しています。必要なら再投稿してください。',
        ephemeral: true,
      });
      return;
    }
    if (interaction.customId === `${PENDING_MESSAGE_PREFIX}cancel`) {
      if (entry.state === 'running') {
        await interaction.reply({
          content: '開始済みです。処理の Stop ボタンを使ってください。',
          ephemeral: true,
        });
        return;
      }
      entry.state = 'cancelled';
      clearTimeout(entry.expiry);
      this.entries.delete(entry.reply.id);
      await interaction.deferUpdate();
      await this.update(entry, '送信予約をキャンセルしました。');
      return;
    }
    if (interaction.customId !== `${PENDING_MESSAGE_PREFIX}send` || entry.state !== 'offered') {
      await interaction.reply({ content: 'この投稿は既に予約されています。', ephemeral: true });
      return;
    }
    // Change state and reserve FIFO position before yielding to Discord's acknowledgement.
    entry.state = 'queued';
    clearTimeout(entry.expiry);
    const acknowledged = interaction.deferUpdate().then(
      () => true,
      (error) => {
        entry.state = 'cancelled';
        console.error('[xangi] Failed to acknowledge pending Discord message:', error);
        return false;
      }
    );
    void this.coordinator
      .enqueue(entry.key, async () => {
        if (!(await acknowledged)) {
          await this.update(
            entry,
            '送信予約を受け付けられませんでした。必要なら再投稿してください。'
          );
          return;
        }
        if (entry.state !== 'queued') return;
        entry.state = 'running';
        await this.update(entry, '▶ 予約した投稿の処理を開始しました。');
        await entry.run();
        await this.update(entry, '✅ 予約した投稿の処理が終了しました。');
      })
      .catch(async (error) => {
        console.error('[xangi] Failed to run pending Discord message:', error);
        await this.update(entry, '送信予約を実行できませんでした。必要なら再投稿してください。');
      })
      .finally(() => this.entries.delete(entry.reply.id));
    await acknowledged;
    if (entry.state === 'queued') {
      await this.update(
        entry,
        '⏳ 送信予約済みです。予約した順に処理します。開始前までキャンセルできます。',
        true
      );
    }
  }
}
