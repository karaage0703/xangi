/** A snapshot of one execution, independent of mutable channel/CLI defaults. */
export interface ModelExecution {
  turnId: string;
  backend: string;
  configuredModel?: string;
  effectiveModel?: string;
  modelSelection?: string;
  observedModels: string[];
  source: 'provider' | 'configuration' | 'unknown';
  startedAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'failed';
  providerSessionId?: string;
}

/** Model identifiers are metadata, never arbitrary provider response text. */
export function normalizeModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const model = value.trim();
  if (
    !model ||
    model.length > 256 ||
    [...model].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return undefined;
  if (/^(?:default|\(default\)|auto|unknown|<synthetic>|未確認)$/i.test(model)) return undefined;
  return model;
}

export function observeExecutionModel(execution: ModelExecution, value: unknown): boolean {
  const model = normalizeModelId(value);
  if (!model) return false;
  const changed = execution.effectiveModel !== model || execution.source !== 'provider';
  if (!execution.observedModels.includes(model)) execution.observedModels.push(model);
  execution.effectiveModel = model;
  execution.source = 'provider';
  if (changed) execution.updatedAt = new Date().toISOString();
  return changed;
}
