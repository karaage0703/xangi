import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  Interaction,
} from 'discord.js';
import {
  ALL_AGENT_BACKENDS,
  type Config,
  type AgentBackend,
  type EffortLevel,
  type DiscordCompletionNotifyMode,
} from '../config.js';
import { getBackendDisplayName, type AgentRunner } from '../agent-runner.js';
import type { BackendResolver } from '../backend-resolver.js';
import type { DynamicRunnerManager } from '../dynamic-runner.js';
import { ClaudeCodeRunner } from '../claude-code.js';
import { formatAgentErrorForUser } from '../errors.js';
import { processManager } from '../process-manager.js';
import { resolveApproval } from '../approval.js';
import { loadSkills, formatSkillList, type Skill } from '../skills.js';
import {
  getChannelCompletionNotifyMode,
  loadSettings,
  formatSettings,
  saveSettings,
} from '../settings.js';
import { updateEnvKeyValue } from '../env-persist.js';
import { getSession, setSession, deleteSession, ensureSession } from '../sessions.js';
import { splitMessage } from '../message-split.js';
import { DISCORD_MAX_LENGTH, DISCORD_SAFE_LENGTH } from '../constants.js';
import { buildAttachmentResult } from '../file-utils.js';
import {
  Scheduler,
  parseScheduleInput,
  formatScheduleList,
  SCHEDULE_SEPARATOR,
  type Platform,
  type ScheduleType,
} from '../scheduler.js';
import { discordToolHistoryByMessageId } from './ui.js';

/** スキル一覧を保持する可変参照。`/skills` での再読込を呼び出し元と共有する */
export interface SkillsRef {
  current: Skill[];
}

const DISCORD_APPLICATION_COMMAND_LIMIT = 100;

const BACKEND_CHOICE_LABELS: Record<AgentBackend, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  grok: 'Grok',
  'local-llm': 'Local LLM',
};

function getBackendChoices(config: Config): { name: string; value: AgentBackend }[] {
  const allowedBackends = config.agent?.allowedBackends ?? [...ALL_AGENT_BACKENDS];
  return allowedBackends.map((backend) => ({
    name: BACKEND_CHOICE_LABELS[backend],
    value: backend,
  }));
}

/** スキル名を Discord コマンド名に変換（小文字英数字とハイフンのみ、最大32文字） */
function skillCommandName(skillName: string): string {
  return skillName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
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

/**
 * スラッシュコマンド定義を構築する（基本コマンド + 設定で有効化される
 * オプションコマンド + スキルごとの個別コマンド）
 */
export function buildSlashCommands(
  config: Config,
  skills: Skill[]
): ReturnType<SlashCommandBuilder['toJSON']>[] {
  const backendChoices = getBackendChoices(config);
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
    new SlashCommandBuilder()
      .setName('notify')
      .setDescription('このチャンネルの完了通知を設定する')
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('通知モード')
          .setRequired(true)
          .addChoices(
            { name: 'show (現在の設定を表示)', value: 'show' },
            { name: 'default (起動時設定に戻す)', value: 'default' },
            { name: 'off (通知しない)', value: 'off' },
            { name: 'message (完了メッセージのみ)', value: 'message' },
            { name: 'mention (依頼者にメンション)', value: 'mention' }
          )
      )
      .toJSON(),
    new SlashCommandBuilder().setName('restart').setDescription('ボットを再起動する').toJSON(),
    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('許可確認をスキップしてメッセージを実行')
      .addStringOption((option) =>
        option.setName('message').setDescription('実行するメッセージ').setRequired(true)
      )
      .toJSON(),
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
      .setName('backend')
      .setDescription('バックエンド/モデルの切り替え')
      .addSubcommand((sub) => sub.setName('show').setDescription('現在のバックエンド設定を表示'))
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('バックエンド/モデルを設定')
          .addStringOption((opt) =>
            opt
              .setName('type')
              .setDescription('バックエンド名')
              .setRequired(true)
              .addChoices(...backendChoices)
          )
          .addStringOption((opt) => opt.setName('model').setDescription('モデル名'))
          .addStringOption((opt) =>
            opt
              .setName('effort')
              .setDescription('effortレベル（Claude Code用）')
              .addChoices(
                { name: 'デフォルト', value: 'none' },
                { name: 'low', value: 'low' },
                { name: 'medium', value: 'medium' },
                { name: 'high', value: 'high' },
                { name: 'max', value: 'max' }
              )
          )
      )
      .addSubcommand((sub) => sub.setName('reset').setDescription('デフォルトに戻す'))
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('利用可能なバックエンド一覧を表示')
      )
      .toJSON(),
  ];

  // ALLOW_AUTOREPLY_COMMAND=true の場合のみコマンドを登録
  if (config.discord.allowAutoreplyCommand) {
    commands.push(
      new SlashCommandBuilder()
        .setName('autoreply')
        .setDescription('このチャンネルのメンションなし応答を切り替え')
        .toJSON()
    );
  }

  // ALLOW_RESPOND_TO_BOTS_COMMAND=true の場合のみコマンドを登録
  if (config.discord.allowRespondToBotsCommand) {
    commands.push(
      new SlashCommandBuilder()
        .setName('respondtobots')
        .setDescription(
          'bot メッセージへの応答を ON/OFF 切替 (反応対象は RESPOND_TO_BOTS 環境変数)'
        )
        .toJSON()
    );
  }

  // ALLOW_LLM_MODE_COMMAND=true の場合のみコマンドを登録（Local LLM 動作モード切替）
  if (config.discord.allowLlmModeCommand) {
    commands.push(
      new SlashCommandBuilder()
        .setName('llmmode')
        .setDescription(
          'このチャンネルの Local LLM 動作モードを切替 (agent/lite/chat/default/show)'
        )
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('モード')
            .setRequired(true)
            .addChoices(
              { name: 'agent (全機能ON、複雑タスク向け)', value: 'agent' },
              { name: 'lite (skills OFF、軽量、Discord 操作向け)', value: 'lite' },
              { name: 'chat (全機能OFF、純粋会話)', value: 'chat' },
              { name: 'default (チャンネル override 削除、起動時値に戻す)', value: 'default' },
              { name: 'show (現在の設定を表示)', value: 'show' }
            )
        )
        .toJSON()
    );
  }

  // 各スキルを個別のスラッシュコマンドとして追加
  let skippedSkillCommands = 0;
  for (const skill of skills) {
    if (commands.length >= DISCORD_APPLICATION_COMMAND_LIMIT) {
      skippedSkillCommands += 1;
      continue;
    }

    // Discordコマンド名は小文字英数字とハイフンのみ（最大32文字）
    const cmdName = skillCommandName(skill.name);

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
  if (skippedSkillCommands > 0) {
    console.warn(
      `[xangi] Skipped ${skippedSkillCommands} skill slash command(s) to stay within Discord's ${DISCORD_APPLICATION_COMMAND_LIMIT} command limit. Use /skill for omitted skills.`
    );
  }

  return commands;
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

/** スキル実行プロンプトをエージェントに投げて結果を返信する（/skill と個別スキルコマンド共通） */
async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: Config,
  channelId: string,
  skillName: string
) {
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `スキル「${skillName}」を実行してください。${args ? `引数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const appSessionId = ensureSession(channelId, { platform: 'discord' });
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
      appSessionId,
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

export interface InteractionHandlerDeps {
  config: Config;
  resolver: BackendResolver;
  agentRunner: DynamicRunnerManager;
  scheduler: Scheduler;
  workdir: string;
  skillsRef: SkillsRef;
}

/**
 * InteractionCreate イベントのハンドラを生成する
 * （オートコンプリート / ボタン / スラッシュコマンドの全処理）。
 */
export function createInteractionHandler(
  deps: InteractionHandlerDeps
): (interaction: Interaction) => Promise<void> {
  const { config, resolver, agentRunner, scheduler, workdir, skillsRef } = deps;

  return async (interaction: Interaction) => {
    // オートコンプリート処理
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, skillsRef.current);
      return;
    }

    // ボタンインタラクション処理
    if (interaction.isButton()) {
      const channelId = interaction.channelId;
      // 許可チェック
      if (
        !config.discord.allowedUsers?.includes('*') &&
        !config.discord.allowedUsers?.includes(interaction.user.id)
      ) {
        await interaction.reply({ content: '許可されていないユーザーです', ephemeral: true });
        return;
      }

      if (interaction.customId === 'xangi_stop') {
        const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
        await interaction.deferUpdate().catch(() => {});
        if (!stopped) {
          await interaction.followUp({
            content: '実行中のタスクがありません',
            ephemeral: true,
          });
        }
        return;
      }

      if (interaction.customId === 'xangi_extend') {
        // additionalMs を省略して runner 側の「残り時間 2 倍」デフォルト挙動を使う
        const result = agentRunner.extendTimeout?.(channelId) ?? {
          ok: false,
          reason: 'unsupported' as const,
        };
        if (result.ok) {
          await interaction.deferUpdate().catch(() => {});
          // メッセージ自体は timeout-extended イベントで refresh される
        } else {
          const text =
            result.reason === 'max_timeout_exceeded'
              ? '⏱ 上限に達したため延長できません'
              : result.reason === 'no_active_request'
                ? '⏱ 処理中のリクエストがありません'
                : '⏱ このバックエンドでは延長できません';
          await interaction.reply({ content: text, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // 表示専用ボタン (残り時間バッジ) — クリックされても何もしない
      if (interaction.customId === 'xangi_timeout_display') {
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      if (interaction.customId === 'xangi_new') {
        deleteSession(channelId);
        agentRunner.destroy?.(channelId);
        discordToolHistoryByMessageId.delete(interaction.message.id);
        // ボタンを消してメッセージを更新
        await interaction
          .update({
            components: [],
          })
          .catch(() => {});
        await interaction
          .followUp({ content: '🆕 新しいセッションを開始しました', ephemeral: true })
          .catch(() => {});
        return;
      }

      if (interaction.customId === 'xangi_tools') {
        const toolHistory = discordToolHistoryByMessageId.get(interaction.message.id);
        if (!toolHistory || toolHistory.length === 0) {
          await interaction
            .reply({ content: 'ツール履歴はありません', ephemeral: true })
            .catch(() => {});
          return;
        }
        const chunks = splitMessage(`ツール履歴\n${toolHistory.join('\n')}`, DISCORD_SAFE_LENGTH);
        await interaction.reply({
          content: chunks[0] || 'ツール履歴はありません',
          ephemeral: true,
        });
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral: true }).catch(() => {});
        }
        return;
      }

      // 承認ボタン
      if (interaction.customId.startsWith('xangi_approve_')) {
        const approvalId = interaction.customId.replace('xangi_approve_', '');
        resolveApproval(approvalId, true);
        await interaction.update({ content: '✅ 許可しました', components: [] }).catch(() => {});
        return;
      }
      if (interaction.customId.startsWith('xangi_deny_')) {
        const approvalId = interaction.customId.replace('xangi_deny_', '');
        resolveApproval(approvalId, false);
        await interaction.update({ content: '❌ 拒否しました', components: [] }).catch(() => {});
        return;
      }

      // 未知のボタン → 何もせずACK
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // 許可リストチェック（"*" で全員許可）
    if (
      !config.discord.allowedUsers?.includes('*') &&
      !config.discord.allowedUsers?.includes(interaction.user.id)
    ) {
      await interaction.reply({ content: '許可されていないユーザーです', ephemeral: true });
      return;
    }

    const channelId = interaction.channelId;

    if (interaction.commandName === 'new') {
      deleteSession(channelId);
      agentRunner.destroy?.(channelId);
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

    if (interaction.commandName === 'notify') {
      const mode = interaction.options.getString('mode', true) as
        | DiscordCompletionNotifyMode
        | 'default'
        | 'show';
      const settings = loadSettings();
      const defaultMode = config.discord.completionNotifyMode ?? 'message';
      const currentOverride = settings.discordCompletionNotifyChannels?.[channelId];

      if (mode === 'show') {
        const effectiveMode = getChannelCompletionNotifyMode(settings, channelId, defaultMode);
        const thresholdMs = config.discord.completionNotifyAfterMs ?? 10_000;
        const lines = [
          `🔔 完了通知設定 (<#${channelId}>)`,
          `- 適用中: \`${effectiveMode}\``,
          `- チャンネル設定: ${currentOverride ? `\`${currentOverride}\`` : 'なし'}`,
          `- 起動時デフォルト: \`${defaultMode}\``,
          `- 通知閾値: \`${thresholdMs}ms\``,
          `- 対象: 通常の Discord メッセージターンのみ（スケジュール起点は通知なし）`,
        ];
        await interaction.reply(lines.join('\n'));
        return;
      }

      const nextChannels = { ...(settings.discordCompletionNotifyChannels ?? {}) };
      if (mode === 'default') {
        delete nextChannels[channelId];
      } else {
        nextChannels[channelId] = mode;
      }

      const saved = saveSettings({
        discordCompletionNotifyChannels:
          Object.keys(nextChannels).length > 0 ? nextChannels : undefined,
      });
      const effectiveMode = getChannelCompletionNotifyMode(saved, channelId, defaultMode);
      const action =
        mode === 'default'
          ? `起動時デフォルト \`${defaultMode}\` に戻しました`
          : `\`${mode}\` に設定しました`;
      await interaction.reply(
        `🔔 <#${channelId}> の完了通知を${action}\n現在の適用値: \`${effectiveMode}\`\n対象: 通常の Discord メッセージターンのみ（スケジュール起点は通知なし）`
      );
      return;
    }

    if (interaction.commandName === 'backend') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'show') {
        const resolved = agentRunner.resolveForChannel(channelId);
        const override = resolver.getChannelOverride(channelId);
        const defaultRes = resolver.getDefault();
        const lines = [
          `**現在のバックエンド設定** (<#${channelId}>)`,
          `- バックエンド: **${getBackendDisplayName(resolved.backend)}**`,
        ];
        if (resolved.model) lines.push(`- モデル: ${resolved.model}`);
        if (resolved.effort) lines.push(`- effort: ${resolved.effort}`);
        if (override) {
          lines.push(`- ソース: チャンネル設定`);
        } else {
          lines.push(`- ソース: デフォルト (.env)`);
        }

        // Local LLM のとき詳細情報を併記
        if (resolved.backend === 'local-llm') {
          const llmBase = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434';
          const llmModelEnv = process.env.LOCAL_LLM_MODEL;
          const llmMode = process.env.LOCAL_LLM_MODE ?? 'agent (default)';
          const numCtx = process.env.LOCAL_LLM_NUM_CTX ?? '(モデルデフォルト)';
          const temperature = process.env.LOCAL_LLM_TEMPERATURE ?? '(モデルデフォルト = 1.0)';
          const maxTokens = process.env.LOCAL_LLM_MAX_TOKENS ?? '8192 (default)';
          const thinking = process.env.LOCAL_LLM_THINKING ?? 'false (default)';

          lines.push('', '**Local LLM 詳細:**');
          lines.push(`- base_url: \`${llmBase}\``);
          if (!resolved.model && llmModelEnv) lines.push(`- model (env): \`${llmModelEnv}\``);
          lines.push(`- mode: \`${llmMode}\``);
          lines.push(`- num_ctx: \`${numCtx}\``);
          lines.push(`- temperature: \`${temperature}\``);
          lines.push(`- max_tokens: \`${maxTokens}\``);
          lines.push(`- thinking: \`${thinking}\``);
        }

        lines.push(
          ``,
          `**デフォルト:** ${getBackendDisplayName(defaultRes.backend)}${defaultRes.model ? ` (${defaultRes.model})` : ''}`
        );
        await interaction.reply(lines.join('\n'));
        return;
      }

      if (sub === 'set') {
        const backendValue = interaction.options.getString('type', true) as AgentBackend;
        const modelValue = interaction.options.getString('model') ?? undefined;
        const rawEffort = interaction.options.getString('effort');
        const effortValue =
          rawEffort && rawEffort !== 'none' ? (rawEffort as EffortLevel) : undefined;

        // 許可チェック: ALLOWED_BACKENDS 未設定時は全 backend 許可
        if (!resolver.isBackendAllowed(backendValue)) {
          const allowedBackends = resolver.getAllowedBackends();
          await interaction.reply({
            content: `❌ バックエンド \`${backendValue}\` は許可されていません\n許可: ${allowedBackends.map((b) => getBackendDisplayName(b)).join(', ')}`,
            ephemeral: true,
          });
          return;
        }
        if (modelValue && !resolver.isModelAllowed(modelValue)) {
          await interaction.reply({
            content: `❌ モデル \`${modelValue}\` は許可されていません`,
            ephemeral: true,
          });
          return;
        }

        // Local LLMの場合、Ollamaにモデルが存在するか確認
        if (backendValue === 'local-llm' && modelValue) {
          try {
            const ollamaBase = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434';
            const res = await fetch(`${ollamaBase}/api/tags`, {
              signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
              const data = (await res.json()) as {
                models?: Array<{ name: string }>;
              };
              const modelNames = data.models?.map((m) => m.name) ?? [];
              // "qwen3.5:9b" と "qwen3.5:9b" の完全一致、または "qwen3.5" のようなプレフィックス一致
              const found = modelNames.some(
                (n) => n === modelValue || n.startsWith(modelValue + ':')
              );
              if (!found) {
                await interaction.reply({
                  content: `❌ モデル \`${modelValue}\` はOllamaにインストールされていません\nインストール済み: ${modelNames.map((n) => `\`${n}\``).join(', ')}`,
                  ephemeral: true,
                });
                return;
              }
            }
          } catch {
            // Ollama接続失敗は無視（モデル確認をスキップ）
          }
        }

        // channelOverrides に保存
        resolver.setChannelOverride(channelId, {
          backend: backendValue,
          model: modelValue,
          effort: effortValue,
        });

        // セッション & ランナー破棄
        agentRunner.switchBackend(channelId);

        // 切り替え結果を明確に表示
        const display = getBackendDisplayName(backendValue);
        const resolvedModel =
          modelValue ||
          (backendValue === 'local-llm'
            ? process.env.LOCAL_LLM_MODEL || '(デフォルト)'
            : backendValue === 'claude-code'
              ? process.env.AGENT_MODEL || 'Claude (デフォルト)'
              : backendValue === 'cursor'
                ? process.env.AGENT_MODEL || 'Cursor (デフォルト)'
                : backendValue === 'grok'
                  ? process.env.AGENT_MODEL || 'Grok (デフォルト)'
                  : '(デフォルト)');
        const lines = [
          `🔄 モデルを切り替えました。新しいセッションを開始します。`,
          `- バックエンド: **${display}**`,
          `- モデル: **${resolvedModel}**`,
        ];
        if (effortValue) lines.push(`- effort: **${effortValue}**`);
        await interaction.reply(lines.join('\n'));
        return;
      }

      if (sub === 'reset') {
        resolver.deleteChannelOverride(channelId);
        agentRunner.switchBackend(channelId);
        const defaultRes = resolver.getDefault();
        await interaction.reply(
          `🔄 デフォルト (**${getBackendDisplayName(defaultRes.backend)}**) に戻しました。新しいセッションを開始します。`
        );
        return;
      }

      if (sub === 'list') {
        await interaction.deferReply();
        const allowed = resolver.getAllowedBackends();
        const allowedModels = resolver.getAllowedModels();
        const defaultRes = resolver.getDefault();
        const lines = ['**利用可能なバックエンド:**'];
        for (const b of allowed) {
          const isDefault = b === defaultRes.backend;
          lines.push(`- ${getBackendDisplayName(b)}${isDefault ? ' (デフォルト)' : ''}`);
        }
        if (allowedModels && allowedModels.length > 0) {
          lines.push('', '**許可モデル:**');
          for (const m of allowedModels) {
            lines.push(`- \`${m}\``);
          }
        }

        // Local LLM モデル一覧を取得（許可されている場合）
        // Ollama (`/api/tags`) と vLLM / OpenAI 互換 (`/v1/models`) の両方に対応
        if (allowed.includes('local-llm')) {
          const llmBase = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434';
          let modelsShown = false;

          // Ollama 経路
          try {
            const res = await fetch(`${llmBase}/api/tags`, {
              signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
              const data = (await res.json()) as {
                models?: Array<{ name: string; size: number }>;
              };
              if (data.models && data.models.length > 0) {
                lines.push('', '**Ollamaモデル（インストール済み）:**');
                for (const m of data.models) {
                  const sizeGB = (m.size / 1e9).toFixed(1);
                  lines.push(`- \`${m.name}\` (${sizeGB}GB)`);
                }
                modelsShown = true;
              }
            }
          } catch {
            // Ollama 未起動・別サーバーの可能性 → fallback へ
          }

          // vLLM / OpenAI 互換経路 (Ollama で取れなかった場合のフォールバック)
          if (!modelsShown) {
            try {
              const res = await fetch(`${llmBase}/v1/models`, {
                signal: AbortSignal.timeout(3000),
              });
              if (res.ok) {
                const data = (await res.json()) as {
                  data?: Array<{ id: string; max_model_len?: number; owned_by?: string }>;
                };
                if (data.data && data.data.length > 0) {
                  lines.push('', '**Local LLM モデル（OpenAI互換API）:**');
                  for (const m of data.data) {
                    const ctx = m.max_model_len
                      ? ` (max_model_len: ${m.max_model_len.toLocaleString()})`
                      : '';
                    const owner = m.owned_by ? ` [${m.owned_by}]` : '';
                    lines.push(`- \`${m.id}\`${ctx}${owner}`);
                  }
                  modelsShown = true;
                }
              }
            } catch {
              // 両方失敗 → 警告表示
            }
          }

          if (!modelsShown) {
            lines.push(
              '',
              `⚠️ Local LLM サーバー (\`${llmBase}\`) からモデル一覧を取得できませんでした。Ollama (\`/api/tags\`) も OpenAI互換 (\`/v1/models\`) も応答なし。`
            );
          }
        }

        await interaction.editReply(lines.join('\n'));
        return;
      }
    }

    if (interaction.commandName === 'skip') {
      const skipMessage = interaction.options.getString('message', true);
      await interaction.deferReply();

      try {
        const sessionId = getSession(channelId);
        const appSessionId = ensureSession(channelId, { platform: 'discord' });

        // ワンショットのClaudeCodeRunnerを使用（skipPermissionsを確実に反映するため）
        const skipRunner = new ClaudeCodeRunner(config.agent.config);
        const runResult = await skipRunner.run(skipMessage, {
          skipPermissions: true,
          sessionId,
          channelId,
          appSessionId,
        });

        setSession(channelId, runResult.sessionId);

        // ファイルパスを抽出して添付送信（テキスト由来 + 構造化 attachments を合算・重複排除）
        // 添付ゼロでも実在しない MEDIA マーカーが残る場合は生成失敗の注記に差し替える
        const { filePaths, displayText } = buildAttachmentResult(
          runResult.result,
          runResult.attachments
        );

        const chunks = splitMessage(displayText, DISCORD_SAFE_LENGTH);
        await interaction.editReply(chunks[0] || '✅');
        if (chunks.length > 1 && 'send' in interaction.channel!) {
          const channel = interaction.channel as unknown as {
            send: (content: string) => Promise<unknown>;
          };
          for (let i = 1; i < chunks.length; i++) {
            await channel.send(chunks[i]);
          }
        }

        // ファイル添付送信
        if (filePaths.length > 0 && interaction.channel && 'send' in interaction.channel) {
          try {
            await (
              interaction.channel as unknown as {
                send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
              }
            ).send({
              files: filePaths.map((fp) => ({ attachment: fp })),
            });
            console.log(`[xangi] Sent ${filePaths.length} file(s) via /skip`);
          } catch (err) {
            console.error('[xangi] Failed to send files via /skip:', err);
          }
        }
      } catch (error) {
        await interaction.editReply(formatAgentErrorForUser(error)).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'autoreply') {
      if (!config.discord.allowAutoreplyCommand) {
        await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
        return;
      }
      const chId = interaction.channelId;
      const channels = config.discord.autoReplyChannels ?? [];
      const idx = channels.indexOf(chId);
      const isCurrentlyOn = idx !== -1;

      if (isCurrentlyOn) {
        // OFF: メモリから削除
        channels.splice(idx, 1);
      } else {
        // ON: メモリに追加
        channels.push(chId);
      }
      config.discord.autoReplyChannels = channels;

      // .env に永続化 (Docker 環境で .env ファイルが無い場合は graceful skip)
      const persistResult = updateEnvKeyValue('AUTO_REPLY_CHANNELS', channels.join(','));
      if (!persistResult.ok) {
        console.warn(`[xangi] AUTO_REPLY_CHANNELS persistence skipped: ${persistResult.reason}`);
      }

      const status = isCurrentlyOn ? '❌ OFF' : '✅ ON';
      await interaction.reply(`メンションなし応答: ${status} (<#${chId}>)`);
      return;
    }

    if (interaction.commandName === 'respondtobots') {
      if (!config.discord.allowRespondToBotsCommand) {
        await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
        return;
      }
      const wasEnabled = config.discord.respondToBotsEnabled ?? false;
      const nextEnabled = !wasEnabled;
      config.discord.respondToBotsEnabled = nextEnabled;

      // .env に永続化 (Docker 環境で .env ファイルが無い場合は graceful skip)
      const persistResult = updateEnvKeyValue(
        'RESPOND_TO_BOTS_ENABLED',
        nextEnabled ? 'true' : 'false'
      );
      if (!persistResult.ok) {
        console.warn(
          `[xangi] RESPOND_TO_BOTS_ENABLED persistence skipped: ${persistResult.reason}`
        );
      }

      const whitelist = config.discord.respondToBots ?? [];
      const target =
        whitelist.length === 0
          ? '(RESPOND_TO_BOTS 未設定)'
          : whitelist.includes('*')
            ? '全 bot'
            : whitelist.join(', ');
      const status = nextEnabled ? '✅ ON' : '❌ OFF';
      await interaction.reply(`bot メッセージへの応答: ${status} / 反応対象: ${target}`);
      return;
    }

    if (interaction.commandName === 'llmmode') {
      if (!config.discord.allowLlmModeCommand) {
        await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
        return;
      }
      const chId = interaction.channelId;
      const mode = interaction.options.getString('mode', true) as
        | 'agent'
        | 'lite'
        | 'chat'
        | 'default'
        | 'show';

      // show: 現在の設定を表示するだけ
      if (mode === 'show') {
        const current = resolver.getChannelOverride(chId);
        const resolved = resolver.resolve(chId);

        // 起動時 env LOCAL_LLM_MODE（未指定なら 'agent' default）
        const envMode = (process.env.LOCAL_LLM_MODE || '').toLowerCase();
        const startupMode =
          envMode === 'agent' || envMode === 'lite' || envMode === 'chat' ? envMode : 'agent';

        // 実際に適用される mode（チャンネル override 優先、無ければ起動時 env）
        const appliedMode = resolved.localLlmMode ?? startupMode;
        const source = resolved.localLlmMode
          ? 'チャンネル個別 override (CHANNEL_OVERRIDES)'
          : envMode
            ? `起動時 env LOCAL_LLM_MODE=${envMode}`
            : `起動時 default (LOCAL_LLM_MODE 未指定 → agent)`;

        const lines: string[] = [
          `📍 <#${chId}> の Local LLM 設定`,
          ``,
          `**適用中のモード:** \`${appliedMode}\``,
          `**由来:** ${source}`,
          ``,
          `### 設定の内訳`,
          `- backend: \`${resolved.backend}\``,
          `- model: ${resolved.model ? `\`${resolved.model}\`` : '(env デフォルト)'}`,
          `- 起動時 env \`LOCAL_LLM_MODE\`: \`${envMode || '(未指定 → agent)'}\``,
          `- チャンネル override (\`localLlmMode\`): ${current?.localLlmMode ? `\`${current.localLlmMode}\`` : 'なし'}`,
          ``,
          `### モード別の機能`,
          `- \`agent\`: tools / skills / xangi-commands ON、triggers OFF`,
          `- \`lite\`: tools / xangi-commands / triggers ON、skills OFF`,
          `- \`chat\`: 全機能 OFF（純粋会話）`,
        ];
        await interaction.reply(lines.join('\n'));
        return;
      }

      // default: override 削除（その他のフィールドは保持）
      if (mode === 'default') {
        resolver.setChannelLocalLlmMode(chId, null);
        await interaction.reply(`✅ <#${chId}> の Local LLM mode override を削除しました`);
        return;
      }

      // agent / lite / chat: 設定
      resolver.setChannelLocalLlmMode(chId, mode);
      await interaction.reply(`✅ <#${chId}> の Local LLM mode を \`${mode}\` に設定しました`);
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
      skillsRef.current = loadSkills(workdir);
      await interaction.reply(formatSkillList(skillsRef.current));
      return;
    }

    if (interaction.commandName === 'skill') {
      const skillName = interaction.options.getString('name', true);
      await handleSkillCommand(interaction, agentRunner, config, channelId, skillName);
      return;
    }

    // 個別スキルコマンドの処理
    const matchedSkill = skillsRef.current.find(
      (s) => skillCommandName(s.name) === interaction.commandName
    );

    if (matchedSkill) {
      await handleSkillCommand(interaction, agentRunner, config, channelId, matchedSkill.name);
      return;
    }
  };
}
