import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  AutocompleteInteraction,
} from 'discord.js';
import { loadConfig } from './config.js';
import { createAgentRunner, getBackendDisplayName, type AgentRunner } from './agent-runner.js';
import { processManager } from './process-manager.js';
import { loadSkills, formatSkillList, type Skill } from './skills.js';
import { startSlackBot } from './slack.js';
import {
  downloadFile,
  extractFilePaths,
  stripFilePaths,
  buildPromptWithAttachments,
} from './file-utils.js';
import { initSettings, loadSettings, saveSettings, formatSettings } from './settings.js';
import { DISCORD_MAX_LENGTH, DISCORD_SAFE_LENGTH, STREAM_UPDATE_INTERVAL_MS } from './constants.js';
import {
  Scheduler,
  parseScheduleInput,
  formatScheduleList,
  type Platform,
  type ScheduleType,
} from './scheduler.js';
import { initSessions, getSession, setSession, deleteSession } from './sessions.js';
import { join } from 'path';

/** メッセージを指定文字数で分割（行単位で分割を試みる） */
function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLength) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

/** スケジュールタイプに応じたラベルを生成 */
function getTypeLabel(
  type: ScheduleType,
  options: { expression?: string; runAt?: string; channelInfo?: string }
): string {
  const channelInfo = options.channelInfo || '';
  switch (type) {
    case 'cron':
      return `🔄 繰り返し: \`${options.expression}\`${channelInfo}`;
    case 'startup':
      return `🚀 起動時に実行${channelInfo}`;
    case 'once':
    default:
      return `⏰ 実行時刻: ${new Date(options.runAt!).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}${channelInfo}`;
  }
}

async function main() {
  const config = loadConfig();

  // 許可リストの必須チェック（各プラットフォームで1人のみ許可）
  const discordAllowed = config.discord.allowedUsers || [];
  const slackAllowed = config.slack.allowedUsers || [];

  if (config.discord.enabled && discordAllowed.length === 0) {
    console.error('[xangi] Error: ALLOWED_USER must be set for Discord');
    process.exit(1);
  }
  if (config.slack.enabled && slackAllowed.length === 0) {
    console.error('[xangi] Error: SLACK_ALLOWED_USER or ALLOWED_USER must be set for Slack');
    process.exit(1);
  }
  if (discordAllowed.length > 1 || slackAllowed.length > 1) {
    console.error('[xangi] Error: Only one user per platform is allowed');
    console.error('[xangi] 利用規約遵守のため、複数ユーザーの設定は禁止です');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // エージェントランナーを作成
  const agentRunner = createAgentRunner(config.agent.backend, config.agent.config);
  const backendName = getBackendDisplayName(config.agent.backend);
  console.log(`[xangi] Using ${backendName} as agent backend`);

  // スキルを読み込み
  const workdir = config.agent.config.workdir || process.cwd();
  let skills: Skill[] = loadSkills(workdir);
  console.log(`[xangi] Loaded ${skills.length} skills from ${workdir}`);

  // 設定を初期化
  initSettings(workdir);
  const initialSettings = loadSettings();
  console.log(`[xangi] Settings loaded: autoRestart=${initialSettings.autoRestart}`);

  // スケジューラを初期化（ワークスペースの .xangi を使用）
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  const scheduler = new Scheduler(dataDir);

  // セッション永続化を初期化
  initSessions(dataDir);

  // スラッシュコマンド定義
  const commands: ReturnType<SlashCommandBuilder['toJSON']>[] = [
    new SlashCommandBuilder().setName('new').setDescription('新しいセッションを開始する').toJSON(),
    new SlashCommandBuilder().setName('stop').setDescription('実行中のタスクを停止する').toJSON(),
    new SlashCommandBuilder()
      .setName('skills')
      .setDescription('利用可能なスキル一覧を表示')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('skill')
      .setDescription('スキルを実行する')
      .addStringOption((option) =>
        option.setName('name').setDescription('スキル名').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) => option.setName('args').setDescription('引数').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName('settings').setDescription('現在の設定を表示する').toJSON(),
    new SlashCommandBuilder().setName('restart').setDescription('ボットを再起動する').toJSON(),
    new SlashCommandBuilder()
      .setName('schedule')
      .setDescription('スケジュール管理')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('スケジュールを追加')
          .addStringOption((opt) =>
            opt
              .setName('input')
              .setDescription('例: "30分後 ミーティング" / "毎日 9:00 おはよう"')
              .setRequired(true)
          )
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('スケジュール一覧を表示'))
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('スケジュールを削除')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('スケジュールID').setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('スケジュールの有効/無効を切り替え')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('スケジュールID').setRequired(true)
          )
      )
      .toJSON(),
  ];

  // 各スキルを個別のスラッシュコマンドとして追加
  for (const skill of skills) {
    // Discordコマンド名は小文字英数字とハイフンのみ（最大32文字）
    const cmdName = skill.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);

    if (cmdName) {
      commands.push(
        new SlashCommandBuilder()
          .setName(cmdName)
          .setDescription(skill.description.slice(0, 100) || `${skill.name}スキルを実行`)
          .addStringOption((option) =>
            option.setName('args').setDescription('引数（任意）').setRequired(false)
          )
          .toJSON()
      );
    }
  }

  // スラッシュコマンド登録
  client.once(Events.ClientReady, async (c) => {
    console.log(`[xangi] Ready! Logged in as ${c.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    try {
      // ギルドコマンドとして登録（即時反映）
      const guilds = c.guilds.cache;
      console.log(`[xangi] Found ${guilds.size} guilds`);

      for (const [guildId, guild] of guilds) {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), {
          body: commands,
        });
        console.log(`[xangi] ${commands.length} slash commands registered for: ${guild.name}`);
      }

      // グローバルコマンドをクリア（重複防止）
      await rest.put(Routes.applicationCommands(c.user.id), { body: [] });
      console.log('[xangi] Cleared global commands');
    } catch (error) {
      console.error('[xangi] Failed to register slash commands:', error);
    }
  });

  // スラッシュコマンド処理
  client.on(Events.InteractionCreate, async (interaction) => {
    // オートコンプリート処理
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, skills);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // 許可リストチェック
    if (!config.discord.allowedUsers?.includes(interaction.user.id)) {
      await interaction.reply({ content: '許可されていないユーザーです', ephemeral: true });
      return;
    }

    const channelId = interaction.channelId;

    if (interaction.commandName === 'new') {
      deleteSession(channelId);
      await interaction.reply('🆕 新しいセッションを開始しました');
      return;
    }

    if (interaction.commandName === 'stop') {
      const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
      if (stopped) {
        await interaction.reply('🛑 タスクを停止しました');
      } else {
        await interaction.reply({ content: '実行中のタスクはありません', ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'settings') {
      const settings = loadSettings();
      await interaction.reply(formatSettings(settings));
      return;
    }

    if (interaction.commandName === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        await interaction.reply('⚠️ 自動再起動が無効です。先に有効にしてください。');
        return;
      }
      await interaction.reply('🔄 再起動します...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    if (interaction.commandName === 'schedule') {
      await handleScheduleCommand(interaction, scheduler, config.scheduler);
      return;
    }

    if (interaction.commandName === 'skills') {
      // スキルを再読み込み
      skills = loadSkills(workdir);
      await interaction.reply(formatSkillList(skills));
      return;
    }

    if (interaction.commandName === 'skill') {
      await handleSkill(interaction, agentRunner, config, channelId);
      return;
    }

    // 個別スキルコマンドの処理
    const matchedSkill = skills.find((s) => {
      const cmdName = s.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
      return cmdName === interaction.commandName;
    });

    if (matchedSkill) {
      await handleSkillCommand(interaction, agentRunner, config, channelId, matchedSkill.name);
      return;
    }
  });

  // Discordリンクからメッセージ内容を取得する関数
  async function fetchDiscordLinkContent(text: string): Promise<string> {
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

  // 返信元メッセージを取得してプロンプトに追加する関数
  async function fetchReplyContent(message: Message): Promise<string | null> {
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

  // チャンネルメンションから最新メッセージを取得する関数
  async function fetchChannelMessages(text: string): Promise<string> {
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
              const content = m.content || '(添付ファイルのみ)';
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
  function annotateChannelMentions(text: string): string {
    return text.replace(/<#(\d+)>/g, (match, id) => `${match} [チャンネルID: ${id}]`);
  }

  /**
   * Discord の 2000 文字制限に合わせてメッセージを分割する
   */
  function chunkDiscordMessage(message: string, limit = DISCORD_MAX_LENGTH): string[] {
    if (message.length <= limit) return [message];

    const chunks: string[] = [];
    let buf = '';

    for (const line of message.split('\n')) {
      if (line.length > limit) {
        // 1行が limit 超え → バッファをフラッシュしてハードスプリット
        if (buf) {
          chunks.push(buf);
          buf = '';
        }
        for (let j = 0; j < line.length; j += limit) {
          chunks.push(line.slice(j, j + limit));
        }
        continue;
      }
      const candidate = buf ? `${buf}\n${line}` : line;
      if (candidate.length > limit) {
        chunks.push(buf);
        buf = line;
      } else {
        buf = candidate;
      }
    }
    if (buf) chunks.push(buf);
    return chunks;
  }

  // Discordコマンドを処理する関数
  async function handleDiscordCommand(
    text: string,
    sourceMessage?: Message
  ): Promise<{ handled: boolean; response?: string }> {
    // !discord send <#channelId> message (複数行対応)
    const sendMatch = text.match(/^!discord\s+send\s+<#(\d+)>\s+(.+)$/s);
    if (sendMatch) {
      const [, channelId, content] = sendMatch;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'send' in channel) {
          const typedChannel = channel as {
            send: (options: {
              content: string;
              allowedMentions: { parse: never[] };
            }) => Promise<unknown>;
          };
          // 2000文字制限に合わせて分割送信
          const chunks = chunkDiscordMessage(content);
          for (const chunk of chunks) {
            await typedChannel.send({
              content: chunk,
              allowedMentions: { parse: [] },
            });
          }
          const channelName = 'name' in channel ? channel.name : 'unknown';
          console.log(`[xangi] Sent message to #${channelName} (${chunks.length} chunk(s))`);
          return { handled: true, response: `✅ #${channelName} にメッセージを送信しました` };
        }
      } catch (err) {
        console.error(`[xangi] Failed to send message to channel: ${channelId}`, err);
        return { handled: true, response: `❌ チャンネルへの送信に失敗しました` };
      }
    }

    // !discord channels
    if (text.match(/^!discord\s+channels$/)) {
      if (!sourceMessage) {
        return {
          handled: true,
          response: '⚠️ channels コマンドはスケジューラーからは使用できません',
        };
      }
      try {
        const guild = sourceMessage.guild;
        if (guild) {
          const channels = guild.channels.cache
            .filter((c) => c.type === 0) // テキストチャンネルのみ
            .map((c) => `- #${c.name} (<#${c.id}>)`)
            .join('\n');
          return { handled: true, response: `📺 チャンネル一覧:\n${channels}` };
        }
      } catch (err) {
        console.error(`[xangi] Failed to list channels`, err);
        return { handled: true, response: `❌ チャンネル一覧の取得に失敗しました` };
      }
    }

    // !discord search <keyword>
    const searchMatch = text.match(/^!discord\s+search\s+(.+)$/);
    if (searchMatch) {
      if (!sourceMessage) {
        return {
          handled: true,
          response: '⚠️ search コマンドはスケジューラーからは使用できません',
        };
      }
      const [, keyword] = searchMatch;
      try {
        // 現在のチャンネルで検索
        const channel = sourceMessage.channel;
        if ('messages' in channel) {
          const messages = await channel.messages.fetch({ limit: 100 });
          const matched = messages.filter((m) =>
            m.content.toLowerCase().includes(keyword.toLowerCase())
          );
          if (matched.size > 0) {
            const results = matched
              .first(10)
              ?.map((m) => `[${m.author.tag}] ${m.content.slice(0, 100)}`)
              .join('\n');
            return {
              handled: true,
              response: `🔍 「${keyword}」の検索結果 (${matched.size}件):\n${results}`,
            };
          }
        }
        return {
          handled: true,
          response: `🔍 「${keyword}」に一致するメッセージが見つかりませんでした`,
        };
      } catch (err) {
        console.error(`[xangi] Failed to search messages`, err);
        return { handled: true, response: `❌ 検索に失敗しました` };
      }
    }

    return { handled: false };
  }

  /**
   * AIの応答から !discord コマンドを検知して実行
   * コードブロック内のコマンドは無視する
   * !discord send は複数行メッセージに対応（次の !discord / !schedule コマンド行まで吸収）
   */
  async function handleDiscordCommandsInResponse(
    text: string,
    sourceMessage?: Message
  ): Promise<void> {
    const lines = text.split('\n');
    let inCodeBlock = false;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // コードブロックの開始/終了を追跡
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        i++;
        continue;
      }

      // コードブロック内はスキップ
      if (inCodeBlock) {
        i++;
        continue;
      }

      const trimmed = line.trim();

      // !discord send の複数行対応
      const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
      if (sendMatch) {
        const firstLineContent = sendMatch[2] ?? '';

        if (firstLineContent.trim() === '') {
          // 本文が空 → 次の !discord / !schedule コマンド行まで吸収（暗黙マルチライン）
          const bodyLines: string[] = [];
          let inBodyCodeBlock = false;
          i++;
          while (i < lines.length) {
            const bodyLine = lines[i];
            if (bodyLine.trim().startsWith('```')) {
              inBodyCodeBlock = !inBodyCodeBlock;
            }
            // コードブロック外で次のコマンド行が来たら吸収終了
            if (
              !inBodyCodeBlock &&
              (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
            ) {
              break;
            }
            bodyLines.push(bodyLine);
            i++;
          }
          const fullMessage = bodyLines.join('\n').trim();
          if (fullMessage) {
            const commandText = `!discord send <#${sendMatch[1]}> ${fullMessage}`;
            console.log(
              `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
            );
            const result = await handleDiscordCommand(commandText, sourceMessage);
            if (result.handled && result.response && sourceMessage) {
              const channel = sourceMessage.channel;
              if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
                await (channel as { send: (content: string) => Promise<unknown> }).send(
                  result.response
                );
              }
            }
          }
          continue; // i は既に次のコマンド行を指している
        } else {
          // 1行目にテキストあり → 続く行も吸収（次のコマンド行まで）
          const bodyLines: string[] = [firstLineContent];
          let inBodyCodeBlock2 = false;
          i++;
          while (i < lines.length) {
            const bodyLine = lines[i];
            if (bodyLine.trim().startsWith('```')) {
              inBodyCodeBlock2 = !inBodyCodeBlock2;
            }
            if (
              !inBodyCodeBlock2 &&
              (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
            ) {
              break;
            }
            bodyLines.push(bodyLine);
            i++;
          }
          const fullMessage = bodyLines.join('\n').trimEnd();
          const commandText = `!discord send <#${sendMatch[1]}> ${fullMessage}`;
          console.log(
            `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
          );
          const result = await handleDiscordCommand(commandText, sourceMessage);
          if (result.handled && result.response && sourceMessage) {
            const channel = sourceMessage.channel;
            if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
              await (channel as { send: (content: string) => Promise<unknown> }).send(
                result.response
              );
            }
          }
          continue;
        }
      }

      // その他の !discord コマンド（channels, search）
      if (trimmed.startsWith('!discord ')) {
        console.log(`[xangi] Processing discord command from response: ${trimmed.slice(0, 50)}...`);
        const result = await handleDiscordCommand(trimmed, sourceMessage);
        if (result.handled && result.response && sourceMessage) {
          const channel = sourceMessage.channel;
          if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
            await (channel as { send: (content: string) => Promise<unknown> }).send(
              result.response
            );
          }
        }
      }

      // !schedule コマンド（引数なしでもlist表示、sourceMessage必須）
      if (sourceMessage && (trimmed === '!schedule' || trimmed.startsWith('!schedule '))) {
        console.log(
          `[xangi] Processing schedule command from response: ${trimmed.slice(0, 50)}...`
        );
        await executeScheduleFromResponse(trimmed, sourceMessage, scheduler, config.scheduler);
      }

      i++;
    }
  }

  // チャンネル単位の処理中ロック
  const processingChannels = new Set<string>();

  // メッセージ処理
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const isMentioned = message.mentions.has(client.user!);
    const isDM = !message.guild;
    const isAutoReplyChannel =
      config.discord.autoReplyChannels?.includes(message.channel.id) ?? false;

    if (!isMentioned && !isDM && !isAutoReplyChannel) return;

    // 同じチャンネルで処理中なら無視（メンション時は除く）
    if (!isMentioned && processingChannels.has(message.channel.id)) {
      console.log(`[xangi] Skipping message in busy channel: ${message.channel.id}`);
      return;
    }

    if (!config.discord.allowedUsers?.includes(message.author.id)) {
      console.log(`[xangi] Unauthorized user: ${message.author.id} (${message.author.tag})`);
      return;
    }

    let prompt = message.content
      .replace(/<@[!&]?\d+>/g, '') // ユーザーメンションのみ削除（チャンネルメンションは残す）
      .replace(/\s+/g, ' ')
      .trim();

    // !discord コマンドの処理
    if (prompt.startsWith('!discord')) {
      const result = await handleDiscordCommand(prompt, message);
      if (result.handled) {
        if (result.response && 'send' in message.channel) {
          await message.channel.send(result.response);
        }
        return;
      }
    }

    // !schedule コマンドの処理
    if (prompt.startsWith('!schedule')) {
      await handleScheduleMessage(message, prompt, scheduler, config.scheduler);
      return;
    }

    // Discordリンクからメッセージ内容を取得
    prompt = await fetchDiscordLinkContent(prompt);

    // 返信元メッセージを取得してプロンプトに追加
    const replyContent = await fetchReplyContent(message);
    if (replyContent) {
      prompt = replyContent + prompt;
    }

    // チャンネルメンションにID注釈を追加（展開前に実行）
    prompt = annotateChannelMentions(prompt);

    // チャンネルメンションから最新メッセージを取得
    prompt = await fetchChannelMessages(prompt);

    // 添付ファイルをダウンロード
    const attachmentPaths: string[] = [];
    if (message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        try {
          const filePath = await downloadFile(attachment.url, attachment.name || 'file');
          attachmentPaths.push(filePath);
        } catch (err) {
          console.error(`[xangi] Failed to download attachment: ${attachment.name}`, err);
        }
      }
    }

    // テキストも添付もない場合はスキップ
    if (!prompt && attachmentPaths.length === 0) return;

    // 添付ファイル情報をプロンプトに追加
    prompt = buildPromptWithAttachments(
      prompt || '添付ファイルを確認してください',
      attachmentPaths
    );

    const channelId = message.channel.id;

    // スキップ設定
    const defaultSkip = config.agent.config.skipPermissions ?? false;
    let skipPermissions = defaultSkip;

    if (prompt.startsWith('!skip')) {
      skipPermissions = true;
      prompt = prompt.replace(/^!skip\s*/, '').trim();
    } else if (prompt.startsWith('!noskip')) {
      skipPermissions = false;
      prompt = prompt.replace(/^!noskip\s*/, '').trim();
    }

    processingChannels.add(channelId);
    try {
      const result = await processPrompt(
        message,
        agentRunner,
        prompt,
        skipPermissions,
        channelId,
        config
      );

      // AIの応答から !discord コマンドを検知して実行
      if (result) {
        await handleDiscordCommandsInResponse(result, message);
      }
    } finally {
      processingChannels.delete(channelId);
    }
  });

  // Discordボットを起動
  if (config.discord.enabled) {
    await client.login(config.discord.token);
    console.log('[xangi] Discord bot started');

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

      // プロンプト内の !discord send コマンドを先に直接実行
      // （AIに渡すとコマンドが応答に含まれず実行されないため）
      const promptCommands = extractDiscordSendFromPrompt(prompt);
      for (const cmd of promptCommands.commands) {
        console.log(`[scheduler] Executing discord command from prompt: ${cmd.slice(0, 80)}...`);
        await handleDiscordCommand(cmd);
      }

      // !discord send 以外のテキストが残っていればAIに渡す
      const remainingPrompt = promptCommands.remaining.trim();
      if (!remainingPrompt) {
        // コマンドのみのプロンプトだった場合、AIは不要
        console.log('[scheduler] Prompt contained only discord commands, skipping agent');
        return promptCommands.commands.map((c) => `✅ ${c.slice(0, 50)}`).join('\n');
      }

      // 処理中メッセージを送信
      const thinkingMsg = await (
        channel as {
          send: (content: string) => Promise<{ edit: (content: string) => Promise<unknown> }>;
        }
      ).send('🤔 考え中...');

      try {
        const sessionId = getSession(channelId);
        const { result, sessionId: newSessionId } = await agentRunner.run(remainingPrompt, {
          skipPermissions: config.agent.config.skipPermissions ?? false,
          sessionId,
          channelId,
        });

        setSession(channelId, newSessionId);

        // AI応答内の !discord コマンドを処理（sourceMessage なし）
        await handleDiscordCommandsInResponse(result);

        // 結果を送信
        const filePaths = extractFilePaths(result);
        const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

        await thinkingMsg.edit(displayText.slice(0, DISCORD_MAX_LENGTH) || '✅');

        if (filePaths.length > 0) {
          await (
            channel as { send: (options: { files: { attachment: string }[] }) => Promise<unknown> }
          ).send({
            files: filePaths.map((fp) => ({ attachment: fp })),
          });
        }

        return result;
      } catch (error) {
        if (error instanceof Error && error.message === 'Request cancelled by user') {
          await thinkingMsg.edit('🛑 タスクを停止しました');
        } else {
          await thinkingMsg.edit('❌ エラーが発生しました');
        }
        throw error;
      }
    });
  }

  // Slackボットを起動
  if (config.slack.enabled) {
    await startSlackBot({
      config,
      agentRunner,
      skills,
      reloadSkills: () => {
        skills = loadSkills(workdir);
        return skills;
      },
      scheduler,
    });
    console.log('[xangi] Slack bot started');
  }

  if (!config.discord.enabled && !config.slack.enabled) {
    console.error(
      '[xangi] No chat platform enabled. Set DISCORD_TOKEN or SLACK_BOT_TOKEN/SLACK_APP_TOKEN'
    );
    process.exit(1);
  }

  // スケジューラの全ジョブを開始
  scheduler.startAll(config.scheduler);

  // シャットダウン時にスケジューラを停止
  const shutdown = () => {
    console.log('[xangi] Shutting down scheduler...');
    scheduler.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  skills: Skill[]
): Promise<void> {
  const focusedValue = interaction.options.getFocused().toLowerCase();

  const filtered = skills
    .filter(
      (skill) =>
        skill.name.toLowerCase().includes(focusedValue) ||
        skill.description.toLowerCase().includes(focusedValue)
    )
    .slice(0, 25) // Discord制限: 最大25件
    .map((skill) => ({
      name: `${skill.name} - ${skill.description.slice(0, 50)}`,
      value: skill.name,
    }));

  await interaction.respond(filtered);
}

async function handleSkill(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>,
  channelId: string
) {
  const skillName = interaction.options.getString('name', true);
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `スキル「${skillName}」を実行してください。${args ? `引数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
    });

    setSession(channelId, newSessionId);
    await interaction.editReply(result.slice(0, DISCORD_MAX_LENGTH));
  } catch (error) {
    console.error('[xangi] Error:', error);
    await interaction.editReply('エラーが発生しました');
  }
}

async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>,
  channelId: string,
  skillName: string
) {
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `スキル「${skillName}」を実行してください。${args ? `引数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
    });

    setSession(channelId, newSessionId);
    await interaction.editReply(result.slice(0, DISCORD_MAX_LENGTH));
  } catch (error) {
    console.error('[xangi] Error:', error);
    await interaction.editReply('エラーが発生しました');
  }
}

/**
 * テキストから !discord send コマンドを抽出し、残りのテキストを返す
 * スケジューラプロンプトからコマンドを分離するために使用
 * コードブロック内のコマンドは無視する
 */
function extractDiscordSendFromPrompt(text: string): {
  commands: string[];
  remaining: string;
} {
  const lines = text.split('\n');
  const commands: string[] = [];
  const remainingLines: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      remainingLines.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      remainingLines.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
    if (sendMatch) {
      const firstLineContent = sendMatch[2] ?? '';
      if (firstLineContent.trim() === '') {
        // 暗黙マルチライン: 次のコマンド行まで吸収
        const bodyLines: string[] = [];
        let inBodyCodeBlock = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock = !inBodyCodeBlock;
          }
          if (
            !inBodyCodeBlock &&
            (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines.push(bodyLine);
          i++;
        }
        const fullMessage = bodyLines.join('\n').trim();
        if (fullMessage) {
          commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage}`);
        }
        continue;
      } else {
        // 1行目にテキストあり → 続く行も吸収
        const bodyLines2: string[] = [firstLineContent];
        let inBodyCodeBlock2 = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock2 = !inBodyCodeBlock2;
          }
          if (
            !inBodyCodeBlock2 &&
            (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines2.push(bodyLine);
          i++;
        }
        const fullMessage2 = bodyLines2.join('\n').trimEnd();
        commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage2}`);
        continue;
      }
    }

    remainingLines.push(line);
    i++;
  }

  return { commands, remaining: remainingLines.join('\n') };
}

/**
 * 表示用テキストからコマンド行を除去する（コードブロック内は残す）
 * SYSTEM_COMMAND:, !discord, !schedule で始まる行を除去
 * !discord send の複数行メッセージ（続く行）も除去
 */
function stripCommandsFromDisplay(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();

    // SYSTEM_COMMAND: 行を除去
    if (trimmed.startsWith('SYSTEM_COMMAND:')) {
      i++;
      continue;
    }

    // !discord send の複数行対応: コマンド行と続く行を除去
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#\d+>\s*(.*)/);
    if (sendMatch) {
      // 続く行も除去（次のコマンド行まで）
      i++;
      let inBodyCodeBlock = false;
      while (i < lines.length) {
        const bodyLine = lines[i];
        if (bodyLine.trim().startsWith('```')) {
          inBodyCodeBlock = !inBodyCodeBlock;
        }
        if (
          !inBodyCodeBlock &&
          (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
        ) {
          break;
        }
        i++;
      }
      continue;
    }

    // その他の !discord コマンド行を除去
    if (trimmed.startsWith('!discord ')) {
      i++;
      continue;
    }

    // !schedule コマンド行を除去
    if (trimmed === '!schedule' || trimmed.startsWith('!schedule ')) {
      i++;
      continue;
    }

    result.push(line);
    i++;
  }

  return result.join('\n').trim();
}

async function processPrompt(
  message: Message,
  agentRunner: AgentRunner,
  prompt: string,
  skipPermissions: boolean,
  channelId: string,
  config: ReturnType<typeof loadConfig>
): Promise<string | null> {
  try {
    console.log(`[xangi] Processing message in channel ${channelId}`);
    await message.react('👀').catch(() => {});

    const sessionId = getSession(channelId);
    const useStreaming = config.discord.streaming ?? true;
    const showThinking = config.discord.showThinking ?? true;

    // 最初のメッセージを送信
    const replyMessage = await message.reply('🤔 考え中.');

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
              replyMessage
                .edit((fullText + ' ▌').slice(0, DISCORD_MAX_LENGTH))
                .catch((err) => {
                  console.error('[xangi] Failed to edit message:', err.message);
                })
                .finally(() => {
                  pendingUpdate = false;
                });
            }
          },
        },
        { skipPermissions, sessionId, channelId }
      );
      result = streamResult.result;
      newSessionId = streamResult.sessionId;
    } else {
      // 非ストリーミング or 思考非表示モード
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        replyMessage.edit(`🤔 考え中${dots}`).catch(() => {});
      }, 1000);

      try {
        const runResult = await agentRunner.run(prompt, { skipPermissions, sessionId, channelId });
        result = runResult.result;
        newSessionId = runResult.sessionId;
      } finally {
        clearInterval(thinkingInterval);
      }
    }

    setSession(channelId, newSessionId);
    console.log(
      `[xangi] Response length: ${result.length}, session: ${newSessionId.slice(0, 8)}...`
    );

    // ファイルパスを抽出して添付送信
    const filePaths = extractFilePaths(result);
    const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

    // SYSTEM_COMMAND: 行と !discord / !schedule コマンド行を表示テキストから除去
    // コードブロック内のコマンドは残す（表示用テキストなので消さない）
    const cleanText = stripCommandsFromDisplay(displayText);
    await replyMessage.edit(cleanText.slice(0, DISCORD_MAX_LENGTH) || '✅');

    // AIの応答から SYSTEM_COMMAND: を検知して実行
    handleSettingsFromResponse(result);

    if (filePaths.length > 0 && 'send' in message.channel) {
      try {
        await (
          message.channel as unknown as {
            send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
          }
        ).send({
          files: filePaths.map((fp) => ({ attachment: fp })),
        });
        console.log(`[xangi] Sent ${filePaths.length} file(s) to Discord`);
      } catch (err) {
        console.error('[xangi] Failed to send files:', err);
      }
    }

    // AIの応答を返す（!discord コマンド処理用）
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'Request cancelled by user') {
      console.log('[xangi] Request cancelled by user');
      return null;
    }
    console.error('[xangi] Error:', error);
    await message.reply('エラーが発生しました');
    return null;
  }
}

/**
 * AIの応答から SYSTEM_COMMAND: を検知して実行
 * 形式: SYSTEM_COMMAND:restart / SYSTEM_COMMAND:set key=value
 */
function handleSettingsFromResponse(text: string): void {
  const commands = text.match(/^SYSTEM_COMMAND:(.+)$/gm);
  if (!commands) return;

  for (const cmd of commands) {
    const action = cmd.replace('SYSTEM_COMMAND:', '').trim();

    if (action === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        console.log('[xangi] Restart requested but autoRestart is disabled');
        continue;
      }
      console.log('[xangi] Restart requested by agent, restarting in 1s...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    const setMatch = action.match(/^set\s+(\w+)=(.*)/);
    if (setMatch) {
      const [, key, value] = setMatch;
      if (key === 'autoRestart') {
        const enabled = value === 'true';
        saveSettings({ autoRestart: enabled });
        console.log(`[xangi] autoRestart ${enabled ? 'enabled' : 'disabled'} by agent`);
      }
    }
  }
}

// ─── Schedule Handlers ──────────────────────────────────────────────

async function handleScheduleCommand(
  interaction: ChatInputCommandInteraction,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean }
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  switch (subcommand) {
    case 'add': {
      const input = interaction.options.getString('input', true);
      const parsed = parseScheduleInput(input);
      if (!parsed) {
        await interaction.reply({
          content:
            '❌ 入力を解析できませんでした\n\n' +
            '**対応フォーマット:**\n' +
            '• `30分後 メッセージ` — 相対時間\n' +
            '• `15:00 メッセージ` — 時刻指定\n' +
            '• `毎日 9:00 メッセージ` — 毎日定時\n' +
            '• `毎週月曜 10:00 メッセージ` — 週次\n' +
            '• `cron 0 9 * * * メッセージ` — cron式',
          ephemeral: true,
        });
        return;
      }

      try {
        const targetChannel = parsed.targetChannelId || channelId;
        const schedule = scheduler.add({
          ...parsed,
          channelId: targetChannel,
          platform: 'discord' as Platform,
        });

        const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
        const typeLabel = getTypeLabel(schedule.type, {
          expression: schedule.expression,
          runAt: schedule.runAt,
          channelInfo,
        });

        await interaction.reply(
          `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
        );
      } catch (error) {
        await interaction.reply({
          content: `❌ ${error instanceof Error ? error.message : 'エラーが発生しました'}`,
          ephemeral: true,
        });
      }
      return;
    }

    case 'list': {
      // 全スケジュールを表示（チャンネルでフィルタしない）
      const schedules = scheduler.list();
      const content = formatScheduleList(schedules, schedulerConfig);
      if (content.length <= DISCORD_MAX_LENGTH) {
        await interaction.reply(content);
      } else {
        const chunks = splitMessage(content, DISCORD_SAFE_LENGTH);
        await interaction.reply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      }
      return;
    }

    case 'remove': {
      const id = interaction.options.getString('id', true);
      const removed = scheduler.remove(id);
      await interaction.reply(
        removed ? `🗑️ スケジュール \`${id}\` を削除しました` : `❌ ID \`${id}\` が見つかりません`
      );
      return;
    }

    case 'toggle': {
      const id = interaction.options.getString('id', true);
      const schedule = scheduler.toggle(id);
      if (schedule) {
        const status = schedule.enabled ? '✅ 有効' : '⏸️ 無効';
        await interaction.reply(`${status} に切り替えました: \`${id}\``);
      } else {
        await interaction.reply(`❌ ID \`${id}\` が見つかりません`);
      }
      return;
    }
  }
}

async function handleScheduleMessage(
  message: Message,
  prompt: string,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean }
): Promise<void> {
  const args = prompt.replace(/^!schedule\s*/, '').trim();
  const channelId = message.channel.id;

  // !schedule (引数なし) or !schedule list → 一覧（全件表示）
  if (!args || args === 'list') {
    const schedules = scheduler.list();
    const content = formatScheduleList(schedules, schedulerConfig);
    if (content.length <= DISCORD_MAX_LENGTH) {
      await message.reply(content);
    } else {
      const chunks = splitMessage(content, DISCORD_SAFE_LENGTH);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
    return;
  }

  // !schedule remove <id|番号> [番号2] [番号3] ...
  if (args.startsWith('remove ') || args.startsWith('delete ') || args.startsWith('rm ')) {
    const parts = args.split(/\s+/).slice(1).filter(Boolean);
    if (parts.length === 0) {
      await message.reply('使い方: `!schedule remove <ID または 番号> [番号2] ...`');
      return;
    }

    const schedules = scheduler.list();
    const deletedIds: string[] = [];
    const errors: string[] = [];

    // 番号を大きい順にソート（削除時のずれを防ぐ）
    const targets = parts
      .map((p) => {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
          if (num > schedules.length) {
            errors.push(`番号 ${num} は範囲外`);
            return null;
          }
          return { index: num, id: schedules[num - 1].id };
        }
        return { index: 0, id: p };
      })
      .filter((t): t is { index: number; id: string } => t !== null)
      .sort((a, b) => b.index - a.index); // 大きい番号から削除

    for (const target of targets) {
      if (scheduler.remove(target.id)) {
        deletedIds.push(target.id);
      } else {
        errors.push(`ID ${target.id} が見つからない`);
      }
    }

    const remaining = scheduler.list();
    let response = '';
    if (deletedIds.length > 0) {
      response += `✅ ${deletedIds.length}件削除しました\n\n`;
    }
    if (errors.length > 0) {
      response += `⚠️ エラー: ${errors.join(', ')}\n\n`;
    }
    response += formatScheduleList(remaining, schedulerConfig);
    // 2000文字制限対応
    if (response.length <= DISCORD_MAX_LENGTH) {
      await message.reply(response);
    } else {
      const chunks = splitMessage(response, DISCORD_SAFE_LENGTH);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
    return;
  }

  // !schedule toggle <id|番号>
  if (args.startsWith('toggle ')) {
    const idOrIndex = args.split(/\s+/)[1];
    if (!idOrIndex) {
      await message.reply('使い方: `!schedule toggle <ID または 番号>`');
      return;
    }

    let targetId = idOrIndex;
    const indexNum = parseInt(idOrIndex, 10);
    if (!isNaN(indexNum) && indexNum > 0 && !idOrIndex.startsWith('sch_')) {
      const schedules = scheduler.list(channelId);
      if (indexNum > schedules.length) {
        await message.reply(`❌ 番号 ${indexNum} は範囲外です（1〜${schedules.length}）`);
        return;
      }
      targetId = schedules[indexNum - 1].id;
    }

    const schedule = scheduler.toggle(targetId);
    if (schedule) {
      const status = schedule.enabled ? '✅ 有効化' : '⏸️ 無効化';
      const all = scheduler.list(channelId);
      await message.reply(
        `${status}しました: ${targetId}\n\n${formatScheduleList(all, schedulerConfig)}`
      );
    } else {
      await message.reply(`❌ ID \`${targetId}\` が見つかりません`);
    }
    return;
  }

  // !schedule add <input> or !schedule <input> (addなしでも追加)
  const input = args.startsWith('add ') ? args.replace(/^add\s+/, '') : args;
  const parsed = parseScheduleInput(input);
  if (!parsed) {
    await message.reply(
      '❌ 入力を解析できませんでした\n\n' +
        '**対応フォーマット:**\n' +
        '• `!schedule 30分後 メッセージ`\n' +
        '• `!schedule 15:00 メッセージ`\n' +
        '• `!schedule 毎日 9:00 メッセージ`\n' +
        '• `!schedule 毎週月曜 10:00 メッセージ`\n' +
        '• `!schedule cron 0 9 * * * メッセージ`\n' +
        '• `!schedule list` / `!schedule remove <ID>`'
    );
    return;
  }

  try {
    const targetChannel = parsed.targetChannelId || channelId;
    const schedule = scheduler.add({
      ...parsed,
      channelId: targetChannel,
      platform: 'discord' as Platform,
    });

    const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
    const typeLabel = getTypeLabel(schedule.type, {
      expression: schedule.expression,
      runAt: schedule.runAt,
      channelInfo,
    });

    await message.reply(
      `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
    );
  } catch (error) {
    await message.reply(`❌ ${error instanceof Error ? error.message : 'エラーが発生しました'}`);
  }
}

/**
 * AI応答内の !schedule コマンドを実行
 */
async function executeScheduleFromResponse(
  text: string,
  sourceMessage: Message,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean }
): Promise<void> {
  const args = text.replace(/^!schedule\s*/, '').trim();
  const channelId = sourceMessage.channel.id;
  const channel = sourceMessage.channel;

  // list コマンド（全件表示）
  if (!args || args === 'list') {
    const schedules = scheduler.list();
    const content = formatScheduleList(schedules, schedulerConfig);
    if ('send' in channel) {
      const sendFn = (channel as { send: (content: string) => Promise<unknown> }).send.bind(
        channel
      );
      // 2000文字制限対応: 分割送信
      if (content.length <= DISCORD_MAX_LENGTH) {
        await sendFn(content);
      } else {
        const chunks = splitMessage(content, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await sendFn(chunk);
        }
      }
    }
    return;
  }

  // remove コマンド（複数対応）
  if (args.startsWith('remove ') || args.startsWith('delete ') || args.startsWith('rm ')) {
    const parts = args.split(/\s+/).slice(1).filter(Boolean);
    if (parts.length === 0) return;

    const schedules = scheduler.list();
    const deletedIds: string[] = [];

    // 番号を大きい順にソート（削除時のずれを防ぐ）
    const targets = parts
      .map((p) => {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
          if (num > schedules.length) return null;
          return { index: num, id: schedules[num - 1].id };
        }
        return { index: 0, id: p };
      })
      .filter((t): t is { index: number; id: string } => t !== null)
      .sort((a, b) => b.index - a.index);

    for (const target of targets) {
      if (scheduler.remove(target.id)) {
        deletedIds.push(target.id);
      }
    }

    if ('send' in channel && deletedIds.length > 0) {
      const remaining = scheduler.list();
      const content = `✅ ${deletedIds.length}件削除しました\n\n${formatScheduleList(remaining, schedulerConfig)}`;
      const sendFn = (channel as { send: (content: string) => Promise<unknown> }).send.bind(
        channel
      );
      if (content.length <= DISCORD_MAX_LENGTH) {
        await sendFn(content);
      } else {
        const chunks = splitMessage(content, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await sendFn(chunk);
        }
      }
    }
    return;
  }

  // toggle コマンド
  if (args.startsWith('toggle ')) {
    const idOrIndex = args.split(/\s+/)[1];
    if (!idOrIndex) return;

    let targetId = idOrIndex;
    const indexNum = parseInt(idOrIndex, 10);
    if (!isNaN(indexNum) && indexNum > 0 && !idOrIndex.startsWith('sch_')) {
      const schedules = scheduler.list(channelId);
      if (indexNum > schedules.length) {
        if ('send' in channel) {
          await (channel as { send: (content: string) => Promise<unknown> }).send(
            `❌ 番号 ${indexNum} は範囲外です（1〜${schedules.length}）`
          );
        }
        return;
      }
      targetId = schedules[indexNum - 1].id;
    }

    const schedule = scheduler.toggle(targetId);
    if ('send' in channel) {
      if (schedule) {
        const status = schedule.enabled ? '✅ 有効化' : '⏸️ 無効化';
        const all = scheduler.list(channelId);
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `${status}しました: ${targetId}\n\n${formatScheduleList(all, schedulerConfig)}`
        );
      } else {
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `❌ ID \`${targetId}\` が見つかりません`
        );
      }
    }
    return;
  }

  const input = args.startsWith('add ') ? args.replace(/^add\s+/, '') : args;
  const parsed = parseScheduleInput(input);
  if (!parsed) {
    console.log(`[xangi] Failed to parse schedule input: ${input}`);
    return;
  }

  try {
    const targetChannel = parsed.targetChannelId || channelId;
    const schedule = scheduler.add({
      ...parsed,
      channelId: targetChannel,
      platform: 'discord' as Platform,
    });

    const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
    const typeLabel = getTypeLabel(schedule.type, {
      expression: schedule.expression,
      runAt: schedule.runAt,
      channelInfo,
    });

    if ('send' in channel) {
      await (channel as { send: (content: string) => Promise<unknown> }).send(
        `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
      );
    }
  } catch (error) {
    console.error('[xangi] Failed to add schedule from response:', error);
  }
}

main().catch(console.error);
