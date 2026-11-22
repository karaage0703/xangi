import { channelAgent, saveChannelAgentSettings } from './agent-selection.js';
import { DEFAULT_TEAM_AGENT_ID } from './teams.js';
import type { AgentBackend, EffortLevel } from './config.js';
import type { BackendResolver } from './backend-resolver.js';
import { discoverBackendModels, formatBackendModels } from './backend-models.js';
import {
  getSupportedEffortLevels,
  getSupportedEffortLevelsForModel,
  supportsEffort,
} from './backend-effort.js';
import { ValidationError } from './errors.js';
import { featureControlsFromEnv } from './feature-controls.js';

function assertBackendSwitchingEnabled(): void {
  if (!featureControlsFromEnv().backendSwitching) {
    throw new ValidationError('backend switching is disabled by BACKEND_SWITCHING_ENABLED=false');
  }
}

export const MODELS_COMMAND_USAGE = '/models [backend]';

export function parseModelsCommand(input: string): string | undefined | null {
  const match = input.trim().match(/^\/models(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+))?\s*$/i);
  if (!match) return null;
  return match[1]?.toLowerCase();
}

export async function executeModelsCommand(
  requestedBackend: string | undefined,
  resolver: BackendResolver,
  discover: typeof discoverBackendModels = discoverBackendModels
): Promise<string> {
  assertBackendSwitchingEnabled();
  const selectableBackends = resolver.getSelectableBackends();
  let backends: AgentBackend[] = selectableBackends;

  if (requestedBackend) {
    if (!resolver.isBackendSelectable(requestedBackend as AgentBackend)) {
      throw new ValidationError(
        `利用可能なバックエンドを指定してください: ${selectableBackends.join(', ')}`
      );
    }
    backends = [requestedBackend as AgentBackend];
  }

  const discoveries = await Promise.all(backends.map((backend) => discover(backend)));
  return ['## 利用可能なモデル', ...discoveries.map(formatBackendModels)].join('\n\n');
}

export interface SelectModelOptions {
  backend?: string;
  model?: string;
  effort?: string;
  channelId?: string;
  platform?: string;
}

/**
 * AI向けモデル選択。動的取得できた正確なモデルIDだけを、次のturnから適用する。
 * 実行中runnerを破棄すると現在のtool call自体が落ちるため、ここではresolverだけを更新する。
 * DynamicRunnerManagerは次回run時にresolver keyの変更を検出し、新しいrunnerを生成する。
 */
export async function selectModelForNextTurn(
  options: SelectModelOptions,
  resolver: BackendResolver,
  discover: typeof discoverBackendModels = discoverBackendModels
): Promise<string> {
  assertBackendSwitchingEnabled();
  const allowedBackends = resolver.getSelectableBackends();
  const backend = options.backend as AgentBackend | undefined;
  if (!backend || !resolver.isBackendSelectable(backend)) {
    throw new ValidationError(
      `models --use: --backend must be one of: ${allowedBackends.join(', ')}`
    );
  }
  if (!options.model) {
    throw new ValidationError('models --use: model ID is required');
  }
  if (!options.channelId) {
    throw new ValidationError(
      'models --use: channel is unavailable. Run inside xangi or pass --channel <channel ID>'
    );
  }
  const { platform, channelId } = options;
  const boundAgent = () =>
    platform === 'discord' || platform === 'slack' ? channelAgent(platform, channelId) : undefined;
  const agent = boundAgent();
  if (agent?.id === DEFAULT_TEAM_AGENT_ID)
    throw new ValidationError('デフォルト担当のAI設定は全体設定から変更してください');
  const discovery = await discover(backend);
  if (discovery.status !== 'available') {
    throw new ValidationError(
      `models --use: ${backend} model discovery is ${discovery.status}: ${discovery.message ?? discovery.source}`
    );
  }
  const selected = discovery.models.find((model) => model.id === options.model);
  if (!selected) {
    throw new ValidationError(
      `models --use: model '${options.model}' was not found in the current ${backend} model list`
    );
  }

  let effort: EffortLevel | undefined;
  if (options.effort) {
    effort = options.effort as EffortLevel;
    if (!supportsEffort(backend, effort)) {
      throw new ValidationError(
        `${backend} supports effort: ${getSupportedEffortLevels(backend).join(', ') || 'none'}`
      );
    }
    const supportedEfforts = getSupportedEffortLevelsForModel(backend, selected);
    if (!supportedEfforts.includes(effort)) {
      throw new ValidationError(
        `model '${selected.id}' supports effort: ${supportedEfforts.join(', ') || 'none'}`
      );
    }
  }
  const currentAgent = boundAgent();
  if (currentAgent?.id !== agent?.id)
    throw new ValidationError('担当が変更されました。現在の担当を確認してから保存してください');
  if (currentAgent) {
    saveChannelAgentSettings(platform!, channelId, currentAgent.id, {
      backend,
      model: selected.id,
      effort,
      localLlmMode: currentAgent.backend === backend ? currentAgent.localLlmMode : undefined,
      localLlmReasoningEffort:
        currentAgent.backend === backend && currentAgent.model === selected.id
          ? currentAgent.localLlmReasoningEffort
          : undefined,
    });
  } else {
    resolver.setChannelOverride(channelId, { backend, model: selected.id, effort });
  }
  return [
    'モデル設定を保存しました。次のturnから適用されます。',
    `- backend: ${backend}`,
    `- model: ${selected.id}`,
    ...(effort ? [`- effort: ${effort}`] : []),
    `- channel: ${options.channelId}`,
  ].join('\n');
}
