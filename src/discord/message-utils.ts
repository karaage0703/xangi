import type { Client, Message } from 'discord.js';

/** Discordリンクからメッセージ内容を取得してテキストに展開する */
export async function fetchDiscordLinkContent(client: Client, text: string): Promise<string> {
  const linkRegex = /https?:\/\/(?:www\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;
  const matches = [...text.matchAll(linkRegex)];

  if (matches.length === 0) return text;

  let result = text;
  for (const match of matches) {
    const [fullUrl, , channelId, messageId] = match;
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && 'messages' in channel) {
        const fetchedMessage = await channel.messages.fetch(messageId);
        const author = fetchedMessage.author.tag;
        const content = fetchedMessage.content || '(添付ファイルのみ)';
        const attachmentInfo =
          fetchedMessage.attachments.size > 0
            ? `\n[添付: ${fetchedMessage.attachments.map((a) => a.name).join(', ')}]`
            : '';

        const quotedContent = `\n---\n📎 引用メッセージ (${author}):\n${content}${attachmentInfo}\n---\n`;
        result = result.replace(fullUrl, quotedContent);
        console.log(`[xangi] Fetched linked message from channel ${channelId}`);
      }
    } catch (err) {
      console.error(`[xangi] Failed to fetch linked message: ${fullUrl}`, err);
      // 取得失敗時はリンクをそのまま残す
    }
  }

  return result;
}

/** 返信元メッセージを取得してプロンプト用の引用ブロックを返す */
export async function fetchReplyContent(message: Message): Promise<string | null> {
  if (!message.reference?.messageId) return null;

  try {
    const channel = message.channel;
    if (!('messages' in channel)) return null;

    const repliedMessage = await channel.messages.fetch(message.reference.messageId);
    const author = repliedMessage.author.tag;
    const content = repliedMessage.content || '(添付ファイルのみ)';
    const attachmentInfo =
      repliedMessage.attachments.size > 0
        ? `\n[添付: ${repliedMessage.attachments.map((a) => a.name).join(', ')}]`
        : '';

    console.log(`[xangi] Fetched reply-to message from ${author}`);
    return `\n---\n💬 返信元 (${author}):\n${content}${attachmentInfo}\n---\n`;
  } catch (err) {
    console.error(`[xangi] Failed to fetch reply-to message:`, err);
    return null;
  }
}

/** スレッド内メッセージの場合、スレッドの元メッセージを取得してプロンプト用に返す */
export async function fetchThreadStarterContent(message: Message): Promise<string | null> {
  const channel = message.channel as unknown as {
    isThread?: () => boolean;
    fetchStarterMessage?: () => Promise<Message | null>;
  };
  if (typeof channel.isThread !== 'function' || !channel.isThread()) return null;
  if (typeof channel.fetchStarterMessage !== 'function') return null;

  try {
    const starterMessage = await channel.fetchStarterMessage();
    if (!starterMessage) return null;
    const author = starterMessage.author.tag;
    const content = starterMessage.content || '(添付ファイルのみ)';
    const attachmentNames = Array.from(starterMessage.attachments.values()).map((a) => a.name);
    const attachmentInfo =
      attachmentNames.length > 0 ? `\n[添付: ${attachmentNames.join(', ')}]` : '';

    console.log(`[xangi] Fetched thread starter message from ${author}`);
    return `\n---\n🧵 スレッド元 (${author}):\n${content}${attachmentInfo}\n---\n`;
  } catch (err) {
    console.error('[xangi] Failed to fetch thread starter message:', err);
    return null;
  }
}

/**
 * メッセージコンテンツ内のチャンネルメンション <#ID> を無害化する
 * fetchChannelMessages() による意図しない二重展開を防ぐ
 */
export function sanitizeChannelMentions(content: string): string {
  return content.replace(/<#(\d+)>/g, '#$1');
}

/** チャンネルメンションから最新メッセージを取得してテキストに展開する */
export async function fetchChannelMessages(client: Client, text: string): Promise<string> {
  const channelMentionRegex = /<#(\d+)>/g;
  const matches = [...text.matchAll(channelMentionRegex)];

  if (matches.length === 0) return text;

  let result = text;
  for (const match of matches) {
    const [fullMention, channelId] = match;
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && 'messages' in channel) {
        const messages = await channel.messages.fetch({ limit: 10 });
        const channelName = 'name' in channel ? channel.name : 'unknown';

        const messageList = messages
          .reverse()
          .map((m) => {
            const time = m.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
            const content = sanitizeChannelMentions(m.content || '(添付ファイルのみ)');
            return `[${time}] ${m.author.tag}: ${content}`;
          })
          .join('\n');

        const expandedContent = `\n---\n📺 #${channelName} の最新メッセージ:\n${messageList}\n---\n`;
        result = result.replace(fullMention, expandedContent);
        console.log(`[xangi] Fetched messages from channel #${channelName}`);
      }
    } catch (err) {
      console.error(`[xangi] Failed to fetch channel messages: ${channelId}`, err);
    }
  }

  return result;
}

/**
 * チャンネルメンション <#ID> にチャンネルID注釈を追加
 * 例: <#123456> → <#123456> [チャンネルID: 123456]
 */
export function annotateChannelMentions(text: string): string {
  return text.replace(/<#(\d+)>/g, (match, id) => `${match} [チャンネルID: ${id}]`);
}
