import type { AgentRunner } from './agent-runner.js';
import type { BackendResolver } from './backend-resolver.js';
import type { Config } from './config.js';
import {
  executeRuntimeSettingsCommand,
  type RuntimeSettingsRequest,
  type RuntimeSettingsDependencies,
} from './runtime-settings-command.js';
import {
  getChannelAutoReply,
  getChannelCompletionNotifyMode,
  getChannelThreadMode,
  getReplySuggestionsEnabled,
  getSlackChannelAutoReply,
  loadSettings,
} from './settings.js';

export interface WebRuntimeSettingsSnapshot {
  backend: {
    enabled: boolean;
    value: ReturnType<BackendResolver['getDefault']>;
    options: string[];
    applyMode: 'next-turn';
  };
  replySuggestions: {
    enabled: boolean;
    value: 'inherit' | 'on' | 'off';
    effective: { discord: boolean; slack: boolean; web: boolean };
    applyMode: 'immediate';
  };
  respondToBots: {
    enabled: boolean;
    value: boolean;
    applyMode: 'immediate';
  };
}

export function webRuntimeSettingsSnapshot(
  config: Config,
  resolver: BackendResolver
): WebRuntimeSettingsSnapshot {
  const settings = loadSettings();
  return {
    backend: {
      enabled: config.features?.backendSwitching !== false,
      value: resolver.getDefault(),
      options: resolver.getSelectableBackends(),
      applyMode: 'next-turn',
    },
    replySuggestions: {
      enabled: config.features?.runtimeSettings !== false,
      value:
        settings.replySuggestionsEnabled === undefined
          ? 'inherit'
          : settings.replySuggestionsEnabled
            ? 'on'
            : 'off',
      effective: {
        discord: getReplySuggestionsEnabled(settings, config.discord.replySuggestions !== false),
        slack: getReplySuggestionsEnabled(settings, config.slack.replySuggestions !== false),
        web: getReplySuggestionsEnabled(settings, config.web.replySuggestions),
      },
      applyMode: 'immediate',
    },
    respondToBots: {
      enabled:
        config.features?.runtimeSettings !== false &&
        config.discord.allowRespondToBotsCommand !== false,
      value: config.discord.respondToBotsEnabled ?? false,
      applyMode: 'immediate',
    },
  };
}

export function webChannelRuntimeSettingsSnapshot(
  platform: 'discord' | 'slack',
  channelId: string,
  config: Config,
  resolver: BackendResolver
) {
  const settings = loadSettings();
  const override = resolver.getChannelOverride(channelId);
  const resolved = resolver.resolve(channelId);
  const autoReplyOverrides =
    platform === 'discord' ? settings.discordAutoReplyChannels : settings.slackAutoReplyChannels;
  const autoReplyDefault =
    platform === 'discord' ? false : Boolean(config.slack.autoReplyChannels?.includes(channelId));
  const autoReplyEffective =
    platform === 'discord'
      ? getChannelAutoReply(settings, channelId, autoReplyDefault)
      : getSlackChannelAutoReply(settings, channelId, autoReplyDefault);
  const localLlmDefault = process.env.LOCAL_LLM_MODE === 'chat' ? 'chat' : 'agent';
  const notifyOverride = settings.discordCompletionNotifyChannels?.[channelId];
  const threadModeOverride = settings.discordThreadModeChannels?.[channelId];

  return {
    backend: {
      value: override?.backend ?? 'inherit',
      effective: {
        backend: resolved.backend,
        model: resolved.model,
        effort: resolved.effort,
      },
    },
    llmMode: {
      value: override?.localLlmMode ?? 'inherit',
      effective: resolved.localLlmMode ?? localLlmDefault,
    },
    autoReply: {
      value:
        autoReplyOverrides && Object.hasOwn(autoReplyOverrides, channelId)
          ? autoReplyOverrides[channelId]
            ? 'on'
            : 'off'
          : 'inherit',
      effective: autoReplyEffective ? 'on' : 'off',
    },
    ...(platform === 'discord'
      ? {
          notify: {
            value: notifyOverride ?? 'inherit',
            effective: getChannelCompletionNotifyMode(
              settings,
              channelId,
              config.discord.completionNotifyMode ?? 'message'
            ),
          },
          threadMode: {
            value: threadModeOverride === undefined ? 'inherit' : threadModeOverride ? 'on' : 'off',
            effective: getChannelThreadMode(
              settings,
              channelId,
              config.discord.replyInThread ?? false
            )
              ? 'on'
              : 'off',
          },
        }
      : {}),
  };
}

export async function updateWebRuntimeSetting(
  input: Record<string, unknown>,
  dependencies: {
    config: Config;
    resolver: BackendResolver;
    agentRunner: AgentRunner;
    modelDiscovery?: RuntimeSettingsDependencies['modelDiscovery'];
  }
): Promise<string> {
  const name = String(input.name ?? '');
  if (
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
    throw new Error('Web設定から変更できない項目です');
  }
  const request: RuntimeSettingsRequest = {
    name,
    action: String(input.action ?? ''),
    value: input.value === undefined ? undefined : String(input.value),
    backend: input.backend === undefined ? undefined : String(input.backend),
    model: input.model === undefined ? undefined : String(input.model),
    effort: input.effort === undefined ? undefined : String(input.effort),
    channelId: input.channelId === undefined ? undefined : String(input.channelId),
    platform:
      name === 'respondtobots'
        ? 'discord'
        : input.platform === undefined
          ? undefined
          : String(input.platform),
    scope:
      name === 'backend' ? (input.scope === undefined ? 'global' : String(input.scope)) : undefined,
  };
  return executeRuntimeSettingsCommand(request, {
    config: dependencies.config,
    resolver: dependencies.resolver,
    agentRunner: dependencies.agentRunner,
    modelDiscovery: dependencies.modelDiscovery,
  });
}
