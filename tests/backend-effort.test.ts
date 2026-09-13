import { describe, expect, it } from 'vitest';
import {
  getSupportedEffortLevels,
  getSupportedEffortLevelsForModel,
  inferEffortFromModelName,
  supportsEffort,
} from '../src/backend-effort.js';

describe('backend effort capabilities', () => {
  it('supports the full dynamically reported Codex effort range', () => {
    expect(getSupportedEffortLevels('codex')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it('uses each current CLI effort range', () => {
    expect(getSupportedEffortLevels('claude-code')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(getSupportedEffortLevels('github-copilot')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(getSupportedEffortLevels('grok')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const backend of ['opencode', 'cursor'] as const) {
      expect(getSupportedEffortLevels(backend)).toEqual([
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    }
  });

  it('treats an explicit empty model capability as unsupported', () => {
    expect(getSupportedEffortLevelsForModel('cursor', { supportedEfforts: [] })).toEqual([]);
  });

  it('detects only effort tokens at the end of model names', () => {
    expect(inferEffortFromModelName('gpt-5.5-extra-high-fast')).toBe('xhigh');
    expect(inferEffortFromModelName('gemini-flash', 'Gemini Flash (Medium)')).toBe('medium');
    expect(inferEffortFromModelName('high-quality-model')).toBeUndefined();
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
