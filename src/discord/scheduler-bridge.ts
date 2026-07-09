import type { Client, Message } from 'discord.js';
import type { Config } from '../config.js';
import type { AgentRunner } from '../agent-runner.js';
import type { Scheduler } from '../scheduler.js';
import { buildAttachmentResult } from '../file-utils.js';
import { splitMessage } from '../message-split.js';
import { DISCORD_SAFE_LENGTH } from '../constants.js';
import { ensureSession, setSession } from '../sessions.js';
import { formatAgentErrorForUser } from '../errors.js';
import { registerStreamFinalizer } from '../stream-finalizer.js';
import { waitBeforeFollowupDiscordSend } from './send-delay.js';
import { createProcessingButtons, discordProcessingMessages } from './ui.js';

export interface SchedulerBridgeDeps {
  scheduler: Scheduler;
  client: Client;
  config: Config;
  agentRunner: AgentRunner;
}

/**
 * スケジューラに Discord 向けの送信関数とエージェント実行関数を登録する。
 * Discord ログイン後に一度だけ呼ぶ。
 */
export function registerDiscordSchedulerBridge(deps: SchedulerBridgeDeps): void {
  const { scheduler, client, config, agentRunner } = deps;

  // スケジューラにDiscord送信関数を登録
  scheduler.registerSender('discord', async (channelId, msg) => {
    const channel = await client.channels.fetch(channelId);
    if (channel && 'send' in channel) {
      await (channel as { send: (content: string) => Promise<unknown> }).send(msg);
    }
  });

  // スケジューラにエージェント実行関数を登録
  scheduler.registerAgentRunner('discord', async (prompt, channelId) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    // 処理中メッセージを送信
    const thinkingMsg = await (
      channel as {
        send: (options: unknown) => Promise<Message>;
      }
    ).send({
      content: '🤔 考え中...',
      components: [createProcessingButtons()],
    });

    discordProcessingMessages.set(channelId, { message: thinkingMsg });

    // プロセス再起動 (SIGTERM) で turn が中断されたとき、「考え中」表示を
    // 放置せず「中断」表示で確定させる (issue #293)。スケジューラ起点ターンは
    // message-handler を通らないため、ここで個別に登録する
    const unregisterStreamFinalizer = registerStreamFinalizer(async () => {
      await thinkingMsg
        .edit({ content: '⏸ プロセス再起動により中断されました', components: [] })
        .catch(() => {});
    });

    try {
      // タイムスタンプをプロンプトの先頭に注入
      let agentPrompt = prompt;
      if (config.discord.injectTimestamp !== false) {
        const d = new Date();
        const now = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });
        agentPrompt = `[現在時刻: ${now}(${day})]\n${agentPrompt}`;
      }

      // スケジューラーは毎回新規セッション（stateless）
      // - Claude Code 経路: sessionId=undefined で `claude --resume` 無し
      // - Local LLM 経路: appSessionId を cron 発火ごとに unique 化して
      //   transcript jsonl からの restore を回避する（jsonl resume が
      //   cron 文脈で stateful 化してしまう構造バグの修正）。
      //   ensureSession(scope=scheduler) は setSession 整合性のため維持。
      const schedAppSessionId = ensureSession(channelId, {
        platform: 'discord',
        scope: 'scheduler',
      });
      const freshAppSessionId = `${schedAppSessionId}-${Date.now()}`;
      const {
        result,
        sessionId: newSessionId,
        attachments,
      } = await agentRunner.run(agentPrompt, {
        skipPermissions: config.agent.config.skipPermissions ?? false,
        sessionId: undefined,
        channelId,
        appSessionId: freshAppSessionId,
      });

      // スケジューラーのセッションは scheduler スコープで保存
      setSession(channelId, newSessionId, 'scheduler');

      // 結果を送信（テキスト由来 + 構造化 attachments を合算・重複排除）
      const { filePaths, displayText } = buildAttachmentResult(result, attachments);
      if (!displayText.trim() && filePaths.length === 0) {
        await thinkingMsg.delete().catch(() => {});
        return result;
      }

      // === セパレータで明示的に分割（content-digest等で複数投稿を1応答に含める用途）
      // LLMが前後に空白や余分な改行を入れることがあるため、正規表現で緩くマッチ
      const SEPARATOR_REGEX = /\n\s*===\s*\n/;
      const messageParts = SEPARATOR_REGEX.test(displayText)
        ? displayText
            .split(SEPARATOR_REGEX)
            .map((p) => p.trim())
            .filter(Boolean)
        : [displayText];

      // 最初のパートは既存のthinkingMsgを編集して送信
      const firstChunks = splitMessage(messageParts[0], DISCORD_SAFE_LENGTH);
      await thinkingMsg.edit({ content: firstChunks[0] || '✅', components: [] });
      const ch = channel as { send: (content: string) => Promise<unknown> };
      // 最初のパートの残りチャンク
      for (let i = 1; i < firstChunks.length; i++) {
        await waitBeforeFollowupDiscordSend();
        await ch.send(firstChunks[i]);
      }
      // 2つ目以降のパートは新規メッセージとして送信
      for (let p = 1; p < messageParts.length; p++) {
        const chunks = splitMessage(messageParts[p], DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await waitBeforeFollowupDiscordSend();
          await ch.send(chunk);
        }
      }

      if (filePaths.length > 0) {
        await (
          channel as { send: (options: { files: { attachment: string }[] }) => Promise<unknown> }
        ).send({
          files: filePaths.map((fp) => ({ attachment: fp })),
        });
      }

      return result;
    } catch (error) {
      await thinkingMsg
        .edit({ content: formatAgentErrorForUser(error), components: [] })
        .catch(() => {});
      throw error;
    } finally {
      const entry = discordProcessingMessages.get(channelId);
      if (entry?.intervalId) clearInterval(entry.intervalId);
      discordProcessingMessages.delete(channelId);
      unregisterStreamFinalizer();
    }
  });
}
