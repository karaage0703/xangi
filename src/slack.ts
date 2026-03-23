import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { Config } from './config.js';
import type { AgentRunner } from './agent-runner.js';
import { processManager } from './process-manager.js';
import type { Skill } from './skills.js';
import { formatSkillList } from './skills.js';
import {
  downloadFile,
  extractFilePaths,
  stripFilePaths,
  buildPromptWithAttachments,
} from './file-utils.js';
import { loadSettings, saveSettings, formatSettings } from './settings.js';
import { STREAM_UPDATE_INTERVAL_MS } from './constants.js';

// セッション管理（sessionKey → セッションID）
// sessionKey = channelId (non-threaded) or channelId:threadTs (threaded)
const sessions = new Map<string, string>();

// 最後のBotメッセージ（sessionKey → メッセージts）
const lastBotMessages = new Map<string, string>();

/**
 * Compute session key from channelId and optional threadTs.
 * Returns "channelId:threadTs" for threaded messages, or "channelId" for non-threaded.
 */
function computeSessionKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

// Slack メッセージバイト数制限（chat.updateはバイト数で制限される）
const SLACK_MAX_TEXT_BYTES = 3900;

/**
 * 文字列をUTF-8バイト数で安全に切り詰める
 * マルチバイト文字の途中で切れないように処理
 */
function sliceByBytes(str: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(str).length <= maxBytes) {
    return str;
  }
  // バイナリサーチで最大文字位置を見つける
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(str.slice(0, mid)).length <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return str.slice(0, lo);
}

// 結果送信（長い場合は分割）
async function sendSlackResult(
  client: WebClient,
  channelId: string,
  messageTs: string,
  threadTs: string | undefined,
  result: string
): Promise<void> {
  const text = sliceByBytes(result, SLACK_MAX_TEXT_BYTES);
  const textBytes = new TextEncoder().encode(text).length;
  console.log(
    `[slack] sendSlackResult: textChars=${text.length}, textBytes=${textBytes}, resultChars=${result.length}`
  );

  try {
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
    });

    // 残りのテキストがあれば分割送信
    if (text.length < result.length) {
      const remaining = result.slice(text.length);
      const chunks = splitTextByBytes(remaining, SLACK_MAX_TEXT_BYTES);
      console.log(
        `[slack] Sending remaining ${chunks.length} chunks (${remaining.length} chars left)`
      );
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel: channelId,
          text: chunk,
          ...(threadTs && { thread_ts: threadTs }),
        });
      }
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[slack] Failed to update final message:', errorMessage);

    if (errorMessage.includes('msg_too_long')) {
      console.log(`[slack] Fallback: trying shorter text (2000 bytes)`);
      // テキストを短くしてリトライ
      try {
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: sliceByBytes(result, 2000),
        });
        console.log(`[slack] Fallback: short update succeeded`);
      } catch {
        console.log(`[slack] Fallback: short update failed, using placeholder`);
        // それでもダメなら新規メッセージとして投稿
        await client.chat
          .update({
            channel: channelId,
            ts: messageTs,
            text: '（長文のため別メッセージで送信）',
          })
          .catch(() => {});
      }

      // 残りを分割送信
      const chunks = splitTextByBytes(result, SLACK_MAX_TEXT_BYTES);
      console.log(`[slack] Fallback: sending ${chunks.length} chunks`);
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel: channelId,
          text: chunk,
          ...(threadTs && { thread_ts: threadTs }),
        });
      }
      console.log(`[slack] Fallback: all chunks sent`);
    } else {
      // その他のエラーは再throw
      throw err;
    }
  }
}

// テキストをバイト数で分割
function splitTextByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = sliceByBytes(remaining, maxBytes);
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

// メッセージ削除の共通関数
/**
 * AIの応答から SYSTEM_COMMAND: を検知して実行
 */
function handleSystemCommands(text: string, runner?: AgentRunner): void {
  const commands = text.match(/^SYSTEM_COMMAND:(.+)$/gm);
  if (!commands) return;

  for (const cmd of commands) {
    const action = cmd.replace('SYSTEM_COMMAND:', '').trim();

    if (action === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        console.log('[slack] Restart requested but autoRestart is disabled');
        continue;
      }
      console.log('[slack] Restart requested by agent, restarting in 1s...');
      setTimeout(() => {
        runner?.shutdown?.();
        process.exit(0);
      }, 1000);
      return;
    }

    const setMatch = action.match(/^set\s+(\w+)=(.*)/);
    if (setMatch) {
      const [, key, value] = setMatch;
      if (key === 'autoRestart') {
        const enabled = value === 'true';
        saveSettings({ autoRestart: enabled });
        console.log(`[slack] autoRestart ${enabled ? 'enabled' : 'disabled'} by agent`);
      }
    }
  }
}

async function deleteMessage(
  client: WebClient,
  channelId: string,
  sessionKey: string,
  arg: string
): Promise<string> {
  let messageTs: string | undefined;

  if (arg) {
    // 引数がある場合: ts または メッセージリンクから抽出
    const linkMatch = arg.match(/\/p(\d{10})(\d{6})/);
    if (linkMatch) {
      messageTs = `${linkMatch[1]}.${linkMatch[2]}`;
    } else if (/^\d+\.\d+$/.test(arg)) {
      messageTs = arg;
    } else {
      return '無効な形式です。メッセージリンクまたは ts を指定してください';
    }
  } else {
    messageTs = lastBotMessages.get(sessionKey);
    if (!messageTs) {
      return '削除できるメッセージがありません';
    }
  }

  try {
    await client.chat.delete({
      channel: channelId,
      ts: messageTs,
    });
    if (!arg) {
      lastBotMessages.delete(sessionKey);
    }
    return '🗑️ メッセージを削除しました';
  } catch (err) {
    console.error('[slack] Failed to delete message:', err);
    return 'メッセージの削除に失敗しました';
  }
}

// User name cache for history display
const userNameCache = new Map<string, string>();

async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  try {
    const info = await client.users.info({ user: userId });
    const name =
      (info.user as { display_name?: string; real_name?: string; name?: string })?.display_name ||
      (info.user as { real_name?: string })?.real_name ||
      (info.user as { name?: string })?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/**
 * Handle !slack commands from user input or AI response.
 * Returns { handled, response?, feedback? } similar to Discord's handleDiscordCommand().
 */
async function handleSlackCommand(
  text: string,
  client: WebClient,
  channelId: string,
  sessionKey: string,
  _threadTs?: string
): Promise<{ handled: boolean; response?: string; feedback?: boolean }> {
  // !slack send <#channelId> [thread:<ts>] message
  const sendMatch = text.match(
    /^!slack\s+send\s+<#([A-Z0-9]+)(?:\|[^>]*)?>(?:\s+thread:(\S+))?\s+(.+)$/s
  );
  if (sendMatch) {
    const [, targetChannel, targetThreadTs, content] = sendMatch;
    try {
      const chunks = splitTextByBytes(content, SLACK_MAX_TEXT_BYTES);
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel: targetChannel,
          text: chunk,
          ...(targetThreadTs && { thread_ts: targetThreadTs }),
        });
      }
      console.log(
        `[slack] Sent message to ${targetChannel} (${chunks.length} chunk(s))${targetThreadTs ? ` in thread ${targetThreadTs}` : ''}`
      );
      return { handled: true, response: `✅ <#${targetChannel}> に送信しました` };
    } catch (err) {
      console.error(`[slack] Failed to send message to channel: ${targetChannel}`, err);
      return { handled: true, response: `❌ <#${targetChannel}> への送信に失敗しました` };
    }
  }

  // !slack channels
  if (/^!slack\s+channels$/.test(text)) {
    try {
      const allChannels: Array<{ id: string; name: string; is_private: boolean }> = [];
      let cursor: string | undefined;
      do {
        const result = await client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          ...(cursor && { cursor }),
        });
        const channels = (result.channels || []) as Array<{
          id?: string;
          name?: string;
          is_private?: boolean;
        }>;
        for (const ch of channels) {
          if (ch.id && ch.name) {
            allChannels.push({ id: ch.id, name: ch.name, is_private: ch.is_private || false });
          }
        }
        cursor = (result.response_metadata as { next_cursor?: string })?.next_cursor || undefined;
      } while (cursor);

      const channelList = allChannels
        .map((ch) => `- ${ch.is_private ? '🔒' : '#'}${ch.name} (<#${ch.id}>)`)
        .join('\n');
      return {
        handled: true,
        response: `📺 チャンネル一覧（${allChannels.length}件）:\n${channelList}`,
        feedback: true,
      };
    } catch (err) {
      console.error('[slack] Failed to list channels:', err);
      return { handled: true, response: '❌ チャンネル一覧の取得に失敗しました', feedback: true };
    }
  }

  // !slack history [N] [offset:N] [<#channelId>]
  const historyMatch = text.match(
    /^!slack\s+history(?:\s+(\d+))?(?:\s+offset:(\d+))?(?:\s+<#([A-Z0-9]+)(?:\|[^>]*)?>)?$/
  );
  if (historyMatch) {
    const count = Math.min(parseInt(historyMatch[1] || '10', 10), 100);
    const offset = parseInt(historyMatch[2] || '0', 10);
    const targetChannelId = historyMatch[3] || channelId;
    try {
      let latest: string | undefined;

      // offset: skip messages to go further back
      if (offset > 0) {
        const skipResult = await client.conversations.history({
          channel: targetChannelId,
          limit: offset,
        });
        const skipMessages = (skipResult.messages || []) as Array<{ ts?: string }>;
        if (skipMessages.length > 0) {
          latest = skipMessages[skipMessages.length - 1].ts;
        }
      }

      const result = await client.conversations.history({
        channel: targetChannelId,
        limit: count,
        ...(latest && { latest }),
      });

      const messages = (result.messages || []) as Array<{
        ts?: string;
        text?: string;
        user?: string;
        bot_id?: string;
        username?: string;
      }>;

      const formattedMessages: string[] = [];
      for (const msg of [...messages].reverse()) {
        const ts = msg.ts ? parseFloat(msg.ts) : 0;
        const time = new Date(ts * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        let userName = msg.username || 'unknown';
        if (msg.user) {
          userName = await resolveUserName(client, msg.user);
        } else if (msg.bot_id) {
          userName = `bot:${msg.bot_id}`;
        }
        const content = (msg.text || '(添付ファイルのみ)').slice(0, 200);
        formattedMessages.push(`[${time}] ${userName}: ${content}`);
      }

      const rangeStart = offset;
      const rangeEnd = offset + messages.length;
      const offsetLabel =
        offset > 0 ? `${rangeStart}〜${rangeEnd}件目` : `最新${messages.length}件`;

      return {
        handled: true,
        response: `📺 <#${targetChannelId}> のチャンネル履歴（${offsetLabel}）:\n${formattedMessages.join('\n')}`,
        feedback: true,
      };
    } catch (err) {
      console.error('[slack] Failed to fetch history:', err);
      return { handled: true, response: '❌ 履歴の取得に失敗しました', feedback: true };
    }
  }

  // !slack search keyword
  const searchMatch = text.match(/^!slack\s+search\s+(.+)$/);
  if (searchMatch) {
    const keyword = searchMatch[1].trim();
    try {
      const result = await client.conversations.history({
        channel: channelId,
        limit: 100,
      });

      const messages = (result.messages || []) as Array<{
        ts?: string;
        text?: string;
        user?: string;
        bot_id?: string;
        username?: string;
      }>;

      const matched = messages.filter(
        (m) => m.text && m.text.toLowerCase().includes(keyword.toLowerCase())
      );

      if (matched.length > 0) {
        const results: string[] = [];
        for (const msg of matched.slice(0, 10)) {
          const ts = msg.ts ? parseFloat(msg.ts) : 0;
          const time = new Date(ts * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
          let userName = msg.username || 'unknown';
          if (msg.user) {
            userName = await resolveUserName(client, msg.user);
          }
          results.push(`[${time}] ${userName}: ${(msg.text || '').slice(0, 200)}`);
        }
        return {
          handled: true,
          response: `🔍 「${keyword}」の検索結果 (${matched.length}件):\n${results.join('\n')}`,
          feedback: true,
        };
      }

      return {
        handled: true,
        response: `🔍 「${keyword}」に一致するメッセージが見つかりませんでした`,
        feedback: true,
      };
    } catch (err) {
      console.error('[slack] Failed to search messages:', err);
      return { handled: true, response: '❌ 検索に失敗しました', feedback: true };
    }
  }

  // !slack delete [ts/link]
  const deleteMatch = text.match(/^!slack\s+delete(?:\s+(.+))?$/);
  if (deleteMatch) {
    const arg = (deleteMatch[1] || '').trim();
    const result = await deleteMessage(client, channelId, sessionKey, arg);
    return { handled: true, response: result, feedback: true };
  }

  // !slack topic <#channelId> text
  const topicMatch = text.match(/^!slack\s+topic\s+<#([A-Z0-9]+)(?:\|[^>]*)?>(?:\s+(.+))?$/s);
  if (topicMatch) {
    const [, targetChannel, topic] = topicMatch;
    if (!topic || !topic.trim()) {
      return { handled: true, response: '❌ トピックのテキストを指定してください', feedback: true };
    }
    try {
      await client.conversations.setTopic({
        channel: targetChannel,
        topic: topic.trim(),
      });
      console.log(`[slack] Set topic of ${targetChannel} to "${topic.trim()}"`);
      return {
        handled: true,
        response: `✅ <#${targetChannel}> のトピックを更新しました`,
        feedback: true,
      };
    } catch (err) {
      console.error('[slack] Failed to set topic:', err);
      return { handled: true, response: '❌ トピックの設定に失敗しました', feedback: true };
    }
  }

  return { handled: false };
}

/**
 * Scan AI response text for !slack commands and execute them.
 * Skips commands inside code blocks.
 * !slack send supports multi-line messages (absorbs lines until next command).
 * Returns feedback results array for re-injection.
 */
async function handleSlackCommandsInResponse(
  text: string,
  client: WebClient,
  channelId: string,
  sessionKey: string,
  threadTs?: string
): Promise<string[]> {
  const lines = text.split('\n');
  let inCodeBlock = false;
  let i = 0;
  const feedbackResults: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // Track code block open/close
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      i++;
      continue;
    }

    // Skip inside code blocks
    if (inCodeBlock) {
      i++;
      continue;
    }

    const trimmed = line.trim();

    // !slack send multi-line support (absorb lines until next command)
    const sendMatch = trimmed.match(
      /^!slack\s+send\s+<#([A-Z0-9]+)(?:\|[^>]*)?>(?:\s+thread:(\S+))?\s*(.*)/
    );
    if (sendMatch) {
      const [, targetChannel, targetThreadTs, firstLineContent] = sendMatch;
      const restContent = firstLineContent ?? '';

      // Absorb subsequent lines until next !slack or !schedule command
      const bodyLines: string[] = restContent.trim() ? [restContent] : [];
      let inBodyCodeBlock = false;
      i++;
      while (i < lines.length) {
        const bodyLine = lines[i];
        if (bodyLine.trim().startsWith('```')) {
          inBodyCodeBlock = !inBodyCodeBlock;
        }
        if (
          !inBodyCodeBlock &&
          (bodyLine.trim().startsWith('!slack ') || bodyLine.trim().startsWith('!schedule'))
        ) {
          break;
        }
        bodyLines.push(bodyLine);
        i++;
      }
      const fullMessage = bodyLines.join('\n').trim();
      if (fullMessage) {
        const threadPart = targetThreadTs ? ` thread:${targetThreadTs}` : '';
        const commandText = `!slack send <#${targetChannel}>${threadPart} ${fullMessage}`;
        console.log(
          `[slack] Processing slack command from response: ${commandText.slice(0, 80)}...`
        );
        const result = await handleSlackCommand(
          commandText,
          client,
          channelId,
          sessionKey,
          threadTs
        );
        if (result.handled && result.response) {
          if (result.feedback) {
            feedbackResults.push(result.response);
          }
        }
      }
      continue; // i already points to next command line
    }

    // Other !slack commands (channels, search, history, delete, topic)
    if (trimmed.startsWith('!slack ')) {
      console.log(`[slack] Processing slack command from response: ${trimmed.slice(0, 80)}...`);
      const result = await handleSlackCommand(trimmed, client, channelId, sessionKey, threadTs);
      if (result.handled && result.response) {
        if (result.feedback) {
          feedbackResults.push(result.response);
        }
      }
    }

    i++;
  }

  return feedbackResults;
}

import type { Scheduler } from './scheduler.js';

export interface SlackChannelOptions {
  config: Config;
  agentRunner: AgentRunner;
  skills: Skill[];
  reloadSkills: () => Skill[];
  scheduler?: Scheduler;
}

export async function startSlackBot(options: SlackChannelOptions): Promise<void> {
  const { config, agentRunner, reloadSkills } = options;
  let { skills } = options;

  if (!config.slack.botToken || !config.slack.appToken) {
    throw new Error('Slack tokens not configured');
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // メンション時の処理
  app.event('app_mention', async ({ event, say, client }) => {
    const userId = event.user;
    if (!userId) return;

    // 許可リストチェック（空の場合は全ユーザー許可）
    if (config.slack.allowedUsers?.length && !config.slack.allowedUsers.includes(userId)) {
      console.log(`[slack] Unauthorized user: ${userId}`);
      return;
    }

    let text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

    // 添付ファイルをダウンロード
    const attachmentPaths: string[] = [];
    const files = (event as unknown as Record<string, unknown>).files as
      | Array<{ url_private_download?: string; name?: string }>
      | undefined;
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.url_private_download) {
          try {
            const filePath = await downloadFile(file.url_private_download, file.name || 'file', {
              Authorization: `Bearer ${config.slack.botToken}`,
            });
            attachmentPaths.push(filePath);
          } catch (err) {
            console.error(`[slack] Failed to download attachment: ${file.name}`, err);
          }
        }
      }
    }

    if (!text && attachmentPaths.length === 0) return;
    text = buildPromptWithAttachments(text || '添付ファイルを確認してください', attachmentPaths);

    const channelId = event.channel;
    const threadTs = config.slack.replyInThread ? event.thread_ts || event.ts : undefined;
    const sessionKey = computeSessionKey(channelId, threadTs);

    // セッションクリアコマンド
    if (['!new', 'new', '/new', '!clear', 'clear', '/clear'].includes(text)) {
      sessions.delete(sessionKey);
      await say({
        text: '🆕 新しいセッションを開始しました',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 停止コマンド
    if (['!stop', 'stop', '/stop'].includes(text)) {
      const stopped = processManager.stop(sessionKey) || agentRunner.cancel?.(sessionKey) || false;
      await say({
        text: stopped ? '🛑 タスクを停止しました' : '実行中のタスクはありません',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 削除コマンド
    if (text === '!delete' || text === 'delete' || text.startsWith('!delete ')) {
      const arg = text.replace(/^!?delete\s*/, '').trim();
      const result = await deleteMessage(client, channelId, sessionKey, arg);
      await say({
        text: result,
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // !slack コマンドの処理（feedback: false → 直接返答、feedback: true → AI処理に流す）
    if (text.startsWith('!slack ')) {
      const result = await handleSlackCommand(text, client, channelId, sessionKey, threadTs);
      if (result.handled) {
        if (result.feedback && result.response) {
          // feedback結果はエージェントのコンテキストに注入
          text = `ユーザーが「${text}」を実行しました。以下がその結果です。この情報を踏まえてユーザーに返答してください。\n\n${result.response}`;
          // processMessageに流す（下に続く）
        } else {
          if (result.response) {
            await say({
              text: result.response,
              ...(threadTs && { thread_ts: threadTs }),
            });
          }
          return;
        }
      }
    }

    // 👀 リアクション追加
    await client.reactions
      .add({
        channel: channelId,
        timestamp: event.ts,
        name: 'eyes',
      })
      .catch((err) => {
        console.error('[slack] Failed to add reaction:', err.message || err);
      });

    await processMessage(
      channelId,
      threadTs,
      sessionKey,
      text,
      event.ts,
      client,
      agentRunner,
      config
    );
  });

  // DMの処理 + autoReplyChannels
  app.event('message', async ({ event, say, client }) => {
    // botのメッセージは無視
    if ('bot_id' in event || !('user' in event)) return;

    const messageEvent = event as {
      user: string;
      text?: string;
      channel: string;
      ts: string;
      thread_ts?: string;
      channel_type?: string;
      files?: Array<{ url_private_download?: string; name?: string }>;
    };

    console.log(
      `[slack] Message event: channel=${messageEvent.channel}, type=${messageEvent.channel_type}, autoReplyChannels=${config.slack.autoReplyChannels?.join(',')}`
    );

    // DM または autoReplyChannels のみ処理
    const isDM = messageEvent.channel_type === 'im';
    const isAutoReplyChannel = config.slack.autoReplyChannels?.includes(messageEvent.channel);
    if (!isDM && !isAutoReplyChannel) {
      console.log(`[slack] Skipping: isDM=${isDM}, isAutoReplyChannel=${isAutoReplyChannel}`);
      return;
    }

    // autoReplyChannels でメンション付きメッセージは app_mention で処理済みなのでスキップ
    const textRaw = messageEvent.text || '';
    if (isAutoReplyChannel && /<@[A-Z0-9]+>/i.test(textRaw)) {
      console.log(`[slack] Skipping mention in autoReplyChannel (handled by app_mention)`);
      return;
    }

    // 許可リストチェック（空の場合は全ユーザー許可）
    if (
      config.slack.allowedUsers?.length &&
      !config.slack.allowedUsers.includes(messageEvent.user)
    ) {
      console.log(`[slack] Unauthorized user: ${messageEvent.user}`);
      return;
    }

    let text = messageEvent.text || '';

    // 添付ファイルをダウンロード
    const dmAttachmentPaths: string[] = [];
    if (messageEvent.files && messageEvent.files.length > 0) {
      for (const file of messageEvent.files) {
        if (file.url_private_download) {
          try {
            const filePath = await downloadFile(file.url_private_download, file.name || 'file', {
              Authorization: `Bearer ${config.slack.botToken}`,
            });
            dmAttachmentPaths.push(filePath);
          } catch (err) {
            console.error(`[slack] Failed to download attachment: ${file.name}`, err);
          }
        }
      }
    }

    if (!text && dmAttachmentPaths.length === 0) return;
    text = buildPromptWithAttachments(text || '添付ファイルを確認してください', dmAttachmentPaths);

    const channelId = messageEvent.channel;
    const existingThreadTs = messageEvent.thread_ts;
    const threadTs = config.slack.replyInThread ? existingThreadTs || messageEvent.ts : undefined;
    const sessionKey = computeSessionKey(channelId, existingThreadTs);

    // セッションクリアコマンド
    if (['!new', 'new', '/new', '!clear', 'clear', '/clear'].includes(text)) {
      sessions.delete(sessionKey);
      await say({
        text: '🆕 新しいセッションを開始しました',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 停止コマンド
    if (['!stop', 'stop', '/stop'].includes(text)) {
      const stopped = processManager.stop(sessionKey) || agentRunner.cancel?.(sessionKey) || false;
      await say({
        text: stopped ? '🛑 タスクを停止しました' : '実行中のタスクはありません',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 削除コマンド
    if (text === '!delete' || text === 'delete' || text.startsWith('!delete ')) {
      const arg = text.replace(/^!?delete\s*/, '').trim();
      const result = await deleteMessage(client, channelId, sessionKey, arg);
      await say({
        text: result,
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // !slack コマンドの処理（feedback: false → 直接返答、feedback: true → AI処理に流す）
    if (text.startsWith('!slack ')) {
      const result = await handleSlackCommand(text, client, channelId, sessionKey, threadTs);
      if (result.handled) {
        if (result.feedback && result.response) {
          text = `ユーザーが「${text}」を実行しました。以下がその結果です。この情報を踏まえてユーザーに返答してください。\n\n${result.response}`;
        } else {
          if (result.response) {
            await say({
              text: result.response,
              ...(threadTs && { thread_ts: threadTs }),
            });
          }
          return;
        }
      }
    }

    // 👀 リアクション追加
    await client.reactions
      .add({
        channel: channelId,
        timestamp: messageEvent.ts,
        name: 'eyes',
      })
      .catch((err) => {
        console.error('[slack] Failed to add reaction:', err.message || err);
      });

    await processMessage(
      channelId,
      threadTs,
      sessionKey,
      text,
      messageEvent.ts,
      client,
      agentRunner,
      config
    );
  });

  // /new コマンド
  app.command('/new', async ({ command, ack, respond }) => {
    await ack();

    if (config.slack.allowedUsers?.length && !config.slack.allowedUsers.includes(command.user_id)) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    const channelId = command.channel_id;
    for (const key of [...sessions.keys()]) {
      if (key === channelId || key.startsWith(`${channelId}:`)) {
        sessions.delete(key);
      }
    }
    await respond({ text: '🆕 新しいセッションを開始しました' });
  });

  // /skills コマンド
  app.command('/skills', async ({ command, ack, respond }) => {
    await ack();

    if (config.slack.allowedUsers?.length && !config.slack.allowedUsers.includes(command.user_id)) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    skills = reloadSkills();
    await respond({ text: formatSkillList(skills) });
  });

  // /delete コマンド（Botメッセージを削除）
  // /delete → 直前のメッセージ
  // /delete <ts> → 指定のメッセージ（tsまたはメッセージリンクから抽出）
  app.command('/delete', async ({ command, ack, respond, client }) => {
    await ack();

    if (config.slack.allowedUsers?.length && !config.slack.allowedUsers.includes(command.user_id)) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    const result = await deleteMessage(
      client,
      command.channel_id,
      command.channel_id,
      command.text.trim()
    );
    await respond({ text: result, response_type: 'ephemeral' });
  });

  // /skill コマンド
  app.command('/skill', async ({ command, ack, respond }) => {
    await ack();

    if (config.slack.allowedUsers?.length && !config.slack.allowedUsers.includes(command.user_id)) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    const args = command.text.trim().split(/\s+/);
    const skillName = args[0];
    const skillArgs = args.slice(1).join(' ');

    if (!skillName) {
      await respond({ text: '使い方: `/skill <スキル名> [引数]`' });
      return;
    }

    const channelId = command.channel_id;
    const skipPermissions = config.agent.config.skipPermissions ?? false;

    try {
      const prompt = `スキル「${skillName}」を実行してください。${skillArgs ? `引数: ${skillArgs}` : ''}`;
      const sessionId = sessions.get(channelId);
      const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
        skipPermissions,
        sessionId,
        channelId,
      });

      sessions.set(channelId, newSessionId);
      await respond({ text: sliceByBytes(result, SLACK_MAX_TEXT_BYTES) });
    } catch (error) {
      console.error('[slack] Error:', error);
      await respond({ text: 'エラーが発生しました' });
    }
  });

  // /settings コマンド
  app.command('/settings', async ({ command, ack, respond }) => {
    await ack();

    if (config.slack.allowedUsers?.length && !config.slack.allowedUsers.includes(command.user_id)) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    const settings = loadSettings();
    await respond({ text: formatSettings(settings) });
  });

  // /restart コマンド
  app.command('/restart', async ({ command, ack, respond }) => {
    await ack();

    if (config.slack.allowedUsers?.length && !config.slack.allowedUsers.includes(command.user_id)) {
      await respond({ text: '許可されていないユーザーです', response_type: 'ephemeral' });
      return;
    }

    const settings = loadSettings();
    if (!settings.autoRestart) {
      await respond({ text: '⚠️ 自動再起動が無効です。先に有効にしてください。' });
      return;
    }
    await respond({ text: '🔄 再起動します...' });
    setTimeout(() => {
      agentRunner.shutdown?.();
      process.exit(0);
    }, 1000);
  });

  await app.start();
  console.log('[slack] ⚡️ Slack bot is running!');

  // スケジューラにSlack送信関数を登録
  if (options.scheduler) {
    options.scheduler.registerSender('slack', async (channelId, msg) => {
      await app.client.chat.postMessage({
        channel: channelId,
        text: msg,
      });
    });
  }
}

async function processMessage(
  channelId: string,
  threadTs: string | undefined,
  sessionKey: string,
  text: string,
  originalTs: string,
  client: WebClient,
  agentRunner: AgentRunner,
  config: Config
): Promise<void> {
  const skipPermissions = config.agent.config.skipPermissions ?? false;
  let prompt = text;

  // スキップ設定
  if (prompt.startsWith('!skip')) {
    prompt = prompt.replace(/^!skip\s*/, '').trim();
  }

  try {
    console.log(`[slack] Processing message in channel ${channelId} (session: ${sessionKey})`);

    const sessionId = sessions.get(sessionKey);
    const useStreaming = config.slack.streaming ?? true;
    const showThinking = config.slack.showThinking ?? true;

    // 最初のメッセージを送信
    const initialResponse = await client.chat.postMessage({
      channel: channelId,
      text: 'メッセージを受け付けました。処理中です...',
      ...(threadTs && { thread_ts: threadTs }),
    });

    const messageTs = initialResponse.ts;
    if (!messageTs) {
      throw new Error('Failed to get message timestamp');
    }

    // 最後のBotメッセージを保存
    lastBotMessages.set(sessionKey, messageTs);

    let result: string;
    let newSessionId: string;

    if (useStreaming && showThinking) {
      // ストリーミング + 思考表示モード
      let lastUpdateTime = 0;
      let pendingUpdate = false;

      const streamResult = await agentRunner.runStream(
        prompt,
        {
          onText: (_chunk, fullText) => {
            const now = Date.now();
            if (now - lastUpdateTime >= STREAM_UPDATE_INTERVAL_MS && !pendingUpdate) {
              pendingUpdate = true;
              lastUpdateTime = now;
              const streamText = sliceByBytes(fullText, SLACK_MAX_TEXT_BYTES - 10) + ' ▌';
              const streamBytes = new TextEncoder().encode(streamText).length;
              console.log(
                `[slack] stream update: chars=${streamText.length}, bytes=${streamBytes}`
              );
              client.chat
                .update({
                  channel: channelId,
                  ts: messageTs,
                  text: streamText,
                })
                .catch((err) => {
                  console.error(
                    `[slack] Failed to update message (bytes=${streamBytes}):`,
                    err.message
                  );
                })
                .finally(() => {
                  pendingUpdate = false;
                });
            }
          },
        },
        { skipPermissions, sessionId, channelId: sessionKey }
      );
      result = streamResult.result;
      newSessionId = streamResult.sessionId;
    } else {
      // 非ストリーミング or 思考非表示モード
      // 考え中アニメーション
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        client.chat
          .update({
            channel: channelId,
            ts: messageTs,
            text: `処理中です${dots}`,
          })
          .catch(() => {});
      }, 1000);

      try {
        const runResult = await agentRunner.run(prompt, {
          skipPermissions,
          sessionId,
          channelId: sessionKey,
        });
        result = runResult.result;
        newSessionId = runResult.sessionId;
      } finally {
        clearInterval(thinkingInterval);
      }
    }

    sessions.set(sessionKey, newSessionId);
    console.log(`[slack] Final result length: ${result.length}`);

    // AI応答から !slack コマンドを検知して実行
    const feedbackResults = await handleSlackCommandsInResponse(
      result,
      client,
      channelId,
      sessionKey,
      threadTs
    );

    // フィードバック結果があればエージェントに再注入
    if (feedbackResults.length > 0) {
      const feedbackPrompt = `あなたが実行したコマンドの結果が返ってきました。この情報を踏まえて、元の会話の文脈に沿ってユーザーに返答してください。\n\n${feedbackResults.join('\n\n')}`;
      console.log(`[slack] Re-injecting ${feedbackResults.length} feedback result(s) to agent`);

      const feedbackSessionId = sessions.get(sessionKey);
      const feedbackRunResult = await agentRunner.run(feedbackPrompt, {
        skipPermissions,
        sessionId: feedbackSessionId,
        channelId: sessionKey,
      });
      result = feedbackRunResult.result;
      sessions.set(sessionKey, feedbackRunResult.sessionId);

      // 再注入後の応答にもコマンドがあれば処理（再帰は1回のみ）
      await handleSlackCommandsInResponse(result, client, channelId, sessionKey, threadTs);
    }

    // ファイルパスを抽出して添付送信
    const filePaths = extractFilePaths(result);
    let displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

    // SYSTEM_COMMAND: 行と !slack コマンド行を表示テキストから除去
    displayText = displayText
      .replace(/^SYSTEM_COMMAND:.+$/gm, '')
      .replace(/^!slack\s+.+$/gm, '')
      .trim();

    // SYSTEM_COMMAND: を検知して実行
    handleSystemCommands(result, agentRunner);

    // 最終結果を更新（長い場合は分割送信）
    await sendSlackResult(client, channelId, messageTs, threadTs, displayText || '✅');

    if (filePaths.length > 0) {
      try {
        for (const fp of filePaths) {
          const fileContent = await import('fs').then((fs) => fs.default.readFileSync(fp));
          const filename = await import('path').then((path) => path.default.basename(fp));
          const uploadArgs: Record<string, unknown> = {
            channel_id: channelId,
            file: fileContent,
            filename,
          };
          if (threadTs) {
            uploadArgs.thread_ts = threadTs;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await client.filesUploadV2(uploadArgs as any);
        }
        console.log(`[slack] Sent ${filePaths.length} file(s)`);
      } catch (err) {
        console.error('[slack] Failed to upload files:', err);
      }
    }
  } catch (error) {
    console.error('[slack] Error:', error);
    await client.chat.postMessage({
      channel: channelId,
      text: 'エラーが発生しました',
      ...(threadTs && { thread_ts: threadTs }),
    });
  } finally {
    // 👀 リアクションを削除
    await client.reactions
      .remove({
        channel: channelId,
        timestamp: originalTs,
        name: 'eyes',
      })
      .catch((err) => {
        console.error('[slack] Failed to remove reaction:', err.message || err);
      });
  }
}
