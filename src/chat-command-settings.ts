import { formatSettings, loadSettings } from './settings.js';
import type { ChannelOverride } from './backend-resolver.js';
import {
  executeRuntimeSettingsCommand,
  type RuntimeSettingsDependencies,
} from './runtime-settings-command.js';

import { CHAT_SETTING_ITEMS } from './chat-commands.js';

export async function executeChatSettings(
  item: string | undefined,
  value: string | undefined,
  context: {
    platform: 'discord' | 'web' | 'slack';
    channelId?: string;
    backendDefault?: ChannelOverride;
  },
  dependencies: RuntimeSettingsDependencies
): Promise<string> {
  if (dependencies.config?.features?.runtimeSettings === false)
    throw new Error('この設定は管理者により無効化されています');
  if (!item) {
    if (value) throw new Error('設定項目を指定してください');
    return [
      formatSettings(loadSettings()),
      `対象: ${context.platform}${context.channelId ? ` / ${context.channelId}` : ''}`,
      '詳細設定・Team管理: Web UIの「設定」。通知・応答設定は対象チャンネルを選択して変更できます。',
      'この会話の設定: /settings item:<項目> value:<値>（Webでは /settings 項目 値）。value省略でstatus。',
      'replysuggestionsは全プラットフォーム共通、respondtobotsはDiscord全体の設定です。',
    ].join('\n');
  }
  if (!(CHAT_SETTING_ITEMS as readonly string[]).includes(item))
    throw new Error('設定項目が不正です');
  const mode = value || 'status';
  const action = mode === 'status' ? 'status' : mode === 'default' ? 'reset' : 'set';
  if (item === 'llmmode' && action === 'status' && context.backendDefault) {
    if (!context.channelId) throw new Error('会話を開いてから実行してください');
    const resolved = dependencies.resolver.resolve(context.channelId, context.backendDefault);
    const fallback =
      resolved.backend === 'openrouter' ? process.env.OPENROUTER_MODE : process.env.LOCAL_LLM_MODE;
    return `Local LLM mode: ${resolved.localLlmMode || fallback || 'agent'} (channel: ${context.channelId})`;
  }
  if (item === 'llmeffort') {
    if (
      context.platform === 'discord' &&
      dependencies.config?.discord.allowLlmEffortCommand === false
    )
      throw new Error('この設定は管理者により無効化されています');
    if (!context.channelId) throw new Error('会話を開いてから実行してください');
    const resolved = dependencies.resolver.resolve(context.channelId, context.backendDefault);
    if (action === 'status')
      return `対象: ${context.channelId}\n推論強度: ${resolved.localLlmReasoningEffort || 'default'}`;
    return executeRuntimeSettingsCommand(
      {
        name: 'backend',
        action: 'set',
        platform: context.platform,
        channelId: context.channelId,
        backend: resolved.backend,
        model: resolved.model,
        effort: resolved.effort,
        localLlmMode: resolved.localLlmMode,
        localLlmReasoningEffort: action === 'reset' ? '' : mode,
      },
      dependencies
    );
  }
  return executeRuntimeSettingsCommand(
    { name: item, action, value: mode, platform: context.platform, channelId: context.channelId },
    dependencies
  );
}
