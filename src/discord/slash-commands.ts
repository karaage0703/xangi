import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  Interaction,
  MessageFlags,
} from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import {
  type Config,
  type AgentBackend,
  type EffortLevel,
  type DiscordCompletionNotifyMode,
} from '../config.js';
import {
  LOCAL_LLM_REASONING_EFFORTS,
  type LocalLlmReasoningEffort,
} from '../local-llm/reasoning-effort.js';
import { getBackendDisplayName, type AgentRunner, type RunResult } from '../agent-runner.js';
import { getSupportedEffortLevels } from '../backend-effort.js';
import type { BackendResolver } from '../backend-resolver.js';
import type { DynamicRunnerManager } from '../dynamic-runner.js';
import { ClaudeCodeRunner } from '../claude-code.js';
import { formatAgentErrorForUser } from '../errors.js';
import { processManager } from '../process-manager.js';
import { requestProcessRestart } from '../restart-process.js';
import { loadSkills, formatSkillList, type Skill } from '../skills.js';
import { loadReplySuggestionsEnabled, loadSettings, formatSettings } from '../settings.js';
import { canSelfRestart, getSelfLifecyclePermission } from '../self-lifecycle.js';
import {
  getSession,
  setSession,
  closeActiveSession,
  getActiveSessionId,
  getSessionEntry,
} from '../sessions.js';
import { splitDiscordMessage } from '../message-split.js';
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
import {
  createCompletedButtons,
  createProcessingButtons,
  createReplySuggestionButtons,
  discordProcessingMessages,
  discordReplySuggestionsByMessageId,
  discordToolHistoryByMessageId,
  getDiscordTimeoutInfoFor,
  parseDiscordHistoryCustomId,
} from './ui.js';
import {
  addToolHistory,
  appendToolHistory,
  formatTurnHistoryDisclosure,
  withoutFinalResponse,
} from '../tool-history.js';
import { getTurnHistory, readTurnHistory, type TurnHistoryEntry } from '../activity-store.js';
import { waitBeforeFollowupDiscordSend } from './send-delay.js';
import { resolveDiscordSettingsChannelId } from './thread-context.js';
import {
  appendReplySuggestionInstruction,
  fallbackReplySuggestions,
  formatNumberedSuggestions,
  sanitizeReplySuggestionOutput,
  stripReplySuggestionMarkup,
} from '../reply-suggestions.js';
import { executeModelsCommand } from '../models-command.js';
import { discoverBackendModels, type BackendModelDiscovery } from '../backend-models.js';
import { StreamSession } from '../stream-session.js';
import { runWithBubbleEvents } from '../bubble-events-runner.js';
import { threadIdFor, turnIdFor } from '../events-emitter.js';
import { executeRuntimeSettingsCommand } from '../runtime-settings-command.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import { ensureSessionWithWorkspace } from '../session-workspace.js';

/** スキル一覧を保持する可変参照。`/skill` での再読込を呼び出し元と共有する */
export interface SkillsRef {
  current: Skill[];
}

type DiscordHistoryInteraction = Pick<ButtonInteraction, 'deferReply' | 'editReply' | 'followUp'>;

export async function respondWithDiscordTurnHistory(
  interaction: DiscordHistoryInteraction,
  loadHistory: () => TurnHistoryEntry[]
): Promise<void> {
  // Discord requires an initial interaction acknowledgement within about 3 seconds.
  // Acknowledge before formatting or reading persisted history.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const chunks = splitDiscordMessage(
    formatTurnHistoryDisclosure(loadHistory()),
    DISCORD_SAFE_LENGTH
  );
  await interaction.editReply({ content: chunks[0] || '履歴はありません' });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
  }
}

const DISCORD_APPLICATION_COMMAND_LIMIT = 100;
const DISCORD_MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

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
  const chunks = splitDiscordMessage(content, maxLength, sep);
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
  const commands: ReturnType<SlashCommandBuilder['toJSON']>[] = [
    new SlashCommandBuilder().setName('new').setDescription('新しいセッションを開始する').toJSON(),
    new SlashCommandBuilder()
      .setName('workspace')
      .setDescription('このチャンネルのワークスペースを設定する')
      .addSubcommand((sub) => sub.setName('show').setDescription('現在の設定を表示する'))
      .addSubcommand((sub) => sub.setName('list').setDescription('登録済み一覧を表示する'))
      .addSubcommand((sub) =>
        sub
          .setName('use')
          .setDescription('登録済みworkspaceへ切り替える')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('登録済み表示名').setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('任意の絶対パスを登録して設定する')
          .addStringOption((opt) => opt.setName('name').setDescription('表示名').setRequired(true))
          .addStringOption((opt) =>
            opt.setName('path').setDescription('既存directoryの絶対パス').setRequired(true)
          )
      )
      .addSubcommand((sub) => sub.setName('reset').setDescription('defaultへ戻す'))
      .toJSON(),
    new SlashCommandBuilder().setName('stop').setDescription('実行中のタスクを停止する').toJSON(),
    new SlashCommandBuilder()
      .setName('skill')
      .setDescription('利用可能なスキルを表示・実行する')
      .addStringOption((option) =>
        option.setName('name').setDescription('スキル名').setRequired(false).setAutocomplete(true)
      )
      .addStringOption((option) => option.setName('args').setDescription('引数').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName('settings').setDescription('現在の設定を表示する').toJSON(),
    new SlashCommandBuilder()
      .setName('models')
      .setDescription('利用可能なモデル一覧を表示する')
      .addStringOption((option) =>
        option
          .setName('backend')
          .setDescription('バックエンド（省略時はすべて）')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('replysuggestions')
      .setDescription('回答候補の全体ON/OFFを設定する')
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('回答候補モード')
          .setRequired(true)
          .addChoices(
            { name: 'show (現在の設定を表示)', value: 'show' },
            { name: 'on (全プラットフォームで生成)', value: 'on' },
            { name: 'off (生成せずトークンを使わない)', value: 'off' },
            { name: 'default (起動時設定に戻す)', value: 'default' }
          )
      )
      .toJSON(),
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
              .setAutocomplete(true)
          )
          .addStringOption((opt) =>
            opt.setName('model').setDescription('モデル名').setAutocomplete(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('effort')
              .setDescription('effortレベル（対応バックエンド用）')
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) => sub.setName('reset').setDescription('デフォルトに戻す'))
      .toJSON(),
  ];

  // ALLOW_AUTOREPLY_COMMAND=true の場合のみコマンドを登録
  if (config.discord.allowAutoreplyCommand) {
    commands.push(
      new SlashCommandBuilder()
        .setName('autoreply')
        .setDescription('このチャンネルのメンションなし応答を設定')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('メンションなし応答モード')
            .setRequired(true)
            .addChoices(
              { name: 'show (現在の設定を表示)', value: 'show' },
              { name: 'on (メンションなしで応答)', value: 'on' },
              { name: 'off (メンションなし応答を無効)', value: 'off' },
              { name: 'default (チャンネル設定を削除)', value: 'default' }
            )
        )
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

  // ALLOW_THREAD_MODE_COMMAND=true の場合のみコマンドを登録
  if (config.discord.allowThreadModeCommand) {
    commands.push(
      new SlashCommandBuilder()
        .setName('threadmode')
        .setDescription('Discord の発言ごとスレッド返信モードを切替')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('スレッドモード')
            .setRequired(true)
            .addChoices(
              { name: 'show (現在の設定を表示)', value: 'show' },
              { name: 'on (発言ごとにスレッド返信)', value: 'on' },
              { name: 'off (チャンネル直下に返信)', value: 'off' },
              { name: 'default (チャンネル設定を削除)', value: 'default' }
            )
        )
        .toJSON()
    );
  }

  // ALLOW_LLM_MODE_COMMAND=true の場合のみコマンドを登録（Local LLM 動作モード切替）
  if (config.discord.allowLlmModeCommand) {
    commands.push(
      new SlashCommandBuilder()
        .setName('llmmode')
        .setDescription('このチャンネルの Local LLM 動作モードを切替 (agent/chat/default/show)')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('モード')
            .setRequired(true)
            .addChoices(
              { name: 'agent (全機能ON、複雑タスク向け)', value: 'agent' },
              { name: 'chat (全機能OFF、純粋会話)', value: 'chat' },
              { name: 'default (チャンネル override 削除、起動時値に戻す)', value: 'default' },
              { name: 'show (現在の設定を表示)', value: 'show' }
            )
        )
        .toJSON()
    );
  }

  if (config.discord.allowLlmEffortCommand) {
    commands.push(
      new SlashCommandBuilder()
        .setName('llmeffort')
        .setDescription('このチャンネルの Local LLM reasoning effort を切替')
        .addStringOption((option) =>
          option
            .setName('level')
            .setDescription('reasoning effort')
            .setRequired(true)
            .addChoices(
              { name: 'show (現在の設定を表示)', value: 'show' },
              { name: 'default (チャンネル設定を削除)', value: 'default' },
              ...LOCAL_LLM_REASONING_EFFORTS.map((effort) => ({
                name: effort,
                value: effort,
              }))
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

interface DiscordAutocompleteChoice {
  name: string;
  value: string;
}

interface DiscordAutocompleteInput {
  commandName: string;
  focusedName: string;
  focusedValue: string;
  backend?: AgentBackend;
  model?: string;
}

interface DiscordModelDiscoveryCacheEntry {
  result?: BackendModelDiscovery;
  expiresAt: number;
  refresh?: Promise<BackendModelDiscovery>;
}

/**
 * Discord autocomplete must answer within a few seconds. Backend discovery can
 * spawn an external CLI, so keep the last result and refresh stale entries in
 * the background instead of blocking an interaction.
 */
export function createDiscordModelDiscoveryCache(
  discoverModels: typeof discoverBackendModels,
  ttlMs = DISCORD_MODEL_DISCOVERY_CACHE_TTL_MS
): typeof discoverBackendModels {
  const cache = new Map<AgentBackend, DiscordModelDiscoveryCacheEntry>();

  const refresh = (
    backend: AgentBackend,
    entry: DiscordModelDiscoveryCacheEntry
  ): Promise<BackendModelDiscovery> => {
    if (entry.refresh) return entry.refresh;
    entry.refresh = discoverModels(backend)
      .then((result) => {
        entry.result = result;
        entry.expiresAt = Date.now() + ttlMs;
        entry.refresh = undefined;
        return result;
      })
      .catch((error) => {
        entry.refresh = undefined;
        if (entry.result) return entry.result;
        cache.delete(backend);
        throw error;
      });
    return entry.refresh;
  };

  return async (backend: AgentBackend) => {
    let entry = cache.get(backend);
    if (!entry) {
      entry = { expiresAt: 0 };
      cache.set(backend, entry);
      return refresh(backend, entry);
    }
    if (entry.result && entry.expiresAt > Date.now()) return entry.result;
    if (entry.result) {
      void refresh(backend, entry);
      return entry.result;
    }
    return refresh(backend, entry);
  };
}

function filterAutocompleteChoices(
  choices: DiscordAutocompleteChoice[],
  query: string
): DiscordAutocompleteChoice[] {
  const normalized = query.toLowerCase();
  return choices
    .filter(
      (choice) =>
        !normalized ||
        choice.name.toLowerCase().includes(normalized) ||
        choice.value.toLowerCase().includes(normalized)
    )
    .slice(0, 25);
}

export async function getDiscordAutocompleteChoices(
  input: DiscordAutocompleteInput,
  skills: Skill[],
  resolver: BackendResolver,
  discoverModels: typeof discoverBackendModels = discoverBackendModels
): Promise<DiscordAutocompleteChoice[]> {
  if (input.commandName === 'skill' && input.focusedName === 'name') {
    return filterAutocompleteChoices(
      skills.map((skill) => ({
        name: `${skill.name} - ${skill.description.slice(0, 50)}`.slice(0, 100),
        value: skill.name,
      })),
      input.focusedValue
    );
  }

  if (
    (input.commandName === 'backend' && input.focusedName === 'type') ||
    (input.commandName === 'models' && input.focusedName === 'backend')
  ) {
    return filterAutocompleteChoices(
      resolver.getSelectableBackends().map((backend) => ({
        name: getBackendDisplayName(backend),
        value: backend,
      })),
      input.focusedValue
    );
  }

  if (input.commandName !== 'backend' || !input.backend) return [];
  if (!resolver.isBackendSelectable(input.backend)) return [];

  if (input.focusedName === 'model') {
    const discovery = await discoverModels(input.backend);
    if (discovery.status !== 'available') return [];
    const allowedModels = resolver.getAllowedModels();
    return filterAutocompleteChoices(
      discovery.models
        .filter((model) => !allowedModels || allowedModels.includes(model.id))
        .map((model) => ({
          name:
            model.displayName && model.displayName !== model.id
              ? `${model.displayName} (${model.id})`.slice(0, 100)
              : model.id.slice(0, 100),
          value: model.id,
        })),
      input.focusedValue
    );
  }

  if (input.focusedName === 'effort') {
    let discovery: BackendModelDiscovery | undefined;
    if (input.model) discovery = await discoverModels(input.backend);
    const selectedModel = discovery?.models.find((model) => model.id === input.model);
    const efforts = getSupportedEffortLevels(input.backend).filter(
      (effort) =>
        !selectedModel?.supportedEfforts?.length || selectedModel.supportedEfforts.includes(effort)
    );
    return filterAutocompleteChoices(
      [
        { name: 'デフォルト', value: 'none' },
        ...efforts.map((effort) => ({ name: effort, value: effort })),
      ],
      input.focusedValue
    );
  }

  return [];
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  skills: Skill[],
  resolver: BackendResolver,
  discoverModels: typeof discoverBackendModels
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const backendOptionName = interaction.commandName === 'models' ? 'backend' : 'type';
  const backend = interaction.options.getString(backendOptionName) as AgentBackend | null;
  const model = interaction.options.getString('model') ?? undefined;
  const choices = await getDiscordAutocompleteChoices(
    {
      commandName: interaction.commandName,
      focusedName: focused.name,
      focusedValue: String(focused.value),
      backend: backend ?? undefined,
      model,
    },
    skills,
    resolver,
    discoverModels
  );
  await interaction.respond(choices);
}

/** スキル実行プロンプトをエージェントに投げて結果を返信する（/skill と個別スキルコマンド共通） */
export async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: Config,
  channelId: string,
  settingsChannelId: string,
  skillName: string,
  workspaceRegistry?: WorkspaceRegistry
) {
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;
  const showButtons = config.discord.showButtons ?? true;
  const useStreaming = config.discord.streaming ?? true;
  const showThinking = config.discord.showThinking ?? true;
  const toolHistoryMode =
    config.discord.toolHistoryMode ?? ((config.discord.showToolUse ?? true) ? 'inline' : 'off');
  const captureToolUse = toolHistoryMode !== 'off';
  const showLiveToolUse = captureToolUse && (config.discord.showLiveToolUse ?? true);
  const replySuggestionCount = config.discord.replySuggestionCount ?? 3;
  const replySuggestionsEnabled =
    showButtons && loadReplySuggestionsEnabled(config.discord.replySuggestions !== false);

  await interaction.deferReply();

  try {
    let prompt = `[プラットフォーム: Discord]\n[チャンネルID: ${channelId}]\nスキル「${skillName}」を実行してください。${args ? `引数: ${args}` : ''}`;
    if (replySuggestionsEnabled) {
      prompt = appendReplySuggestionInstruction(prompt, replySuggestionCount);
    }

    const sessionId = getSession(channelId);
    const { appSessionId, workspace } = await ensureSessionWithWorkspace({
      registry: workspaceRegistry,
      platform: 'discord',
      contextKey: channelId,
      bindingKey: settingsChannelId,
    });
    const eventCtx = {
      threadId: threadIdFor('discord', channelId),
      turnId: turnIdFor('discord', interaction.id),
      threadLabel: `Discord /skill ${skillName}`,
      platform: 'discord' as const,
      userText: `/skill ${skillName}${args ? ` ${args}` : ''}`,
      eventTextSanitizer: stripReplySuggestionMarkup,
    };
    const toolHistory: string[] = [];

    const initialMessage = await interaction.editReply({
      content: '考え中... ⠋',
      ...(showButtons && { components: [createProcessingButtons()] }),
    });
    if (showButtons) {
      discordProcessingMessages.set(channelId, { message: initialMessage });
    }

    const streamSession = new StreamSession({
      formatToolLine: showLiveToolUse
        ? (toolName, toolInput) => {
            const lines: string[] = [];
            addToolHistory(lines, toolName, toolInput);
            return lines[0] ?? null;
          }
        : undefined,
      render: async (view) => {
        const content =
          view.phase === 'thinking'
            ? `${view.toolLines.length > 0 ? `${view.toolLines.join('\n')}\n\n` : ''}${view.statusLine}`
            : appendToolHistory(stripReplySuggestionMarkup(view.text), view.toolLines, ' ▌').slice(
                0,
                DISCORD_MAX_LENGTH
              );
        await interaction
          .editReply({
            content,
            ...(showButtons && {
              components: [
                createProcessingButtons(getDiscordTimeoutInfoFor(agentRunner, channelId)),
              ],
            }),
          })
          .catch((error) => {
            console.error('[xangi] Failed to edit /skill response:', error?.message || error);
          });
      },
    });

    const captureCallbacks = {
      onToolUse: (toolName: string, toolInput: Record<string, unknown>) => {
        if (captureToolUse) addToolHistory(toolHistory, toolName, toolInput);
      },
    };
    streamSession.start();
    let runResult: RunResult;
    try {
      const sessionCallbacks = streamSession.callbacks(captureCallbacks);
      runResult = await runWithBubbleEvents(
        agentRunner,
        prompt,
        eventCtx,
        useStreaming && showThinking ? sessionCallbacks : { onToolUse: sessionCallbacks.onToolUse },
        {
          skipPermissions,
          sessionId,
          channelId,
          settingsChannelId,
          appSessionId,
          workdir: workspace?.path,
        }
      );
    } finally {
      streamSession.finish();
      discordProcessingMessages.delete(channelId);
    }

    setSession(channelId, runResult.sessionId);
    const extracted = sanitizeReplySuggestionOutput(
      runResult.result,
      replySuggestionsEnabled,
      replySuggestionCount
    );
    if (replySuggestionsEnabled && extracted.suggestions.length === 0) {
      extracted.suggestions = fallbackReplySuggestions(replySuggestionCount);
    }
    const { filePaths, displayText } = buildAttachmentResult(
      extracted.text,
      runResult.attachments,
      workspace?.path
    );
    const displayTextWithTools =
      toolHistoryMode === 'inline' ? appendToolHistory(displayText, toolHistory) : displayText;
    const chunks = splitDiscordMessage(displayTextWithTools, DISCORD_SAFE_LENGTH);
    const turnHistory = withoutFinalResponse(
      getTurnHistory(eventCtx.threadId, eventCtx.turnId),
      runResult.result
    );
    const showHistory =
      toolHistoryMode === 'button' &&
      (config.discord.showToolButton ?? true) &&
      turnHistory.length > 0;
    const completedButtons = showButtons
      ? createCompletedButtons({
          showTools: showHistory,
          historyContext: { threadId: eventCtx.threadId, turnId: eventCtx.turnId },
          showLeave: interaction.channel?.isThread() ?? false,
          showReplySuggestions: extracted.suggestions.length > 0,
        })
      : undefined;

    let finalMessage = await interaction.editReply({
      content: chunks[0] || '✅',
      components: chunks.length === 1 && completedButtons ? [completedButtons] : [],
    });
    for (let i = 1; i < chunks.length; i++) {
      await waitBeforeFollowupDiscordSend();
      finalMessage = await interaction.followUp({
        content: chunks[i],
        components: i === chunks.length - 1 && completedButtons ? [completedButtons] : [],
      });
    }

    if (showHistory) {
      discordToolHistoryByMessageId.set(finalMessage.id, turnHistory);
    }
    if (showButtons && extracted.suggestions.length > 0) {
      discordReplySuggestionsByMessageId.set(finalMessage.id, extracted.suggestions);
    }
    if (filePaths.length > 0) {
      await interaction.followUp({ files: filePaths.map((attachment) => ({ attachment })) });
    }
  } catch (error) {
    console.error('[xangi] Error:', error);
    discordProcessingMessages.delete(channelId);
    await interaction.editReply({ content: formatAgentErrorForUser(error), components: [] });
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
  workspaceRegistry: WorkspaceRegistry;
  discoverModels?: typeof discoverBackendModels;
  onReplySuggestion?: (interaction: ButtonInteraction, suggestion: string) => Promise<void>;
}

export async function removeUserFromDiscordThread(
  channel: Interaction['channel'],
  userId: string
): Promise<boolean> {
  if (!channel?.isThread()) return false;
  await channel.members.remove(userId);
  return true;
}

export function formatThreadLeaveError(error: unknown): string {
  const code = (error as { code?: number } | null)?.code;
  if (code === 50001 || code === 50013) {
    return '❌ Botに「スレッドの管理」権限が必要です';
  }
  return '❌ スレッドから退出できませんでした';
}

/**
 * InteractionCreate イベントのハンドラを生成する
 * （オートコンプリート / ボタン / スラッシュコマンドの全処理）。
 */
export function createInteractionHandler(
  deps: InteractionHandlerDeps
): (interaction: Interaction) => Promise<void> {
  const {
    config,
    resolver,
    agentRunner,
    scheduler,
    workdir,
    skillsRef,
    workspaceRegistry,
    discoverModels = discoverBackendModels,
    onReplySuggestion,
  } = deps;

  const autocompleteDiscoverModels = createDiscordModelDiscoveryCache(discoverModels);
  for (const backend of resolver.getSelectableBackends()) {
    void autocompleteDiscoverModels(backend).catch((error) => {
      console.warn(`[xangi] Failed to prewarm ${backend} model autocomplete:`, error);
    });
  }

  return async (interaction: Interaction) => {
    // オートコンプリート処理
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(
        interaction,
        skillsRef.current,
        resolver,
        autocompleteDiscoverModels
      );
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
        const managedProcessStopped = await processManager.stopAndWait(channelId);
        const stopped = managedProcessStopped || agentRunner.cancel?.(channelId) || false;
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
        closeActiveSession(channelId, 'new');
        agentRunner.destroy?.(channelId);
        discordToolHistoryByMessageId.delete(interaction.message.id);
        discordReplySuggestionsByMessageId.delete(interaction.message.id);
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

      if (
        interaction.customId === 'xangi_tools' ||
        interaction.customId.startsWith('xangi_tools|')
      ) {
        const historyContext = parseDiscordHistoryCustomId(interaction.customId);
        await respondWithDiscordTurnHistory(interaction, () => {
          const cached = discordToolHistoryByMessageId.get(interaction.message.id);
          if (cached?.length) return cached;
          if (!historyContext) return [];
          return readTurnHistory(historyContext.threadId, 200).filter(
            (entry) => entry.turnId === historyContext.turnId
          );
        });
        return;
      }

      if (interaction.customId === 'xangi_reply_suggestions') {
        const suggestions = discordReplySuggestionsByMessageId.get(interaction.message.id);
        if (!suggestions || suggestions.length === 0) {
          await interaction.reply({
            content: 'この返信候補は期限切れです',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.reply({
          content: formatNumberedSuggestions(suggestions),
          components: [createReplySuggestionButtons(interaction.message.id, suggestions.length)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.customId.startsWith('xangi_reply_suggestion_')) {
        const match = /^xangi_reply_suggestion_(\d+)_(\d+)$/.exec(interaction.customId);
        const sourceMessageId = match?.[1];
        const index = Number(match?.[2]);
        const suggestions = sourceMessageId
          ? discordReplySuggestionsByMessageId.get(sourceMessageId)
          : undefined;
        const suggestion = Number.isInteger(index) ? suggestions?.[index] : undefined;
        if (!suggestion || !onReplySuggestion) {
          await interaction.reply({
            content: 'この返信候補は期限切れです',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.update({ content: `送信: ${suggestion}`, components: [] });
        await onReplySuggestion(interaction, suggestion).catch(async (error) => {
          console.error('[xangi] Reply suggestion failed:', error);
          await interaction.followUp({
            content: formatAgentErrorForUser(error),
            flags: MessageFlags.Ephemeral,
          });
        });
        return;
      }

      if (interaction.customId === 'xangi_thread_leave') {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        if (!interaction.channel?.isThread()) {
          await interaction.editReply('❌ このボタンはスレッド内でのみ使えます').catch(() => {});
          return;
        }
        try {
          await removeUserFromDiscordThread(interaction.channel, interaction.user.id);
          closeActiveSession(channelId, 'leave');
          agentRunner.destroy?.(channelId);
          discordToolHistoryByMessageId.delete(interaction.message.id);
          discordReplySuggestionsByMessageId.delete(interaction.message.id);
          await interaction
            .editReply('🚪 セッションを終了して、このスレッドから退出しました')
            .catch(() => {});
        } catch (error) {
          console.error('[xangi] Failed to leave Discord thread:', error);
          await interaction.editReply(formatThreadLeaveError(error)).catch(() => {});
        }
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
    const settingsChannelId = resolveDiscordSettingsChannelId(
      channelId,
      (interaction.channel ?? {}) as {
        isThread?: () => boolean;
        parentId?: string | null;
      }
    );

    if (interaction.commandName === 'workspace') {
      const subcommand = interaction.options.getSubcommand();
      try {
        if (subcommand === 'show') {
          const selected = await workspaceRegistry.resolve('discord', settingsChannelId);
          const activeId = getActiveSessionId(channelId);
          const active = activeId ? getSessionEntry(activeId) : undefined;
          const activeWorkspace = active?.workspaceId
            ? workspaceRegistry.getById(active.workspaceId)
            : undefined;
          await interaction.reply({
            content: [
              `チャンネル設定: ${selected.name}`,
              `パス: \`${selected.path}\``,
              activeWorkspace
                ? `現在のセッション: ${activeWorkspace.name}（変更は次の /new から反映）`
                : '現在のセッション: 未固定',
            ].join('\n'),
            ephemeral: true,
          });
          return;
        }
        if (subcommand === 'list') {
          const lines = workspaceRegistry
            .list()
            .map(
              (workspace) =>
                `- ${workspace.name}${workspace.isDefault ? ' (default)' : ''}: \`${workspace.path}\``
            );
          await interaction.reply({
            content: ['登録済みワークスペース', ...lines].join('\n'),
            ephemeral: true,
          });
          return;
        }
        if (subcommand === 'set') {
          const workspace = await workspaceRegistry.register(
            interaction.options.getString('name', true),
            interaction.options.getString('path', true)
          );
          await workspaceRegistry.bind('discord', settingsChannelId, workspace.id);
          await interaction.reply({
            content: `${workspace.name} を登録・設定しました。次の /new から \`${workspace.path}\` を使います。`,
            ephemeral: true,
          });
          return;
        }
        if (subcommand === 'use') {
          const name = interaction.options.getString('name', true);
          const workspace = workspaceRegistry.getByName(name);
          if (!workspace) throw new Error(`Workspace not found: ${name}`);
          await workspaceRegistry.bind('discord', settingsChannelId, workspace.id);
          await interaction.reply({
            content: `${workspace.name} を設定しました。次の /new から \`${workspace.path}\` を使います。`,
            ephemeral: true,
          });
          return;
        }
        await workspaceRegistry.resetBinding('discord', settingsChannelId);
        const workspace = await workspaceRegistry.resolve('discord', settingsChannelId);
        await interaction.reply({
          content: `defaultへ戻しました。次の /new から \`${workspace.path}\` を使います。`,
          ephemeral: true,
        });
      } catch (error) {
        await interaction.reply({ content: formatAgentErrorForUser(error), ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'new') {
      closeActiveSession(channelId, 'new');
      agentRunner.destroy?.(channelId);
      await interaction.reply('🆕 新しいセッションを開始しました');
      return;
    }

    if (interaction.commandName === 'stop') {
      const managedProcessStopped = await processManager.stopAndWait(channelId);
      const stopped = managedProcessStopped || agentRunner.cancel?.(channelId) || false;
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
        DiscordCompletionNotifyMode | 'default' | 'show';
      await interaction.reply(
        await executeRuntimeSettingsCommand(
          {
            name: 'notify',
            action: mode === 'default' ? 'reset' : mode === 'show' ? 'show' : 'set',
            value: mode,
            channelId: settingsChannelId,
            platform: 'discord',
          },
          { config, resolver }
        )
      );
      return;
    }

    if (interaction.commandName === 'backend') {
      const sub = interaction.options.getSubcommand();
      const backendValue =
        sub === 'set' ? (interaction.options.getString('type', true) as AgentBackend) : undefined;
      const modelValue =
        sub === 'set' ? (interaction.options.getString('model') ?? undefined) : undefined;
      const rawEffort = sub === 'set' ? interaction.options.getString('effort') : undefined;
      const effortValue =
        rawEffort && rawEffort !== 'none' ? (rawEffort as EffortLevel) : undefined;
      const result = await executeRuntimeSettingsCommand(
        {
          name: 'backend',
          action: sub,
          backend: backendValue,
          model: modelValue,
          effort: effortValue,
          channelId: settingsChannelId,
          platform: 'discord',
        },
        { config, resolver, modelDiscovery: discoverBackendModels }
      );
      if (sub !== 'show') agentRunner.switchBackend(settingsChannelId);
      await interaction.reply(result);
      return;
    }

    if (interaction.commandName === 'models') {
      await interaction.deferReply();
      const backend = interaction.options.getString('backend') ?? undefined;
      const content = await executeModelsCommand(backend, resolver);
      const chunks = splitDiscordMessage(content, DISCORD_SAFE_LENGTH);
      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) await interaction.followUp(chunk);
      return;
    }

    if (interaction.commandName === 'skip') {
      const skipMessage = interaction.options.getString('message', true);
      await interaction.deferReply();

      try {
        const sessionId = getSession(channelId);
        const { appSessionId, workspace } = await ensureSessionWithWorkspace({
          registry: workspaceRegistry,
          platform: 'discord',
          contextKey: channelId,
          bindingKey: settingsChannelId,
        });

        // ワンショットのClaudeCodeRunnerを使用（skipPermissionsを確実に反映するため）
        const skipRunner = new ClaudeCodeRunner({
          ...config.agent.config,
          workdir: workspace?.path ?? config.agent.config.workdir,
        });
        const runResult = await skipRunner.run(skipMessage, {
          skipPermissions: true,
          sessionId,
          channelId,
          settingsChannelId,
          appSessionId,
          workdir: workspace?.path,
        });

        setSession(channelId, runResult.sessionId);

        // ファイルパスを抽出して添付送信（テキスト由来 + 構造化 attachments を合算・重複排除）
        // 添付ゼロでも実在しない MEDIA マーカーが残る場合は生成失敗の注記に差し替える
        const { filePaths, displayText } = buildAttachmentResult(
          runResult.result,
          runResult.attachments,
          workspace?.path
        );

        const chunks = splitDiscordMessage(displayText, DISCORD_SAFE_LENGTH);
        await interaction.editReply(chunks[0] || '✅');
        if (chunks.length > 1 && 'send' in interaction.channel!) {
          const channel = interaction.channel as unknown as {
            send: (content: string) => Promise<unknown>;
          };
          for (let i = 1; i < chunks.length; i++) {
            await waitBeforeFollowupDiscordSend();
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
      const mode = interaction.options.getString('mode', true) as 'show' | 'on' | 'off' | 'default';
      await interaction.reply(
        await executeRuntimeSettingsCommand(
          {
            name: 'autoreply',
            action: mode === 'default' ? 'reset' : mode === 'show' ? 'show' : 'set',
            value: mode,
            // autoreply はスレッド単位で設定できるよう、親チャンネルIDへ丸めない。
            // 他の設定コマンドは従来どおり settingsChannelId (親チャンネル) を対象にする。
            channelId,
            parentChannelId: settingsChannelId !== channelId ? settingsChannelId : undefined,
            platform: 'discord',
          },
          { config, resolver }
        )
      );
      return;
    }

    if (interaction.commandName === 'replysuggestions') {
      const mode = interaction.options.getString('mode', true) as 'show' | 'on' | 'off' | 'default';
      await interaction.reply(
        await executeRuntimeSettingsCommand(
          {
            name: 'replysuggestions',
            action: mode === 'default' ? 'reset' : mode === 'show' ? 'show' : 'set',
            value: mode,
            channelId: settingsChannelId,
            platform: 'discord',
          },
          { config, resolver }
        )
      );
      return;
    }

    if (interaction.commandName === 'respondtobots') {
      if (!config.discord.allowRespondToBotsCommand) {
        await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
        return;
      }
      await interaction.reply(
        await executeRuntimeSettingsCommand(
          {
            name: 'respondtobots',
            action: 'set',
            value: config.discord.respondToBotsEnabled ? 'off' : 'on',
            channelId: settingsChannelId,
            platform: 'discord',
          },
          { config, resolver }
        )
      );
      return;
    }

    if (interaction.commandName === 'threadmode') {
      if (!config.discord.allowThreadModeCommand) {
        await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
        return;
      }

      const mode = interaction.options.getString('mode', true) as 'show' | 'on' | 'off' | 'default';
      await interaction.reply(
        await executeRuntimeSettingsCommand(
          {
            name: 'threadmode',
            action: mode === 'default' ? 'reset' : mode === 'show' ? 'show' : 'set',
            value: mode,
            channelId: settingsChannelId,
            platform: 'discord',
          },
          { config, resolver }
        )
      );
      return;
    }

    if (interaction.commandName === 'llmmode') {
      if (!config.discord.allowLlmModeCommand) {
        await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
        return;
      }
      const mode = interaction.options.getString('mode', true) as
        'agent' | 'chat' | 'default' | 'show';
      await interaction.reply(
        await executeRuntimeSettingsCommand(
          {
            name: 'llmmode',
            action: mode === 'default' ? 'reset' : mode === 'show' ? 'show' : 'set',
            value: mode,
            channelId: settingsChannelId,
            platform: 'discord',
          },
          { config, resolver }
        )
      );
      return;
    }

    if (interaction.commandName === 'llmeffort') {
      if (!config.discord.allowLlmEffortCommand) {
        await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
        return;
      }
      const level = interaction.options.getString('level', true) as
        LocalLlmReasoningEffort | 'default' | 'show';
      const override = resolver.getChannelOverride(settingsChannelId);
      const startupDefaultRaw = process.env.LOCAL_LLM_REASONING_EFFORT?.trim().toLowerCase();
      const startupDefault = LOCAL_LLM_REASONING_EFFORTS.includes(
        startupDefaultRaw as LocalLlmReasoningEffort
      )
        ? (startupDefaultRaw as LocalLlmReasoningEffort)
        : undefined;

      if (level === 'show') {
        const current = override?.localLlmReasoningEffort ?? startupDefault;
        const source = override?.localLlmReasoningEffort
          ? 'チャンネル設定'
          : startupDefault
            ? '起動時デフォルト'
            : 'providerデフォルト';
        await interaction.reply(
          `Local LLM reasoning effort: \`${current || '未指定'}\`（${source}）`
        );
        return;
      }

      resolver.setChannelLocalLlmReasoningEffort(
        settingsChannelId,
        level === 'default' ? null : level
      );
      await interaction.reply(
        level === 'default'
          ? `Local LLM reasoning effort のチャンネル設定を削除しました。次の送信から \`${startupDefault || 'providerデフォルト'}\` を使います。`
          : `Local LLM reasoning effort を \`${level}\` に設定しました。次の送信から適用されます。`
      );
      return;
    }

    if (interaction.commandName === 'restart') {
      const selfLifecycle = getSelfLifecyclePermission();
      if (!canSelfRestart(selfLifecycle)) {
        await interaction.reply(
          '⚠️ 自己再起動が無効です。管理者が `.env` の `XANGI_SELF_LIFECYCLE=restart-only` を設定し、xangi を再起動してください。'
        );
        return;
      }
      await interaction.reply('🔄 再起動します...');
      requestProcessRestart(1000);
      return;
    }

    if (interaction.commandName === 'schedule') {
      await handleScheduleCommand(interaction, scheduler, config.scheduler);
      return;
    }

    if (interaction.commandName === 'skill') {
      const skillName = interaction.options.getString('name');
      skillsRef.current = loadSkills(workdir);
      if (!skillName) {
        await interaction.reply(formatSkillList(skillsRef.current));
        return;
      }
      await handleSkillCommand(
        interaction,
        agentRunner,
        config,
        channelId,
        settingsChannelId,
        skillName,
        workspaceRegistry
      );
      return;
    }

    // 個別スキルコマンドの処理
    const matchedSkill = skillsRef.current.find(
      (s) => skillCommandName(s.name) === interaction.commandName
    );

    if (matchedSkill) {
      await handleSkillCommand(
        interaction,
        agentRunner,
        config,
        channelId,
        settingsChannelId,
        matchedSkill.name,
        workspaceRegistry
      );
      return;
    }
  };
}
