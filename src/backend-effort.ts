import type { AgentBackend, EffortLevel } from './config.js';

const BACKEND_EFFORT_LEVELS = {
  'claude-code': ['low', 'medium', 'high', 'max'],
  codex: ['low', 'medium', 'high', 'max'],
  cursor: ['low', 'medium', 'high', 'max'],
  grok: ['low', 'medium', 'high', 'max'],
  antigravity: ['low', 'medium', 'high'],
  'github-copilot': ['low', 'medium', 'high', 'max'],
  'local-llm': [],
} as const satisfies Record<AgentBackend, readonly EffortLevel[]>;

export function getSupportedEffortLevels(backend: AgentBackend): readonly EffortLevel[] {
  return BACKEND_EFFORT_LEVELS[backend];
}

export function supportsEffort(backend: AgentBackend, effort: EffortLevel): boolean {
  return (BACKEND_EFFORT_LEVELS[backend] as readonly EffortLevel[]).includes(effort);
}

export function requiresExplicitModelForEffort(backend: AgentBackend): boolean {
  return backend === 'cursor';
}
