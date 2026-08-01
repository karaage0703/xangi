import type { AgentBackend, EffortLevel } from './config.js';
import type { BackendResolver } from './backend-resolver.js';
import { discoverBackendModels, formatBackendModels } from './backend-models.js';
import { getSupportedEffortLevels, supportsEffort } from './backend-effort.js';
import { ValidationError } from './errors.js';

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
  const allowedBackends = resolver.getAllowedBackends();
  let backends: AgentBackend[] = allowedBackends;

  if (requestedBackend) {
    if (!resolver.isBackendAllowed(requestedBackend as AgentBackend)) {
      throw new ValidationError(
        `利用可能なバックエンドを指定してください: ${allowedBackends.join(', ')}`
      );
    }
    backends = [requestedBackend as AgentBackend];
  }

  const discoveries = await Promise.all(backends.map((backend) => discover(backend)));
  const allowedModels = resolver.getAllowedModels();
  return [
    '## 利用可能なモデル',
    ...discoveries.map((item) => formatBackendModels(item, allowedModels)),
  ].join('\n\n');
}

export interface SelectModelOptions {
  backend?: string;
  model?: string;
  effort?: string;
  channelId?: string;
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
  const allowedBackends = resolver.getAllowedBackends();
  const backend = options.backend as AgentBackend | undefined;
  if (!backend || !resolver.isBackendAllowed(backend)) {
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
  if (!resolver.isModelAllowed(options.model)) {
    throw new ValidationError(`model '${options.model}' is not allowed by ALLOWED_MODELS`);
  }

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
    if (selected.supportedEfforts?.length && !selected.supportedEfforts.includes(effort)) {
      throw new ValidationError(
        `model '${selected.id}' supports effort: ${selected.supportedEfforts.join(', ')}`
      );
    }
  }
  resolver.setChannelOverride(options.channelId, {
    backend,
    model: selected.id,
    effort,
  });
  return [
    'モデル設定を保存しました。次のturnから適用されます。',
    `- backend: ${backend}`,
    `- model: ${selected.id}`,
    ...(effort ? [`- effort: ${effort}`] : []),
    `- channel: ${options.channelId}`,
  ].join('\n');
}
