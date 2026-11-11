import { handleSecretConversationCommand } from '../secret-conversation-command.js';
import { executeChatSettings } from '../chat-command-settings.js';
import {
  getChatCommands,
  commandHelp,
  skillCommandAliases,
  skillCommandPrompt,
} from '../chat-commands.js';
import type { ChatCommandOption } from '../chat-commands.js';
import { PENDING_MESSAGE_PREFIX } from './pending-messages.js';
import { handleQuestionInteraction } from './user-input.js';
import { closeAgentWork, findAgentWork } from '../agent-work.js';
import { channelAgent, listSelectableAgents } from '../agent-selection.js';
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  Interaction,
  MessageFlags,
} from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import { type Config, type AgentBackend, type EffortLevel } from '../config.js';
import { getBackendDisplayName, type AgentRunner, type RunResult } from '../agent-runner.js';
import { getSupportedEffortLevelsForModel } from '../backend-effort.js';
import type { BackendResolver } from '../backend-resolver.js';
import type { DynamicRunnerManager } from '../dynamic-runner.js';
import { formatAgentErrorForUser } from '../errors.js';
import { processManager } from '../process-manager.js';
import { loadSkills, formatSkillList, type Skill } from '../skills.js';
import { loadReplySuggestionsEnabled } from '../settings.js';
import {
  getSession,
  setSession,
  closeActiveSession,
  getActiveSessionId,
  getSessionEntry,
  updateSessionTitle,
} from '../sessions.js';
import { readSessionMessages } from '../transcript-logger.js';
import { buildAiSessionTitleSource, generateAiSessionTitle } from '../ai-session-title.js';
import { splitDiscordMessage } from '../message-split.js';
import { DISCORD_MAX_LENGTH, DISCORD_SAFE_LENGTH } from '../constants.js';
import { buildAttachmentResult } from '../file-utils.js';
import { recoverAttachmentOnce } from '../attachment-recovery.js';
import {
  Scheduler,
  parseScheduleInput,
  formatScheduleList,
  formatScheduleDateTime,
  SCHEDULE_SEPARATOR,
  type Platform,
  type ScheduleType,
} from '../scheduler.js';
import {
  prepareDiscordCompletion,
  createProcessingButtons,
  createReplySuggestionButtons,
  discordProcessingMessages,
  discordReplySuggestionsByMessageId,
  discordToolHistoryByMessageId,
  getDiscordTimeoutInfoFor,
  parseDiscordHistoryCustomId,
} from './ui.js';
import { addToolHistory, appendToolHistory, formatTurnHistoryDisclosure } from '../tool-history.js';
import { readTurnHistory, type TurnHistoryEntry } from '../activity-store.js';
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
import {
  executeRuntimeSettingsCommand,
  type RuntimeSettingName,
} from '../runtime-settings-command.js';
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
      return `⏰ 実行時刻: ${formatScheduleDateTime(options.runAt!)}${channelInfo}`;
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
  const addString = (
    builder: import('discord.js').SlashCommandStringOption,
    option: ChatCommandOption
  ) => {
    builder
      .setName(option.name)
      .setDescription(option.description)
      .setRequired(option.required ?? false);
    if (option.choices?.length)
      builder.addChoices(...option.choices.map(({ name, value }) => ({ name, value })));
    else if (option.autocomplete) builder.setAutocomplete(true);
    return builder;
  };
  const commands = getChatCommands('discord', config).map((definition) => {
    const builder = new SlashCommandBuilder()
      .setName(definition.name)
      .setDescription(definition.description);
    for (const option of definition.options ?? []) {
      if (option.type === 'subcommand')
        builder.addSubcommand((sub) => {
          sub.setName(option.name).setDescription(option.description);
          for (const child of option.options ?? [])
            sub.addStringOption((string) => addString(string, child));
          return sub;
        });
      else builder.addStringOption((string) => addString(string, option));
    }
    return builder.toJSON();
  });
  for (const [name, skill] of skillCommandAliases(skills)) {
    if (commands.length >= DISCORD_APPLICATION_COMMAND_LIMIT) break;
    commands.push(
      new SlashCommandBuilder()
        .setName(name)
        .setDescription(skill.description.slice(0, 100) || `${skill.name}スキルを実行`)
        .addStringOption((option) => option.setName('args').setDescription('引数'))
        .toJSON()
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
  discoverModels: typeof discoverBackendModels = discoverBackendModels,
  listAgents: typeof listSelectableAgents = listSelectableAgents
): Promise<DiscordAutocompleteChoice[]> {
  if (input.commandName === 'agent' && input.focusedName === 'id') {
    return filterAutocompleteChoices(
      listAgents().map((agent) => ({
        name: `${agent.name} (${agent.id})`.slice(0, 100),
        value: agent.id,
      })),
      input.focusedValue
    );
  }

  if (input.commandName === 'skill' && input.focusedName === 'name') {
    return filterAutocompleteChoices(
      skills.map((skill) => ({
        name: `${skill.name} - ${skill.description.slice(0, 50)}`.slice(0, 100),
        value: skill.name,
      })),
      input.focusedValue
    );
  }

  if (input.commandName === 'backend' && input.focusedName === 'type') {
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
    return filterAutocompleteChoices(
      discovery.models.map((model) => ({
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
    const discovery = await discoverModels(input.backend);
    const selectedModel = input.model
      ? discovery.models.find((model) => model.id === input.model)
      : discovery.models.find((model) => model.isDefault);
    const efforts = getSupportedEffortLevelsForModel(input.backend, selectedModel);
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
  discoverModels: typeof discoverBackendModels,
  workspaceRegistry: WorkspaceRegistry
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (interaction.commandName === 'workspace') {
    const choices =
      interaction.options.getSubcommand() === 'use' && focused.name === 'name'
        ? filterAutocompleteChoices(
            workspaceRegistry
              .list()
              // Keep the exact name: /workspace use resolves it by name, not by ID.
              .filter((workspace) => workspace.name.length <= 100)
              .map((workspace) => ({ name: workspace.name, value: workspace.name })),
            String(focused.value)
          )
        : [];
    await interaction.respond(choices);
    return;
  }
  const backend = interaction.options.getString('type') as AgentBackend | null;
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
  workspaceRegistry?: WorkspaceRegistry,
  fallbackWorkdir = process.env.WORKSPACE_PATH || process.cwd()
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
    let prompt: string;
    const { appSessionId, workspace } = await ensureSessionWithWorkspace({
      registry: workspaceRegistry,
      platform: 'discord',
      contextKey: channelId,
      bindingKey: settingsChannelId,
    });
    const skill = loadSkills(workspace?.path || fallbackWorkdir).find(
      (candidate) => candidate.name === skillName
    );
    if (!skill) throw new Error(`スキル \`${skillName}\` は現在のWorkspaceにありません`);
    prompt = `[プラットフォーム: Discord]\n[チャンネルID: ${channelId}]\n${skillCommandPrompt(skill, args)}`;
    if (replySuggestionsEnabled)
      prompt = appendReplySuggestionInstruction(prompt, replySuggestionCount);
    const sessionId = getSession(channelId);
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
            : `${view.statusLine ? `${view.statusLine}\n\n` : ''}${appendToolHistory(stripReplySuggestionMarkup(view.text), view.toolLines, ' ▌')}`.slice(
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

    const attachmentRecovery = await recoverAttachmentOnce(
      agentRunner,
      runResult,
      {
        skipPermissions,
        channelId,
        settingsChannelId,
        appSessionId,
        workdir: workspace?.path,
        platform: 'discord',
      },
      workspace?.path
    );
    runResult = attachmentRecovery.runResult;
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
    const completion = prepareDiscordCompletion({
      historyContext: { threadId: eventCtx.threadId, turnId: eventCtx.turnId },
      finalResponse: runResult.result,
      historyEnabled: toolHistoryMode === 'button' && (config.discord.showToolButton ?? true),
      showLeave: interaction.channel?.isThread() ?? false,
      showReplySuggestions: extracted.suggestions.length > 0,
    });
    const completedButtons = showButtons ? completion.buttons : undefined;

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

    if (showButtons) completion.bind(finalMessage.id);
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
  if (schedulerConfig?.enabled === false) {
    await interaction.reply({
      content: 'この機能は管理者により無効化されています',
      ephemeral: true,
    });
    return;
  }
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
    workspaceRegistry,
    discoverModels = discoverBackendModels,
    onReplySuggestion,
  } = deps;

  const commandSkills = async (
    interaction: ChatInputCommandInteraction | AutocompleteInteraction
  ): Promise<Skill[]> => {
    const bindingKey = resolveDiscordSettingsChannelId(
      interaction.channelId,
      (interaction.channel ?? {}) as { isThread?: () => boolean; parentId?: string | null }
    );
    const activeId = getActiveSessionId(interaction.channelId);
    const entry = activeId ? getSessionEntry(activeId) : undefined;
    let path = workdir;
    if (workspaceRegistry) {
      const workspace = entry?.workspacePath
        ? await workspaceRegistry.resolveSnapshot(
            entry.workspaceId || 'default',
            entry.workspacePath
          )
        : entry?.workspaceId
          ? await workspaceRegistry.resolveById(entry.workspaceId)
          : channelAgent('discord', bindingKey)
            ? await workspaceRegistry.resolveById(
                channelAgent('discord', bindingKey)!.workspaceId || 'default'
              )
            : await workspaceRegistry.resolve('discord', bindingKey);
      path = workspace.path;
    }
    return loadSkills(path);
  };

  const autocompleteDiscoverModels = createDiscordModelDiscoveryCache(discoverModels);
  if (config.features?.backendSwitching !== false) {
    for (const backend of resolver.getSelectableBackends()) {
      void autocompleteDiscoverModels(backend).catch((error) => {
        console.warn(`[xangi] Failed to prewarm ${backend} model autocomplete:`, error);
      });
    }
  }

  return async (interaction: Interaction) => {
    if ('customId' in interaction && interaction.customId.startsWith('question:')) {
      await handleQuestionInteraction(interaction);
      return;
    }
    // オートコンプリート処理
    if (interaction.isAutocomplete()) {
      if (
        (!config.discord.allowedUsers?.includes('*') &&
          !config.discord.allowedUsers?.includes(interaction.user.id)) ||
        !getChatCommands('discord', config).some(
          (command) => command.name === interaction.commandName
        )
      ) {
        await interaction.respond([]);
        return;
      }
      let skills: Skill[] = [];
      try {
        if (interaction.commandName === 'skill') skills = await commandSkills(interaction);
      } catch (error) {
        console.warn('[skills] Cannot resolve autocomplete workspace:', error);
        await interaction.respond([]);
        return;
      }
      await handleAutocomplete(
        interaction,
        skills,
        resolver,
        autocompleteDiscoverModels,
        workspaceRegistry
      );
      return;
    }

    // Pending-message buttons are owned by the message handler, including authorization.
    if ('customId' in interaction && interaction.customId.startsWith(PENDING_MESSAGE_PREFIX))
      return;

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

      const workRun = findAgentWork('discord', channelId);
      const executionKey = workRun ? `web-chat:${workRun.appSessionId}` : channelId;
      if (interaction.customId === 'xangi_stop') {
        const managedProcessStopped = await processManager.stopAndWait(executionKey);
        const stopped = managedProcessStopped || agentRunner.cancel?.(executionKey) || false;
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
        const result = agentRunner.extendTimeout?.(executionKey) ?? {
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
          const workClose = workRun ? closeAgentWork('discord', channelId) : undefined;
          if (!workRun) {
            closeActiveSession(channelId, 'leave');
            agentRunner.destroy?.(channelId);
          }
          discordToolHistoryByMessageId.delete(interaction.message.id);
          discordReplySuggestionsByMessageId.delete(interaction.message.id);
          await interaction
            .editReply(
              workClose === 'busy'
                ? '🚪 このスレッドから退出しました。処理中の作業は継続しています'
                : workClose === 'missing'
                  ? '🚪 このスレッドから退出しました。作業セッションが見つからず、完了状態は変更していません'
                  : '🚪 セッションを終了して、このスレッドから退出しました'
            )
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

    const availableCommands = getChatCommands('discord', config);
    let currentSkills: Skill[] = [];
    try {
      if (
        interaction.commandName === 'skill' ||
        !availableCommands.some((command) => command.name === interaction.commandName)
      )
        currentSkills = await commandSkills(interaction);
    } catch (error) {
      await interaction.reply({ content: formatAgentErrorForUser(error), ephemeral: true });
      return;
    }
    if (
      !availableCommands.some((command) => command.name === interaction.commandName) &&
      !skillCommandAliases(currentSkills).has(interaction.commandName)
    ) {
      await interaction.reply({
        content: 'このコマンドは利用できません。/help で一覧を確認してください。',
        ephemeral: true,
      });
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
    const replyWithRuntimeSetting = async (
      name: RuntimeSettingName,
      value: string,
      targetChannelId = settingsChannelId,
      parentChannelId?: string
    ) =>
      interaction.reply(
        await executeRuntimeSettingsCommand(
          {
            name,
            action: value === 'default' ? 'reset' : value === 'status' ? 'status' : 'set',
            value,
            channelId: targetChannelId,
            parentChannelId,
            platform: 'discord',
          },
          { config, resolver }
        )
      );
    const rejectDisabledCommand = async (enabled: boolean | undefined) => {
      if (enabled) return false;
      await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
      return true;
    };

    if (interaction.commandName === 'workspace') {
      const subcommand = interaction.options.getSubcommand();
      try {
        if (subcommand === 'status') {
          const selected = await workspaceRegistry.resolve('discord', settingsChannelId);
          const agent = channelAgent('discord', settingsChannelId);
          const agentWorkspace = agent
            ? await workspaceRegistry.resolveById(agent.workspaceId || 'default')
            : undefined;
          const activeId = getActiveSessionId(channelId);
          const active = activeId ? getSessionEntry(activeId) : undefined;
          const activeWorkspace = active?.workspaceId
            ? workspaceRegistry.getById(active.workspaceId)
            : undefined;
          await interaction.reply({
            content: [
              `チャンネル設定: ${selected.name}`,
              `チャンネル設定のパス: \`${selected.path}\``,
              ...(agent && agentWorkspace
                ? [
                    `選択中のエージェント: ${agent.name}`,
                    `エージェントのパス: \`${agentWorkspace.path}\``,
                  ]
                : []),
              activeWorkspace
                ? `現在のセッション: ${activeWorkspace.name}（変更は次の /new から反映）`
                : '現在のセッション: この場所では未固定（スレッド内のセッションは各スレッドで確認）',
              ...(active?.workspacePath || activeWorkspace?.path
                ? [`現在のセッションのパス: \`${active?.workspacePath || activeWorkspace?.path}\``]
                : []),
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

    if (interaction.commandName === 'secret') {
      if (processManager.isRunning(channelId)) {
        await interaction.reply({
          content: '処理の完了後、または /stop の後に切り替えてください。',
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const mode = interaction.options.getString('mode') || 'status';
      const result = await handleSecretConversationCommand({
        registry: workspaceRegistry,
        platform: 'discord',
        contextKey: channelId,
        bindingKey: settingsChannelId,
        userText: `/secret ${mode}`,
      });
      if (mode !== 'status') agentRunner.destroy?.(channelId);
      await interaction.editReply(result!.result);
      return;
    }

    if (interaction.commandName === 'new') {
      closeActiveSession(channelId, 'new');
      agentRunner.destroy?.(channelId);
      await interaction.reply('🆕 新しいセッションを開始しました');
      return;
    }

    if (interaction.commandName === 'retitle') {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({
          content: '❌ このコマンドはDiscordスレッド内でのみ使えます',
          ephemeral: true,
        });
        return;
      }
      const appSessionId = getActiveSessionId(channelId);
      const entry = appSessionId ? getSessionEntry(appSessionId) : undefined;
      if (!appSessionId || !entry) {
        await interaction.reply({ content: '再生成できるセッションがありません', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        const registeredWorkspace = entry.workspaceId
          ? await workspaceRegistry.resolveById(entry.workspaceId)
          : await workspaceRegistry.resolveById('default');
        const workspace = entry.workspacePath
          ? await workspaceRegistry.resolveSnapshot(registeredWorkspace.id, entry.workspacePath)
          : registeredWorkspace;
        const titleSource = buildAiSessionTitleSource(
          readSessionMessages(workspace.path || workdir, appSessionId)
            .filter((message) => message.role === 'user' && typeof message.content === 'string')
            .map((message) => message.content as string)
        );
        if (!titleSource) throw new Error('タイトル生成に使える会話がありません');

        const title = await generateAiSessionTitle({
          runner: agentRunner,
          appSessionId: `${appSessionId}:retitle`,
          userText: titleSource,
          runOptions: {
            settingsChannelId,
            platform: 'discord',
            workdir: workspace.path || workdir,
          },
        });
        await interaction.channel.setName(title);
        updateSessionTitle(appSessionId, title);
        await interaction.editReply(`✅ スレッドタイトルを「${title}」へ変更しました`);
      } catch (error) {
        console.warn('[session-title] Failed to retitle Discord thread:', error);
        await interaction.editReply('❌ スレッドタイトルを再生成できませんでした');
      }
      return;
    }

    if (interaction.commandName === 'stop') {
      const workRun = findAgentWork('discord', channelId);
      const executionKey = workRun ? `web-chat:${workRun.appSessionId}` : channelId;
      const managedProcessStopped = await processManager.stopAndWait(executionKey);
      const stopped = managedProcessStopped || agentRunner.cancel?.(executionKey) || false;
      if (stopped) {
        await interaction.reply('🛑 タスクを停止しました');
      } else {
        await interaction.reply({ content: '実行中のタスクはありません', ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'help') {
      await interaction.reply({ content: commandHelp('discord', config), ephemeral: true });
      return;
    }

    if (interaction.commandName === 'settings') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const message = await executeChatSettings(
          interaction.options.getString('item') || undefined,
          interaction.options.getString('value') || undefined,
          { platform: 'discord', channelId: settingsChannelId },
          { config, resolver, agentRunner, modelDiscovery: autocompleteDiscoverModels }
        );
        const chunks = splitDiscordMessage(message, DISCORD_SAFE_LENGTH);
        await interaction.editReply({ content: chunks[0] });
        for (const content of chunks.slice(1))
          await interaction.followUp({ content, ephemeral: true });
      } catch (error) {
        await interaction.editReply({
          content: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (interaction.commandName === 'agent') {
      try {
        const action = interaction.options.getSubcommand();
        const result =
          action === 'list'
            ? listSelectableAgents()
                .map((agent) => `${agent.name}: ${agent.id}`)
                .join('\n') || '登録済みのエージェントはありません'
            : await executeRuntimeSettingsCommand(
                {
                  name: 'agent',
                  action,
                  value: interaction.options.getString('id') || undefined,
                  platform: 'discord',
                  channelId: settingsChannelId,
                },
                { config, resolver, agentRunner }
              );
        await interaction.reply({ content: result, ephemeral: true });
      } catch (error) {
        await interaction.reply({
          content: error instanceof Error ? error.message : String(error),
          ephemeral: true,
        });
      }
      return;
    }
    if (interaction.commandName === 'backend') {
      await interaction.deferReply();
      try {
        const sub = interaction.options.getSubcommand();
        if (sub === 'models') {
          await interaction.editReply(
            await executeModelsCommand(interaction.options.getString('type') || undefined, resolver)
          );
          return;
        }
        const backendValue =
          sub === 'set' ? (interaction.options.getString('type', true) as AgentBackend) : undefined;
        const modelValue =
          sub === 'set' ? (interaction.options.getString('model') ?? undefined) : undefined;
        const rawEffort = sub === 'set' ? interaction.options.getString('effort') : undefined;
        const scope = interaction.options.getString('scope') ?? 'channel';
        const effortValue =
          rawEffort && rawEffort !== 'none' ? (rawEffort as EffortLevel) : undefined;
        const result = await executeRuntimeSettingsCommand(
          {
            name: 'backend',
            action: sub,
            backend: backendValue,
            model: modelValue,
            effort: effortValue,
            scope,
            channelId: settingsChannelId,
            contextKey: interaction.channelId,
            platform: 'discord',
          },
          { config, resolver, modelDiscovery: discoverModels, agentRunner }
        );
        if (sub !== 'status' && scope === 'channel') agentRunner.switchBackend?.(settingsChannelId);
        await interaction.editReply(result);
      } catch (error) {
        await interaction.editReply(formatAgentErrorForUser(error));
      }
      return;
    }

    if (interaction.commandName === 'autoreply') {
      if (await rejectDisabledCommand(config.discord.allowAutoreplyCommand)) return;
      const mode = interaction.options.getString('mode', true) as
        'status' | 'on' | 'off' | 'default';
      await replyWithRuntimeSetting(
        'autoreply',
        mode,
        channelId,
        settingsChannelId !== channelId ? settingsChannelId : undefined
      );
      return;
    }

    if (interaction.commandName === 'threadmode') {
      if (await rejectDisabledCommand(config.discord.allowThreadModeCommand)) return;

      const mode = interaction.options.getString('mode', true) as
        'status' | 'on' | 'off' | 'default';
      await replyWithRuntimeSetting('threadmode', mode);
      return;
    }

    if (interaction.commandName === 'schedule') {
      await handleScheduleCommand(interaction, scheduler, config.scheduler);
      return;
    }

    if (interaction.commandName === 'skill') {
      const skillName = interaction.options.getString('name');
      if (!skillName) {
        await interaction.reply(formatSkillList(currentSkills));
        return;
      }
      if (!currentSkills.some((skill) => skill.name === skillName)) {
        await interaction.reply({
          content: `スキル \`${skillName}\` は現在のWorkspaceにありません`,
          ephemeral: true,
        });
        return;
      }
      await handleSkillCommand(
        interaction,
        agentRunner,
        config,
        channelId,
        settingsChannelId,
        skillName,
        workspaceRegistry,
        workdir
      );
      return;
    }

    // Resolve direct aliases against this conversation's effective workspace.
    const matchedSkill = skillCommandAliases(currentSkills).get(interaction.commandName);

    if (matchedSkill) {
      await handleSkillCommand(
        interaction,
        agentRunner,
        config,
        channelId,
        settingsChannelId,
        matchedSkill.name,
        workspaceRegistry,
        workdir
      );
      return;
    }
  };
}
