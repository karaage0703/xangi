import type { AgentBackend, Config, DiscordCompletionNotifyMode, EffortLevel } from './config.js';
import type { BackendResolver, LocalLlmMode } from './backend-resolver.js';
import {
  getChannelAutoReply,
  getChannelCompletionNotifyMode,
  getChannelThreadMode,
  getReplySuggestionsEnabled,
  getSlackChannelAutoReply,
  loadSettings,
  saveSettings,
} from './settings.js';
import {
  getSupportedEffortLevels,
  requiresExplicitModelForEffort,
  supportsEffort,
} from './backend-effort.js';
import { getBackendDisplayName } from './agent-runner.js';
import { updateEnvKeyValue } from './env-persist.js';
import { ValidationError } from './errors.js';
import type { ChatPlatform } from './prompts/index.js';
import { discoverBackendModels } from './backend-models.js';

export type RuntimeSettingName =
  | 'backend'
  | 'llmmode'
  | 'autoreply'
  | 'notify'
  | 'threadmode'
  | 'replysuggestions'
  | 'respondtobots';

export interface RuntimeSettingsRequest {
  name?: string;
  action?: string;
  value?: string;
  backend?: string;
  model?: string;
  effort?: string;
  channelId?: string;
  platform?: string;
}

export interface RuntimeSettingsDependencies {
  config?: Config;
  resolver: BackendResolver;
  modelDiscovery?: typeof discoverBackendModels;
}

function requireConfig(dependencies: RuntimeSettingsDependencies): Config {
  if (!dependencies.config) {
    throw new ValidationError('runtime_settings: runtime config is unavailable');
  }
  return dependencies.config;
}

function requireChannel(request: RuntimeSettingsRequest): string {
  if (!request.channelId) {
    throw new ValidationError(
      'runtime_settings: channel is unavailable. Run inside xangi or pass --channel <channel ID>'
    );
  }
  return request.channelId;
}

function requirePlatform(request: RuntimeSettingsRequest): ChatPlatform {
  const platform = request.platform as ChatPlatform | undefined;
  if (!platform || !['discord', 'slack', 'web', 'line', 'telegram'].includes(platform)) {
    throw new ValidationError(
      'runtime_settings: platform is unavailable. Run inside xangi or pass --platform <platform>'
    );
  }
  return platform;
}

function requireAction(request: RuntimeSettingsRequest, allowed: string[]): string {
  const action = request.action?.toLowerCase();
  if (!action || !allowed.includes(action)) {
    throw new ValidationError(
      `runtime_settings ${request.name ?? ''}: --action must be one of: ${allowed.join(', ')}`
    );
  }
  return action;
}

function requireValue(request: RuntimeSettingsRequest, allowed: string[]): string {
  const value = request.value?.toLowerCase();
  if (!value || !allowed.includes(value)) {
    throw new ValidationError(
      `runtime_settings ${request.name ?? ''}: --value must be one of: ${allowed.join(', ')}`
    );
  }
  return value;
}

function platformGuard(
  platform: ChatPlatform,
  setting: RuntimeSettingName,
  allowed: ChatPlatform[]
) {
  if (!allowed.includes(platform)) {
    throw new ValidationError(
      `runtime_settings ${setting}: ${platform} is not supported (supported: ${allowed.join(', ')})`
    );
  }
}

async function executeBackend(
  request: RuntimeSettingsRequest,
  resolver: BackendResolver,
  discover?: typeof discoverBackendModels
): Promise<string> {
  const channelId = requireChannel(request);
  const action = requireAction(request, ['show', 'set', 'reset']);
  if (action === 'show') {
    const resolved = resolver.resolve(channelId);
    return [
      '現在のバックエンド設定',
      `- backend: ${getBackendDisplayName(resolved.backend)}`,
      ...(resolved.model ? [`- model: ${resolved.model}`] : []),
      ...(resolved.effort ? [`- effort: ${resolved.effort}`] : []),
      `- source: ${resolver.getChannelOverride(channelId) ? 'channel override' : 'default'}`,
      `- channel: ${channelId}`,
    ].join('\n');
  }
  if (action === 'reset') {
    resolver.deleteChannelOverride(channelId);
    return `バックエンド設定をデフォルト (${resolver.getDefault().backend}) に戻しました。次のturnから適用されます。`;
  }

  const backend = request.backend as AgentBackend | undefined;
  if (!backend || !resolver.isBackendSelectable(backend)) {
    const selectableBackends = resolver.getSelectableBackends();
    throw new ValidationError(
      backend
        ? `バックエンド '${backend}' は現在利用できません。利用可能: ${selectableBackends.join(', ')}`
        : `runtime_settings backend: --backend must be one of: ${selectableBackends.join(', ')}`
    );
  }
  if (request.model && !resolver.isModelAllowed(request.model)) {
    throw new ValidationError(`runtime_settings backend: model '${request.model}' is not allowed`);
  }
  if (request.model && discover) {
    const discovery = await discover(backend);
    if (
      discovery.status === 'available' &&
      !discovery.models.some((model) => model.id === request.model)
    ) {
      throw new ValidationError(
        `runtime_settings backend: model '${request.model}' was not found in the current ${backend} model list`
      );
    }
  }
  const effort = request.effort as EffortLevel | undefined;
  if (effort && !supportsEffort(backend, effort)) {
    throw new ValidationError(
      `runtime_settings backend: ${backend} supports effort: ${getSupportedEffortLevels(backend).join(', ') || 'none'}`
    );
  }
  if (effort && requiresExplicitModelForEffort(backend) && !request.model) {
    throw new ValidationError(
      `runtime_settings backend: ${backend} requires an explicit model for effort`
    );
  }
  resolver.setChannelOverride(channelId, { backend, model: request.model, effort });
  return [
    'バックエンド設定を保存しました。新しいセッションを開始します。次のturnから適用されます。',
    `- backend: ${getBackendDisplayName(backend)}`,
    `- model: ${request.model ?? '(default)'}`,
    ...(effort ? [`- effort: ${effort}`] : []),
    `- channel: ${channelId}`,
  ].join('\n');
}

function executeLlmMode(request: RuntimeSettingsRequest, resolver: BackendResolver): string {
  const channelId = requireChannel(request);
  const action = requireAction(request, ['show', 'set', 'reset']);
  if (action === 'show') {
    const resolved = resolver.resolve(channelId);
    return `Local LLM mode: ${resolved.localLlmMode ?? process.env.LOCAL_LLM_MODE ?? 'agent'} (channel: ${channelId})`;
  }
  if (action === 'reset') {
    resolver.setChannelLocalLlmMode(channelId, null);
    return `Local LLM mode overrideを削除しました。次のturnから適用されます。`;
  }
  const mode = requireValue(request, ['agent', 'lite', 'chat']) as LocalLlmMode;
  resolver.setChannelLocalLlmMode(channelId, mode);
  return `Local LLM modeを${mode}に設定しました。次のturnから適用されます。`;
}

function executeAutoReply(
  request: RuntimeSettingsRequest,
  config: Config,
  platform: ChatPlatform
): string {
  platformGuard(platform, 'autoreply', ['discord', 'slack']);
  const channelId = requireChannel(request);
  const action = requireAction(request, ['show', 'set', 'reset']);
  const settings = loadSettings();
  const isDiscord = platform === 'discord';
  const key = isDiscord ? 'discordAutoReplyChannels' : 'slackAutoReplyChannels';
  const channels = { ...(settings[key] ?? {}) };
  const defaultEnabled = isDiscord
    ? false
    : (config.slack.autoReplyChannels?.includes(channelId) ?? false);
  const effective = () =>
    isDiscord
      ? getChannelAutoReply(loadSettings(), channelId, defaultEnabled)
      : getSlackChannelAutoReply(loadSettings(), channelId, defaultEnabled);

  if (action === 'show') {
    return `${platform} autoreply: ${effective() ? 'on' : 'off'} (channel: ${channelId})`;
  }
  if (action === 'reset') delete channels[channelId];
  else channels[channelId] = requireValue(request, ['on', 'off']) === 'on';
  saveSettings({ [key]: Object.keys(channels).length ? channels : undefined });
  return `${platform} autoreplyを${effective() ? 'on' : 'off'}に設定しました。即時反映済みです。`;
}

function executeNotify(request: RuntimeSettingsRequest, config: Config, platform: ChatPlatform) {
  platformGuard(platform, 'notify', ['discord']);
  const channelId = requireChannel(request);
  const action = requireAction(request, ['show', 'set', 'reset']);
  const settings = loadSettings();
  const defaultMode = config.discord.completionNotifyMode ?? 'message';
  if (action === 'show') {
    return `Discord completion notify: ${getChannelCompletionNotifyMode(settings, channelId, defaultMode)} (channel: ${channelId})`;
  }
  const channels = { ...(settings.discordCompletionNotifyChannels ?? {}) };
  if (action === 'reset') delete channels[channelId];
  else {
    channels[channelId] = requireValue(request, [
      'off',
      'message',
      'mention',
    ]) as DiscordCompletionNotifyMode;
  }
  const saved = saveSettings({
    discordCompletionNotifyChannels: Object.keys(channels).length ? channels : undefined,
  });
  return `Discord completion notifyを${getChannelCompletionNotifyMode(saved, channelId, defaultMode)}に設定しました。即時反映済みです。`;
}

function executeThreadMode(
  request: RuntimeSettingsRequest,
  config: Config,
  platform: ChatPlatform
) {
  platformGuard(platform, 'threadmode', ['discord']);
  const channelId = requireChannel(request);
  const action = requireAction(request, ['show', 'set', 'reset']);
  const settings = loadSettings();
  const defaultEnabled = config.discord.replyInThread ?? false;
  if (action === 'show') {
    return `Discord threadmode: ${getChannelThreadMode(settings, channelId, defaultEnabled) ? 'on' : 'off'} (channel: ${channelId})`;
  }
  const channels = { ...(settings.discordThreadModeChannels ?? {}) };
  if (action === 'reset') delete channels[channelId];
  else channels[channelId] = requireValue(request, ['on', 'off']) === 'on';
  const saved = saveSettings({
    discordThreadModeChannels: Object.keys(channels).length ? channels : undefined,
  });
  return `Discord threadmodeを${getChannelThreadMode(saved, channelId, defaultEnabled) ? 'on' : 'off'}に設定しました。即時反映済みです。`;
}

function executeReplySuggestions(request: RuntimeSettingsRequest, config: Config): string {
  const action = requireAction(request, ['show', 'set', 'reset']);
  if (action === 'show') {
    const settings = loadSettings();
    return [
      'reply suggestions',
      `- Discord: ${getReplySuggestionsEnabled(settings, config.discord.replySuggestions !== false) ? 'on' : 'off'}`,
      `- Slack: ${getReplySuggestionsEnabled(settings, config.slack.replySuggestions !== false) ? 'on' : 'off'}`,
      `- Web: ${getReplySuggestionsEnabled(settings, config.web.replySuggestions) ? 'on' : 'off'}`,
    ].join('\n');
  }
  const value = action === 'reset' ? undefined : requireValue(request, ['on', 'off']) === 'on';
  saveSettings({ replySuggestionsEnabled: value });
  return `reply suggestionsを${value === undefined ? '起動時設定' : value ? 'on' : 'off'}に設定しました。即時反映済みです。`;
}

function executeRespondToBots(
  request: RuntimeSettingsRequest,
  config: Config,
  platform: ChatPlatform
): string {
  platformGuard(platform, 'respondtobots', ['discord']);
  const action = requireAction(request, ['show', 'set', 'reset']);
  if (action === 'show') {
    return `Discord respondtobots: ${config.discord.respondToBotsEnabled ? 'on' : 'off'}`;
  }
  const enabled = action === 'reset' ? false : requireValue(request, ['on', 'off']) === 'on';
  config.discord.respondToBotsEnabled = enabled;
  const persisted = updateEnvKeyValue('RESPOND_TO_BOTS_ENABLED', enabled ? 'true' : 'false');
  const persistence = persisted.ok ? '永続化済み' : `永続化なし (${persisted.reason})`;
  return `Discord respondtobotsを${enabled ? 'on' : 'off'}に設定しました。即時反映済み、${persistence}です。`;
}

export async function executeRuntimeSettingsCommand(
  request: RuntimeSettingsRequest,
  dependencies: RuntimeSettingsDependencies
): Promise<string> {
  const name = request.name?.toLowerCase() as RuntimeSettingName | undefined;
  if (
    !name ||
    ![
      'backend',
      'llmmode',
      'autoreply',
      'notify',
      'threadmode',
      'replysuggestions',
      'respondtobots',
    ].includes(name)
  ) {
    throw new ValidationError(
      'runtime_settings: --name must be one of: backend, llmmode, autoreply, notify, threadmode, replysuggestions, respondtobots'
    );
  }

  if (name === 'backend') {
    return executeBackend(request, dependencies.resolver, dependencies.modelDiscovery);
  }
  if (name === 'llmmode') {
    if (
      request.platform === 'discord' &&
      dependencies.config?.discord.allowLlmModeCommand === false
    ) {
      throw new ValidationError('runtime_settings llmmode: this command is disabled');
    }
    return executeLlmMode(request, dependencies.resolver);
  }
  if (name === 'replysuggestions') {
    return executeReplySuggestions(request, requireConfig(dependencies));
  }

  const platform = requirePlatform(request);
  const config = requireConfig(dependencies);
  if (platform === 'discord') {
    if (name === 'autoreply' && config.discord.allowAutoreplyCommand === false) {
      throw new ValidationError('runtime_settings autoreply: this command is disabled');
    }
    if (name === 'threadmode' && config.discord.allowThreadModeCommand === false) {
      throw new ValidationError('runtime_settings threadmode: this command is disabled');
    }
    if (name === 'respondtobots' && config.discord.allowRespondToBotsCommand === false) {
      throw new ValidationError('runtime_settings respondtobots: this command is disabled');
    }
  }
  if (name === 'autoreply') return executeAutoReply(request, config, platform);
  if (name === 'notify') return executeNotify(request, config, platform);
  if (name === 'threadmode') return executeThreadMode(request, config, platform);
  return executeRespondToBots(request, config, platform);
}
