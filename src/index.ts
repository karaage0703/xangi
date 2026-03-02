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
  ChannelType,
  ForumChannel,
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
  SCHEDULE_SEPARATOR,
  type Platform,
  type ScheduleType,
} from './scheduler.js';
import { initSessions, getSession, setSession, deleteSession } from './sessions.js';
import {
  initChannelModels,
  getChannelModelConfig,
  getAllChannelModelConfigs,
  isOpusModel,
} from './channel-models.js';
import { RunnerManager } from './runner-manager.js';
import { join } from 'path';

/** メッセージを指定文字数で分割（カスタムセパレータ対応、デフォルトは行単位） */
function splitMessage(text: string, maxLength: number, separator: string = '\n'): string[] {
  const chunks: string[] = [];
  const blocks = text.split(separator);
  let current = '';
  for (const block of blocks) {
    const sep = current ? separator : '';
    if (current.length + sep.length + block.length > maxLength) {
      if (current) chunks.push(current.trim());
      // 単一ブロックがmaxLengthを超える場合は行単位でフォールバック
      if (block.length > maxLength) {
        const lines = block.split('\n');
        current = '';
        for (const line of lines) {
          if (current.length + line.length + 1 > maxLength) {
            if (current) chunks.push(current.trim());
            current = line;
          } else {
            current += (current ? '\n' : '') + line;
          }
        }
      } else {
        current = block;
      }
    } else {
      current += sep + block;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

/** スケジュール一覧をDiscord向けに分割する */
function splitScheduleContent(content: string, maxLength: number): string[] {
  const sep = '\n' + SCHEDULE_SEPARATOR + '\n';
  const chunks = splitMessage(content, maxLength, sep);
  return chunks.map((c) => c.replaceAll(SCHEDULE_SEPARATOR, ''));
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

  // チャンネルモデル設定を初期化
  initChannelModels(dataDir);

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
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('チャンネルごとのモデル設定')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('このチャンネルのモデルを設定')
          .addStringOption((opt) =>
            opt
              .setName('model')
              .setDescription('モデル名 (sonnet, opus, haiku)')
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('effort')
              .setDescription('Thinking effort (Opus only: low, medium, high)')
              .setRequired(false)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub.setName('show').setDescription('このチャンネルの現在のモデル設定を表示')
      )
      .addSubcommand((sub) =>
        sub.setName('reset').setDescription('このチャンネルのモデル設定をデフォルトに戻す')
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('全チャンネルのモデル設定一覧を表示')
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
      if (interaction.commandName === 'model') {
        await handleModelAutocomplete(interaction);
        return;
      }
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

    if (interaction.commandName === 'model') {
      await handleModelCommand(interaction, agentRunner, config);
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

  /**
   * メッセージコンテンツ内のチャンネルメンション <#ID> を無害化する
   * fetchChannelMessages() による意図しない二重展開を防ぐ
   */
  function sanitizeChannelMentions(content: string): string {
    return content.replace(/<#(\d+)>/g, '#$1');
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
  // feedback: true の場合、response をDiscordに送信せずエージェントに再注入する
  async function handleDiscordCommand(
    text: string,
    sourceMessage?: Message,
    fallbackChannelId?: string
  ): Promise<{ handled: boolean; response?: string; feedback?: boolean }> {
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
          // Send success indicator to source channel
          if (sourceMessage && 'send' in sourceMessage.channel) {
            await (
              sourceMessage.channel as {
                send: (content: string) => Promise<unknown>;
              }
            ).send('送信しました');
          }
          return { handled: true };
        }
      } catch (err) {
        console.error(`[xangi] Failed to send message to channel: ${channelId}`, err);
        // Send deny indicator to source channel
        if (sourceMessage && 'send' in sourceMessage.channel) {
          await (
            sourceMessage.channel as {
              send: (content: string) => Promise<unknown>;
            }
          ).send('チャンネルへの送信に失敗しました');
        }
        return { handled: true };
      }
    }

    // !discord forum-send <#threadId> message (send to an existing forum thread)
    const forumSendMatch = text.match(/^!discord\s+forum-send\s+<#(\d+)>\s+(.+)$/s);
    if (forumSendMatch) {
      const [, threadId, content] = forumSendMatch;
      try {
        const thread = await client.channels.fetch(threadId);
        if (thread && thread.isThread() && 'send' in thread) {
          const chunks = chunkDiscordMessage(content);
          for (const chunk of chunks) {
            await thread.send({
              content: chunk,
              allowedMentions: { parse: [] },
            });
          }
          const threadName = thread.name || 'unknown';
          console.log(
            `[xangi] Sent message to forum thread "${threadName}" (${chunks.length} chunk(s))`
          );
          if (sourceMessage && 'send' in sourceMessage.channel) {
            await (
              sourceMessage.channel as {
                send: (content: string) => Promise<unknown>;
              }
            ).send(`フォーラムスレッド「${threadName}」に送信しました`);
          }
          return { handled: true };
        } else {
          const errMsg = '❌ 指定されたIDはスレッドではありません';
          if (sourceMessage && 'send' in sourceMessage.channel) {
            await (sourceMessage.channel as { send: (content: string) => Promise<unknown> }).send(
              errMsg
            );
          }
          return { handled: true };
        }
      } catch (err) {
        console.error(`[xangi] Failed to send message to forum thread: ${threadId}`, err);
        if (sourceMessage && 'send' in sourceMessage.channel) {
          await (
            sourceMessage.channel as {
              send: (content: string) => Promise<unknown>;
            }
          ).send('フォーラムスレッドへの送信に失敗しました');
        }
        return { handled: true };
      }
    }

    // !discord forum-create <#forumChannelId> title\nbody (create a new forum thread)
    const forumCreateMatch = text.match(/^!discord\s+forum-create\s+<#(\d+)>\s+(.+)$/s);
    if (forumCreateMatch) {
      const [, forumChannelId, rest] = forumCreateMatch;
      // First line = title, remaining lines = body
      const lines = rest.split('\n');
      const title = lines[0].trim();
      const body = lines.slice(1).join('\n').trim() || title;
      try {
        const channel = await client.channels.fetch(forumChannelId);
        if (channel && channel.type === ChannelType.GuildForum) {
          const forumChannel = channel as ForumChannel;
          await forumChannel.threads.create({
            name: title,
            message: { content: body },
          });
          console.log(`[xangi] Created forum thread "${title}" in ${forumChannel.name}`);
          if (sourceMessage && 'send' in sourceMessage.channel) {
            await (
              sourceMessage.channel as {
                send: (content: string) => Promise<unknown>;
              }
            ).send(`フォーラムスレッド「${title}」を作成しました`);
          }
          return { handled: true };
        } else {
          const errMsg = '❌ 指定されたIDはフォーラムチャンネルではありません';
          if (sourceMessage && 'send' in sourceMessage.channel) {
            await (sourceMessage.channel as { send: (content: string) => Promise<unknown> }).send(
              errMsg
            );
          }
          return { handled: true };
        }
      } catch (err) {
        console.error(`[xangi] Failed to create forum thread in channel: ${forumChannelId}`, err);
        if (sourceMessage && 'send' in sourceMessage.channel) {
          await (
            sourceMessage.channel as {
              send: (content: string) => Promise<unknown>;
            }
          ).send('フォーラムスレッドの作成に失敗しました');
        }
        return { handled: true };
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
          const textChannels = guild.channels.cache
            .filter((c) => c.type === ChannelType.GuildText)
            .map((c) => `- #${c.name} (<#${c.id}>)`)
            .join('\n');
          const forumChannels = guild.channels.cache
            .filter((c) => c.type === ChannelType.GuildForum)
            .map((c) => `- 📋 #${c.name} (<#${c.id}>) [フォーラム]`)
            .join('\n');
          const channelList = forumChannels
            ? `📺 テキストチャンネル:\n${textChannels}\n\n📋 フォーラムチャンネル:\n${forumChannels}`
            : `📺 チャンネル一覧:\n${textChannels}`;
          return { handled: true, response: channelList };
        }
      } catch (err) {
        console.error(`[xangi] Failed to list channels`, err);
        return { handled: true, response: `❌ チャンネル一覧の取得に失敗しました` };
      }
    }

    // !discord history [件数] [offset:N] [チャンネルID]
    const historyMatch = text.match(
      /^!discord\s+history(?:\s+(\d+))?(?:\s+offset:(\d+))?(?:\s+<#(\d+)>)?$/
    );
    if (historyMatch) {
      const count = Math.min(parseInt(historyMatch[1] || '10', 10), 100);
      const offset = parseInt(historyMatch[2] || '0', 10);
      const targetChannelId = historyMatch[3];
      try {
        let targetChannel;
        if (targetChannelId) {
          targetChannel = await client.channels.fetch(targetChannelId);
        } else if (sourceMessage) {
          targetChannel = sourceMessage.channel;
        } else if (fallbackChannelId) {
          targetChannel = await client.channels.fetch(fallbackChannelId);
        }

        if (targetChannel && 'messages' in targetChannel) {
          let beforeId: string | undefined;

          // offset指定時: まずoffset分のメッセージを取得してスキップ
          if (offset > 0) {
            const skipMessages = await targetChannel.messages.fetch({ limit: offset });
            if (skipMessages.size > 0) {
              beforeId = skipMessages.lastKey();
            }
          }

          const fetchOptions: { limit: number; before?: string } = { limit: count };
          if (beforeId) {
            fetchOptions.before = beforeId;
          }
          const messages = await targetChannel.messages.fetch(fetchOptions);
          const channelName = 'name' in targetChannel ? targetChannel.name : 'unknown';

          const rangeStart = offset;
          const rangeEnd = offset + messages.size;
          const messageList = messages
            .reverse()
            .map((m) => {
              const time = m.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
              const content = sanitizeChannelMentions(
                (m.content || '(添付ファイルのみ)').slice(0, 200)
              );
              return `[${time}] ${m.author.tag}: ${content}`;
            })
            .join('\n');

          const offsetLabel =
            offset > 0 ? `${rangeStart}〜${rangeEnd}件目` : `最新${messages.size}件`;
          console.log(
            `[xangi] Fetched ${messages.size} history messages from #${channelName} (offset: ${offset})`
          );
          return {
            handled: true,
            feedback: true,
            response: `📺 #${channelName} のチャンネル履歴（${offsetLabel}）:\n${messageList}`,
          };
        }

        if (!sourceMessage && !targetChannelId && !fallbackChannelId) {
          return {
            handled: true,
            feedback: true,
            response:
              '⚠️ history コマンドはチャンネルIDを指定してください（例: !discord history 20 <#123>）',
          };
        }
        return { handled: true, feedback: true, response: '❌ チャンネルが見つかりません' };
      } catch (err) {
        console.error(`[xangi] Failed to fetch history`, err);
        return { handled: true, feedback: true, response: '❌ 履歴の取得に失敗しました' };
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
              ?.map((m) => {
                const time = m.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                return `[${time}] ${m.author.tag}: ${sanitizeChannelMentions(m.content.slice(0, 200))}`;
              })
              .join('\n');
            return {
              handled: true,
              feedback: true,
              response: `🔍 「${keyword}」の検索結果 (${matched.size}件):\n${results}`,
            };
          }
        }
        return {
          handled: true,
          feedback: true,
          response: `🔍 「${keyword}」に一致するメッセージが見つかりませんでした`,
        };
      } catch (err) {
        console.error(`[xangi] Failed to search messages`, err);
        return { handled: true, response: `❌ 検索に失敗しました` };
      }
    }

    // !discord delete <messageId or link>
    const deleteMatch = text.match(/^!discord\s+delete\s+(.+)$/);
    if (deleteMatch) {
      const arg = deleteMatch[1].trim();

      try {
        let messageId: string;
        let targetChannelId: string | undefined;

        // メッセージリンクからチャンネルIDとメッセージIDを抽出
        const linkMatch = arg.match(/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/);
        if (linkMatch) {
          targetChannelId = linkMatch[1];
          messageId = linkMatch[2];
        } else if (/^\d+$/.test(arg)) {
          messageId = arg;
        } else {
          return {
            handled: true,
            feedback: true,
            response: '❌ 無効な形式です。メッセージIDまたはリンクを指定してください',
          };
        }

        // リンクからチャンネルIDが取れた場合はそのチャンネルを使う、なければ現在のチャンネル
        let channel;
        if (targetChannelId) {
          channel = await client.channels.fetch(targetChannelId);
        } else if (sourceMessage) {
          channel = sourceMessage.channel;
        } else if (fallbackChannelId) {
          channel = await client.channels.fetch(fallbackChannelId);
        }

        if (channel && 'messages' in channel) {
          const msg = await channel.messages.fetch(messageId);
          // 自分のメッセージのみ削除可能
          if (msg.author.id !== client.user?.id) {
            return {
              handled: true,
              feedback: true,
              response: '❌ 自分のメッセージのみ削除できます',
            };
          }
          await msg.delete();
          const deletedChannelId =
            targetChannelId || sourceMessage?.channel.id || fallbackChannelId;
          console.log(`[xangi] Deleted message ${messageId} in channel ${deletedChannelId}`);
          return { handled: true, feedback: true, response: '🗑️ メッセージを削除しました' };
        }
        return {
          handled: true,
          feedback: true,
          response: '❌ このチャンネルではメッセージを削除できません',
        };
      } catch (err) {
        console.error(`[xangi] Failed to delete message:`, err);
        return { handled: true, feedback: true, response: '❌ メッセージの削除に失敗しました' };
      }
    }

    return { handled: false };
  }

  /**
   * AIの応答から !discord コマンドを検知して実行
   * コードブロック内のコマンドは無視する
   * !discord send は複数行メッセージに対応（次の !discord / !schedule コマンド行まで吸収）
   * feedback: true のコマンド結果はDiscordに送信せずフィードバック配列に収集して返す
   */
  async function handleDiscordCommandsInResponse(
    text: string,
    sourceMessage?: Message,
    fallbackChannelId?: string
  ): Promise<string[]> {
    const lines = text.split('\n');
    let inCodeBlock = false;
    let i = 0;
    const feedbackResults: string[] = [];

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

      // !discord send / forum-send / forum-create の複数行対応
      const sendMatch = trimmed.match(
        /^!discord\s+(send|forum-send|forum-create)\s+<#(\d+)>\s*(.*)/
      );
      if (sendMatch) {
        const [, cmdType, channelId, firstLineContent] = sendMatch;
        const restContent = firstLineContent ?? '';

        if (restContent.trim() === '') {
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
            const commandText = `!discord ${cmdType} <#${channelId}> ${fullMessage}`;
            console.log(
              `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
            );
            const result = await handleDiscordCommand(
              commandText,
              sourceMessage,
              fallbackChannelId
            );
            if (result.handled && result.response) {
              if (result.feedback) {
                feedbackResults.push(result.response);
              } else if (sourceMessage) {
                const channel = sourceMessage.channel;
                if (
                  'send' in channel &&
                  typeof (channel as { send?: unknown }).send === 'function'
                ) {
                  await (channel as { send: (content: string) => Promise<unknown> }).send(
                    result.response
                  );
                }
              }
            }
          }
          continue; // i は既に次のコマンド行を指している
        } else {
          // 1行目にテキストあり → 続く行も吸収（次のコマンド行まで）
          const bodyLines: string[] = [restContent];
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
          const commandText = `!discord ${cmdType} <#${channelId}> ${fullMessage}`;
          console.log(
            `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
          );
          const result = await handleDiscordCommand(commandText, sourceMessage, fallbackChannelId);
          if (result.handled && result.response) {
            if (result.feedback) {
              feedbackResults.push(result.response);
            } else if (sourceMessage) {
              const channel = sourceMessage.channel;
              if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
                await (channel as { send: (content: string) => Promise<unknown> }).send(
                  result.response
                );
              }
            }
          }
          continue;
        }
      }

      // その他の !discord コマンド（channels, search, history）
      if (trimmed.startsWith('!discord ')) {
        console.log(`[xangi] Processing discord command from response: ${trimmed.slice(0, 50)}...`);
        const result = await handleDiscordCommand(trimmed, sourceMessage, fallbackChannelId);
        if (result.handled && result.response) {
          if (result.feedback) {
            feedbackResults.push(result.response);
          } else if (sourceMessage) {
            const channel = sourceMessage.channel;
            if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
              await (channel as { send: (content: string) => Promise<unknown> }).send(
                result.response
              );
            }
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

    return feedbackResults;
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
    // If the message is in a forum thread, check if the parent forum channel is in autoReplyChannels
    const isAutoReplyForumThread =
      !isAutoReplyChannel &&
      message.channel.isThread() &&
      message.channel.parentId != null &&
      (config.discord.autoReplyChannels?.includes(message.channel.parentId) ?? false);

    if (!isMentioned && !isDM && !isAutoReplyChannel && !isAutoReplyForumThread) return;

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
        if (result.feedback && result.response) {
          // feedback結果はエージェントのコンテキストに注入
          // → 元のコマンドと結果を合わせてプロンプトに流す
          prompt = `ユーザーが「${prompt}」を実行しました。以下がその結果です。この情報を踏まえてユーザーに返答してください。\n\n${result.response}`;
          // processPromptに流す（下に続く）
        } else {
          if (result.response && 'send' in message.channel) {
            await message.channel.send(result.response);
          }
          return;
        }
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
        const feedbackResults = await handleDiscordCommandsInResponse(result, message);

        // フィードバック結果があればエージェントに再注入
        if (feedbackResults.length > 0) {
          const feedbackPrompt = `あなたが実行したコマンドの結果が返ってきました。この情報を踏まえて、元の会話の文脈に沿ってユーザーに返答してください。\n\n${feedbackResults.join('\n\n')}`;
          console.log(`[xangi] Re-injecting ${feedbackResults.length} feedback result(s) to agent`);
          const feedbackResult = await processPrompt(
            message,
            agentRunner,
            feedbackPrompt,
            skipPermissions,
            channelId,
            config
          );
          // 再注入後の応答にもコマンドがあれば処理（ただし再帰は1回のみ）
          if (feedbackResult) {
            await handleDiscordCommandsInResponse(feedbackResult, message);
          }
        }
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
        await handleDiscordCommand(cmd, undefined, channelId);
      }

      // !discord send 以外のテキストが残っていればAIに渡す
      const remainingPrompt = promptCommands.remaining.trim();
      if (!remainingPrompt) {
        // コマンドのみのプロンプトだった場合、AIは不要
        console.log('[scheduler] Prompt contained only discord commands, skipping agent');
        return promptCommands.commands.map((c) => `✅ ${c.slice(0, 50)}`).join('\n');
      }

      // 処理中メッセージを送信（通常テキスト）
      type MsgOptions = string | { content?: string };
      const thinkingMsg = await (
        channel as {
          send: (
            options: MsgOptions
          ) => Promise<{ edit: (options: MsgOptions) => Promise<unknown> }>;
        }
      ).send({
        content: '解。マスターからの指示を確認。間もなく応答を開始します...',
      });

      try {
        const sessionId = getSession(channelId);
        const { result, sessionId: newSessionId } = await agentRunner.run(remainingPrompt, {
          skipPermissions: config.agent.config.skipPermissions ?? false,
          sessionId,
          channelId,
        });

        setSession(channelId, newSessionId);

        // AI応答内の !discord コマンドを処理（sourceMessage なし、channelIdをフォールバック）
        const feedbackResults = await handleDiscordCommandsInResponse(result, undefined, channelId);

        // フィードバック結果があればエージェントに再注入
        if (feedbackResults.length > 0) {
          const feedbackPrompt = `あなたが実行したコマンドの結果が返ってきました。この情報を踏まえて、元の会話の文脈に沿ってユーザーに返答してください。\n\n${feedbackResults.join('\n\n')}`;
          console.log(
            `[scheduler] Re-injecting ${feedbackResults.length} feedback result(s) to agent`
          );
          const feedbackSession = getSession(channelId);
          const feedbackRun = await agentRunner.run(feedbackPrompt, {
            skipPermissions: config.agent.config.skipPermissions ?? false,
            sessionId: feedbackSession,
            channelId,
          });
          setSession(channelId, feedbackRun.sessionId);
          // 再注入後の応答にもコマンドがあれば処理
          await handleDiscordCommandsInResponse(feedbackRun.result, undefined, channelId);
        }

        // 結果を送信
        const filePaths = extractFilePaths(result);
        const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

        // 2000文字超の応答は分割送信（最初のチャンクに「解」Embed付き）
        const textChunks = splitMessage(displayText, DISCORD_SAFE_LENGTH);
        await thinkingMsg.edit({
          content: textChunks[0] || '',
        });
        if (textChunks.length > 1) {
          const ch = channel as { send: (content: string) => Promise<unknown> };
          for (let i = 1; i < textChunks.length; i++) {
            await ch.send(textChunks[i]);
          }
        }

        if (filePaths.length > 0) {
          await (
            channel as {
              send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
            }
          ).send({
            files: filePaths.map((fp) => ({ attachment: fp })),
          });
        }

        // 完了通知（メンション付き新規メッセージで通知を飛ばす）
        const notifyUserId = config.discord.allowedUsers?.[0];
        if (notifyUserId) {
          await (channel as { send: (content: string) => Promise<unknown> }).send(
            `<@${notifyUserId}> スケジュール実行が完了しました。`
          );
        }

        return result;
      } catch (error) {
        if (error instanceof Error && error.message === 'Request cancelled by user') {
          await thinkingMsg.edit({
            content: 'タスクを停止しました',
          });
        } else {
          await thinkingMsg.edit({
            content: 'エラーが発生しました',
          });
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
    const chunks = splitMessage(result, DISCORD_SAFE_LENGTH);
    await interaction.editReply(chunks[0] || '✅');
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
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
    const chunks = splitMessage(result, DISCORD_SAFE_LENGTH);
    await interaction.editReply(chunks[0] || '✅');
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
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
    const sendMatch = trimmed.match(/^!discord\s+(send|forum-send|forum-create)\s+<#(\d+)>\s*(.*)/);
    if (sendMatch) {
      const [, cmdType, chId] = sendMatch;
      const firstLineContent = sendMatch[3] ?? '';
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
          commands.push(`!discord ${cmdType} <#${chId}> ${fullMessage}`);
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
        commands.push(`!discord ${cmdType} <#${chId}> ${fullMessage2}`);
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

    // !discord send/forum-send/forum-create の複数行対応: コマンド行と続く行を除去
    const sendMatch = trimmed.match(/^!discord\s+(?:send|forum-send|forum-create)\s+<#\d+>\s*(.*)/);
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
    // チャンネル情報をプロンプトに付与
    const channelName =
      'name' in message.channel ? (message.channel as { name: string }).name : null;
    if (channelName) {
      prompt = `[チャンネル: #${channelName} (ID: ${channelId})]\n${prompt}`;
    }

    console.log(`[xangi] Processing message in channel ${channelId}`);
    await message.react('👀').catch(() => {});

    const sessionId = getSession(channelId);
    const useStreaming = config.discord.streaming ?? true;
    const showThinking = config.discord.showThinking ?? true;

    // 最初のメッセージを送信（通常テキスト）
    const replyMessage = await message.reply({
      content: '解。マスターからの指示を確認。間もなく応答を開始します...',
    });

    let result: string;
    let newSessionId: string;

    if (useStreaming && showThinking) {
      // ストリーミング + 思考表示モード
      let lastUpdateTime = 0;
      let pendingUpdate = false;
      let firstTextReceived = false;

      // 最初のテキストが届くまで考え中アニメーション
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        if (firstTextReceived) return;
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        replyMessage
          .edit({
            content: `解。マスターからの指示を確認。間もなく応答を開始します${dots}`,
          })
          .catch(() => {});
      }, 1000);

      const streamResult = await agentRunner.runStream(
        prompt,
        {
          onText: (_chunk, fullText) => {
            if (!firstTextReceived) {
              firstTextReceived = true;
              clearInterval(thinkingInterval);
            }
            const now = Date.now();
            if (now - lastUpdateTime >= STREAM_UPDATE_INTERVAL_MS && !pendingUpdate) {
              pendingUpdate = true;
              lastUpdateTime = now;
              replyMessage
                .edit({
                  content: (fullText + ' ▌').slice(0, DISCORD_MAX_LENGTH),
                })
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
      clearInterval(thinkingInterval);
      result = streamResult.result;
      newSessionId = streamResult.sessionId;
    } else {
      // 非ストリーミング or 思考非表示モード
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        replyMessage
          .edit({
            content: `解。マスターからの指示を確認。間もなく応答を開始します${dots}`,
          })
          .catch(() => {});
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

    // 2000 characters exceeded: split into multiple messages
    const chunks = splitMessage(cleanText, DISCORD_SAFE_LENGTH);
    await replyMessage.edit({
      content: chunks[0] || '',
    });
    if (chunks.length > 1 && 'send' in message.channel) {
      const channel = message.channel as unknown as {
        send: (content: string) => Promise<unknown>;
      };
      for (let i = 1; i < chunks.length; i++) {
        await channel.send(chunks[i]);
      }
    }

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

    // 完了通知（メンション付き新規メッセージで通知を飛ばす）
    if ('send' in message.channel) {
      const userId = message.author.id;
      await (
        message.channel as unknown as {
          send: (content: string) => Promise<unknown>;
        }
      ).send(`<@${userId}> 告。応答が完了しています。`);
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
  } finally {
    // 👀 リアクションを削除
    await message.reactions.cache
      .find((r) => r.emoji.name === '👀')
      ?.users.remove(message.client.user?.id)
      .catch((err) => {
        console.error('[xangi] Failed to remove 👀 reaction:', err.message || err);
      });
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

// ─── Model Command Handlers ─────────────────────────────────────────

const MODEL_CHOICES = ['sonnet', 'opus', 'haiku'];
const EFFORT_CHOICES = ['low', 'medium', 'high'];

async function handleModelAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const value = focused.value.toLowerCase();

  if (focused.name === 'model') {
    const filtered = MODEL_CHOICES.filter((m) => m.includes(value)).map((m) => ({
      name: m,
      value: m,
    }));
    await interaction.respond(filtered);
  } else if (focused.name === 'effort') {
    const filtered = EFFORT_CHOICES.filter((e) => e.includes(value)).map((e) => ({
      name: e,
      value: e,
    }));
    await interaction.respond(filtered);
  }
}

async function handleModelCommand(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  switch (subcommand) {
    case 'set': {
      const model = interaction.options.getString('model', true);
      const effort = interaction.options.getString('effort') || undefined;

      // Validate effort: only allowed for Opus models
      if (effort && !isOpusModel(model)) {
        await interaction.reply({
          content: `effort オプションは Opus 系モデルでのみ使用できます（指定: ${model}）`,
          ephemeral: true,
        });
        return;
      }

      // Validate effort value
      if (effort && !EFFORT_CHOICES.includes(effort)) {
        await interaction.reply({
          content: `無効な effort 値です: ${effort}（有効: ${EFFORT_CHOICES.join(', ')}）`,
          ephemeral: true,
        });
        return;
      }

      if (!(agentRunner instanceof RunnerManager)) {
        await interaction.reply({
          content: 'モデル切り替えは persistent モードでのみ利用可能です',
          ephemeral: true,
        });
        return;
      }

      const channelConfig = effort ? { model, effort } : { model };
      agentRunner.updateChannelConfig(channelId, channelConfig);

      const effortLabel = effort ? ` (effort: ${effort})` : '';
      await interaction.reply(`モデルを ${model}${effortLabel} に変更しました`);
      return;
    }

    case 'show': {
      const channelConfig = getChannelModelConfig(channelId);
      const defaultModel = config.agent.config.model || '(未設定)';
      const defaultEffort = config.agent.config.effort;

      if (channelConfig) {
        const model = channelConfig.model || defaultModel;
        const effort = channelConfig.effort;
        const effortLabel = effort ? ` / effort: ${effort}` : '';
        await interaction.reply(
          `このチャンネルのモデル設定: ${model}${effortLabel}\nデフォルト: ${defaultModel}${defaultEffort ? ` / effort: ${defaultEffort}` : ''}`
        );
      } else {
        await interaction.reply(
          `このチャンネルにはカスタム設定がありません\nデフォルト: ${defaultModel}${defaultEffort ? ` / effort: ${defaultEffort}` : ''}`
        );
      }
      return;
    }

    case 'reset': {
      if (!(agentRunner instanceof RunnerManager)) {
        await interaction.reply({
          content: 'モデル切り替えは persistent モードでのみ利用可能です',
          ephemeral: true,
        });
        return;
      }

      const deleted = agentRunner.resetChannelConfig(channelId);
      if (deleted) {
        await interaction.reply('このチャンネルのモデル設定をデフォルトに戻しました');
      } else {
        await interaction.reply({
          content: 'このチャンネルにはカスタム設定がありません',
          ephemeral: true,
        });
      }
      return;
    }

    case 'list': {
      const allConfigs = getAllChannelModelConfigs();
      if (allConfigs.size === 0) {
        await interaction.reply('チャンネル固有のモデル設定はありません');
        return;
      }

      const lines: string[] = [];
      for (const [chId, cfg] of allConfigs) {
        const model = cfg.model || '(default)';
        const effort = cfg.effort ? ` / effort: ${cfg.effort}` : '';
        lines.push(`- <#${chId}>: ${model}${effort}`);
      }
      await interaction.reply(`チャンネルモデル設定一覧:\n${lines.join('\n')}`);
      return;
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
        await interaction.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
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
      await message.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
    } else {
      const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
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
      await message.reply(response.replaceAll(SCHEDULE_SEPARATOR, ''));
    } else {
      const chunks = splitScheduleContent(response, DISCORD_SAFE_LENGTH);
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
      const listContent = formatScheduleList(all, schedulerConfig).replaceAll(
        SCHEDULE_SEPARATOR,
        ''
      );
      await message.reply(`${status}しました: ${targetId}\n\n${listContent}`);
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
        await sendFn(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
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
        await sendFn(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
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
        const listContent = formatScheduleList(all, schedulerConfig).replaceAll(
          SCHEDULE_SEPARATOR,
          ''
        );
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `${status}しました: ${targetId}\n\n${listContent}`
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
