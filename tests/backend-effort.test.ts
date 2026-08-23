import { describe, expect, it } from 'vitest';
import { getSupportedEffortLevels, supportsEffort } from '../src/backend-effort.js';

describe('backend effort capabilities', () => {
  it('supports all configured levels for CLI backends with full effort support', () => {
    for (const backend of [
      'claude-code',
      'codex',
      'opencode',
      'cursor',
      'grok',
      'github-copilot',
    ] as const) {
      expect(getSupportedEffortLevels(backend)).toEqual(['low', 'medium', 'high', 'max']);
    }
  });

  it('limits Antigravity and rejects graded deterministic/local effort', () => {
    expect(getSupportedEffortLevels('antigravity')).toEqual(['low', 'medium', 'high']);
    expect(supportsEffort('antigravity', 'max')).toBe(false);
    expect(getSupportedEffortLevels('local-llm')).toEqual([]);
    expect(supportsEffort('local-llm', 'high')).toBe(false);
    expect(getSupportedEffortLevels('workspace-search')).toEqual([]);
    expect(supportsEffort('workspace-search', 'high')).toBe(false);
  });
});
