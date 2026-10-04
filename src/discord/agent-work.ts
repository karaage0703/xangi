import { getActivity } from '../activity-store.js';
import type { Config } from '../config.js';
import type { AgentRunner } from '../agent-runner.js';
import {
  prepareDiscordCompletion,
  type DiscordHistoryContext,
  createProcessingButtons,
  getDiscordTimeoutInfoFor,
  discordProcessingMessages,
} from './ui.js';
import type { Client, Message } from 'discord.js';
import { registerWorkTransport, type WorkThread } from '../agent-work.js';
import { splitDiscordMessage } from '../message-split.js';
import { DISCORD_SAFE_LENGTH } from '../constants.js';

export function registerDiscordAgentWork(
  client: Client,
  runner?: AgentRunner,
  config: Partial<Config['discord']> = { toolHistoryMode: 'button' }
) {
  const histories = new Map<string, DiscordHistoryContext>();
  const previousTurns = new Map<string, string | undefined>();
  const progressMessages = new Map<string, Message>();
  const channelFor = async (id: string) => {
    const channel = await client.channels.fetch(id);
    if (!channel?.isTextBased() || !('send' in channel))
      throw new Error('作業チャンネルに送信できません');
    return channel;
  };
  const send = async (thread: WorkThread, text: string) => {
    const channel = await channelFor(thread.threadId);
    const chunks = splitDiscordMessage(text, DISCORD_SAFE_LENGTH);
    const completed = text.startsWith('応答完了') || text.startsWith('作業に失敗しました');
    const completion = completed
      ? prepareDiscordCompletion({
          historyContext: histories.get(thread.threadId),
          finalResponse: text.replace(/^(?:応答完了|作業に失敗しました)\n\n/, ''),
          historyEnabled:
            (config.toolHistoryMode ?? ((config.showToolUse ?? true) ? 'inline' : 'off')) ===
              'button' &&
            (config.showToolButton ?? true),
          showLeave: true,
        })
      : undefined;
    for (const [index, content] of chunks.entries()) {
      const message = await channel.send({
        content,
        allowedMentions: { parse: [] },
        ...(completion && (config.showButtons ?? true) && index === chunks.length - 1
          ? { components: [completion.buttons] }
          : {}),
      });
      if (completion && (config.showButtons ?? true) && index === chunks.length - 1)
        completion.bind(message.id);
    }
    if (completed) histories.delete(thread.threadId);
  };
  registerWorkTransport('discord', {
    async create(channelId, title, text) {
      const channel = await channelFor(channelId);
      if (channel.isThread() || channel.isDMBased())
        throw new Error('Agentの作業先には通常のサーバーチャンネルを指定してください');
      const starter = await channel.send({
        content:
          text.length <= DISCORD_SAFE_LENGTH
            ? text
            : `${title}\n依頼全文と進捗は作業スレッド内に表示します。`,
        allowedMentions: { parse: [] },
      });
      const thread = await starter.startThread({
        name: title.slice(0, 100),
        autoArchiveDuration: 1440,
      });
      const target = { platform: 'discord', channelId, threadId: thread.id, url: thread.url };
      await send(target, text);
      return target;
    },
    send,
    async begin(thread, contextKey) {
      histories.delete(thread.threadId);
      previousTurns.set(
        thread.threadId,
        getActivity(contextKey.replace(/^web-chat:/, 'web:'))?.turnId
      );
      const channel = await channelFor(thread.threadId);
      const message = await channel.send({
        content: '作業中',
        components: [
          createProcessingButtons(
            runner ? getDiscordTimeoutInfoFor(runner, contextKey) : undefined
          ),
        ],
        allowedMentions: { parse: [] },
      });
      progressMessages.set(thread.threadId, message);
      discordProcessingMessages.set(contextKey, { message });
    },
    async end(thread, contextKey) {
      const threadId = contextKey.replace(/^web-chat:/, 'web:');
      const activity = getActivity(threadId);
      if (activity && activity.turnId !== previousTurns.get(thread.threadId)) {
        histories.set(thread.threadId, { threadId, turnId: activity.turnId });
      }
      previousTurns.delete(thread.threadId);
      const entry = discordProcessingMessages.get(contextKey);
      if (entry?.intervalId) clearInterval(entry.intervalId);
      discordProcessingMessages.delete(contextKey);
      const message = progressMessages.get(thread.threadId);
      if (message) await message.edit({ components: [] });
    },
    async progress(thread, text) {
      const content = text.slice(-1800);
      const message = progressMessages.get(thread.threadId);
      if (message) await message.edit({ content, allowedMentions: { parse: [] } });
      else {
        const channel = await channelFor(thread.threadId);
        progressMessages.set(
          thread.threadId,
          await channel.send({ content, allowedMentions: { parse: [] } })
        );
      }
    },
  });
}
