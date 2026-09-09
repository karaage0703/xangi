import type { AgentBackend, EffortLevel } from './config.js';
import type { BackendModel } from './backend-models.js';

export function inferEffortFromModelName(id: string, displayName?: string): string | undefined {
  for (const value of [id, displayName ?? '']) {
    const match = value
      .toLowerCase()
      .match(/(?:^|[- (])(extra[- ]high|xhigh|minimal|medium|high|low|none|max)(?:[- ]fast)?\)?$/);
    if (!match) continue;
    return match[1] === 'extra-high' || match[1] === 'extra high' ? 'xhigh' : match[1];
  }
  return undefined;
}

const BACKEND_EFFORT_LEVELS: Record<string, readonly EffortLevel[]> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  opencode: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  cursor: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  grok: ['low', 'medium', 'high', 'xhigh', 'max'],
  antigravity: ['low', 'medium', 'high'],
  'github-copilot': ['low', 'medium', 'high', 'xhigh', 'max'],
  'local-llm': [],
};

export function getSupportedEffortLevels(backend: AgentBackend): readonly EffortLevel[] {
  return BACKEND_EFFORT_LEVELS[backend] ?? [];
}

export function supportsEffort(backend: AgentBackend, effort: EffortLevel): boolean {
  return getSupportedEffortLevels(backend).includes(effort);
}

export function getSupportedEffortLevelsForModel(
  backend: AgentBackend,
  model?: Pick<BackendModel, 'supportedEfforts'>
): readonly EffortLevel[] {
  const backendEfforts = getSupportedEffortLevels(backend);
  if (model?.supportedEfforts === undefined) return backendEfforts;
  return backendEfforts.filter((effort) => model.supportedEfforts?.includes(effort));
}

export function requiresExplicitModelForEffort(backend: AgentBackend): boolean {
  return backend === 'cursor';
}

export function hasUsableModelForEffort(backend: AgentBackend, model?: string): boolean {
  return !requiresExplicitModelForEffort(backend) || Boolean(model && model !== 'auto');
}
