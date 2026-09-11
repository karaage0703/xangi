import { describe, expect, it, vi } from 'vitest';
import { backendAuthenticationSnapshot, updateBackendTool } from '../src/backend-auth-status.js';
import { GUIDED_BACKENDS, type DetectedBackend } from '../src/setup/guided-onboarding.js';

function detected(id: DetectedBackend['id']): DetectedBackend {
  const backend = GUIDED_BACKENDS.find((candidate) => candidate.id === id)!;
  return { ...backend, executable: `/tools/${backend.command}`, version: `${backend.command} 1.0` };
}

describe('backend authentication status', () => {
  it('reports every supported login-capable backend without exposing command output', async () => {
    const statuses = await backendAuthenticationSnapshot(new Set(), {
      detectedBackends: [detected('codex'), detected('opencode'), detected('grok')],
      runCommand: vi.fn(async (command) => ({
        exitCode: command.endsWith('opencode') ? 1 : 0,
        output: command.endsWith('opencode') ? 'authentication required secret-token' : 'account',
        timedOut: false,
      })),
      probeCopilot: vi.fn(async () => 'logged-in'),
    });

    expect(statuses).toHaveLength(GUIDED_BACKENDS.length);
    expect(statuses.find((item) => item.id === 'codex')?.state).toBe('logged-in');
    expect(statuses.find((item) => item.id === 'codex')?.updateSupported).toBe(true);
    expect(statuses.find((item) => item.id === 'opencode')?.state).toBe('not-authenticated');
    expect(statuses.find((item) => item.id === 'grok')?.state).toBe('logged-in');
    expect(statuses.find((item) => item.id === 'claude-code')?.state).toBe('not-installed');
    expect(JSON.stringify(statuses)).not.toContain('secret-token');
  });

  it('distinguishes configured API keys from login and unknown failures', async () => {
    const statuses = await backendAuthenticationSnapshot(
      new Set(['ANTHROPIC_API_KEY', 'CURSOR_API_KEY']),
      {
        detectedBackends: [detected('claude-code'), detected('cursor'), detected('antigravity')],
        runCommand: vi.fn(async (command) => ({
          exitCode: command.endsWith('agy') ? 2 : 1,
          output: command.endsWith('agy') ? 'network unavailable' : 'login required',
          timedOut: false,
        })),
      }
    );

    expect(statuses.find((item) => item.id === 'claude-code')).toMatchObject({
      state: 'api-key',
      apiKeyConfigured: true,
    });
    expect(statuses.find((item) => item.id === 'cursor')?.state).toBe('api-key');
    expect(statuses.find((item) => item.id === 'antigravity')?.state).toBe('unknown');
  });

  it('treats an empty OpenCode credential list as unauthenticated', async () => {
    const statuses = await backendAuthenticationSnapshot(new Set(), {
      detectedBackends: [detected('opencode')],
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        output: '0 credentials',
        timedOut: false,
      })),
    });
    expect(statuses.find((item) => item.id === 'opencode')?.state).toBe('not-authenticated');
  });

  it.each([
    ['codex', ['update']],
    ['opencode', ['upgrade']],
    ['claude-code', ['update']],
    ['cursor', ['update']],
    ['grok', ['update']],
    ['antigravity', ['update']],
    ['github-copilot', ['update', 'stable']],
  ] as const)('updates %s with its fixed self-update command', async (id, updateArgs) => {
    const runUpdate = vi.fn(async () => ({ exitCode: 0, output: 'done', timedOut: false }));
    await expect(
      updateBackendTool(id, {
        detectedBackends: [detected(id)],
        runUpdate,
        readVersion: async () => `${id} 2.0`,
      })
    ).resolves.toMatchObject({ id, version: `${id} 2.0` });
    expect(runUpdate).toHaveBeenCalledWith(`/tools/${detected(id).command}`, [...updateArgs]);
  });

  it('rejects unknown and missing backend update requests', async () => {
    await expect(updateBackendTool('unknown', { detectedBackends: [] })).rejects.toThrow(
      '更新できないAIサービスです'
    );
    await expect(updateBackendTool('codex', { detectedBackends: [] })).rejects.toThrow(
      'CodexのCLIが見つかりません'
    );
  });

  it('does not expose updater output when an update fails', async () => {
    await expect(
      updateBackendTool('codex', {
        detectedBackends: [detected('codex')],
        runUpdate: async () => ({
          exitCode: 1,
          output: 'private updater detail secret-token',
          timedOut: false,
        }),
      })
    ).rejects.toThrow('Codexの更新に失敗しました');
  });
});
