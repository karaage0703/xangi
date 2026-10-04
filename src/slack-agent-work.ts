import type { WebClient } from '@slack/web-api';
import { registerWorkTransport, type WorkThread } from './agent-work.js';
import { splitDiscordMessage } from './message-split.js';
import { getActivity } from './activity-store.js';
import type { createSlackWorkUi } from './slack.js';

export function registerSlackAgentWork(
  client: WebClient,
  ui: ReturnType<typeof createSlackWorkUi>
) {
  const progressMessages = new Map<string, { ts: string; key: string; text: string }>();
  const histories = new Map<string, { threadId: string; turnId: string }>();
  const previousTurns = new Map<string, string | undefined>();
  const threadTs = (thread: WorkThread) => thread.threadId.slice(thread.channelId.length + 1);
  const send = async (thread: WorkThread, text: string) => {
    const completed = text.startsWith('応答完了') || text.startsWith('作業に失敗しました');
    const completion = completed
      ? ui.completion(
          threadTs(thread),
          histories.get(thread.threadId),
          text.replace(/^(?:応答完了|作業に失敗しました)\n\n/, '')
        )
      : undefined;
    const chunks = splitDiscordMessage(text, 2500);
    for (const [index, chunk] of chunks.entries()) {
      const last = index === chunks.length - 1;
      const response = await client.chat.postMessage({
        channel: thread.channelId,
        thread_ts: threadTs(thread),
        text: chunk,
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
        ...(completion && last && completion.blocks.length
          ? {
              blocks: [
                { type: 'section', text: { type: 'plain_text', text: chunk } },
                ...completion.blocks,
              ],
            }
          : {}),
      });
      if (completion && last && response.ts) completion.bind(thread.channelId, response.ts);
    }
    if (completed) histories.delete(thread.threadId);
  };
  registerWorkTransport('slack', {
    async create(channelId, title, text) {
      const parent = await client.chat.postMessage({
        channel: channelId,
        text: title,
        mrkdwn: false,
      });
      if (!parent.ts) throw new Error('Slack作業スレッドを作成できません');
      const link = await client.chat.getPermalink({ channel: channelId, message_ts: parent.ts });
      const thread = {
        platform: 'slack',
        channelId,
        threadId: `${channelId}:${parent.ts}`,
        url: link.permalink || '',
      };
      await send(thread, text);
      return thread;
    },
    send,
    async begin(thread, key) {
      histories.delete(thread.threadId);
      previousTurns.set(thread.threadId, getActivity(key.replace(/^web-chat:/, 'web:'))?.turnId);
      const response = await client.chat.postMessage({
        channel: thread.channelId,
        thread_ts: threadTs(thread),
        text: '作業中',
        blocks: ui.processing(key, '作業中'),
        mrkdwn: false,
      });
      if (!response.ts) throw new Error('Slack作業メッセージを作成できません');
      progressMessages.set(thread.threadId, { ts: response.ts, key, text: '作業中' });
      ui.track(key, {
        channelId: thread.channelId,
        messageTs: response.ts,
        threadTs: threadTs(thread),
        currentText: '作業中',
      });
    },
    async end(thread, key) {
      const threadId = key.replace(/^web-chat:/, 'web:');
      const activity = getActivity(threadId);
      if (activity && activity.turnId !== previousTurns.get(thread.threadId))
        histories.set(thread.threadId, { threadId, turnId: activity.turnId });
      previousTurns.delete(thread.threadId);
      ui.untrack(key);
      const entry = progressMessages.get(thread.threadId);
      progressMessages.delete(thread.threadId);
      if (entry)
        await client.chat.update({
          channel: thread.channelId,
          ts: entry.ts,
          text: entry.text,
          blocks: [],
        });
    },
    async progress(thread, text) {
      const content = text.slice(-1800);
      const entry = progressMessages.get(thread.threadId);
      if (entry) {
        entry.text = content;
        ui.update(entry.key, content);
        await client.chat.update({
          channel: thread.channelId,
          ts: entry.ts,
          text: content,
          blocks: ui.processing(entry.key, content),
        });
      } else {
        await client.chat.postMessage({
          channel: thread.channelId,
          thread_ts: threadTs(thread),
          text: content,
          mrkdwn: false,
        });
      }
    },
  });
}
