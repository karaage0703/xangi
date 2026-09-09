import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCodexTurnModels } from '../src/codex-model-evidence.js';
import { recoverCodexModelHistory } from '../src/codex-model-history-recovery.js';
vi.mock('../src/codex-model-evidence.js', () => ({ readCodexTurnModels: vi.fn() }));
const user = { id: 'u', role: 'user', createdAt: '2026-09-01T00:00:00Z', content: 'hello' };
const assistant = {
  id: 'a',
  role: 'assistant',
  createdAt: '2026-09-01T00:01:00Z',
  content: { sessionId: 'historical-provider' },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readCodexTurnModels).mockResolvedValue(['old-model']);
});
describe('historical model recovery', () => {
  it('uses the response provider session and original interval, remains idempotent', async () => {
    const result = await recoverCodexModelHistory([user, assistant], '/old-workspace', '/codex');
    expect(readCodexTurnModels).toHaveBeenCalledWith({
      providerSessionId: 'historical-provider',
      cwd: '/old-workspace',
      startedAt: user.createdAt,
      finishedAt: assistant.createdAt,
      codexHome: '/codex',
    });
    expect(result[0]).toMatchObject({
      turnId: 'recovered:a',
      effectiveModel: 'old-model',
      startedAt: user.createdAt,
      updatedAt: assistant.createdAt,
      source: 'provider',
    });
    expect(
      await recoverCodexModelHistory([user, assistant], '/old-workspace', '/codex', result)
    ).toEqual([]);
  });
  it('does not infer missing linkage or stretch intervals beyond one response', async () => {
    expect(await recoverCodexModelHistory([assistant], '/workspace')).toEqual([]);
    expect(
      await recoverCodexModelHistory([user, { ...assistant, content: {} }, assistant], '/workspace')
    ).toEqual([]);
    expect(readCodexTurnModels).not.toHaveBeenCalled();
  });
  it('preserves unknown evidence and exact new-format snapshots', async () => {
    vi.mocked(readCodexTurnModels).mockResolvedValue([]);
    expect(await recoverCodexModelHistory([user, assistant], '/workspace')).toEqual([]);
    vi.mocked(readCodexTurnModels).mockClear();
    expect(
      await recoverCodexModelHistory(
        [
          user,
          {
            ...assistant,
            content: { ...assistant.content, modelExecution: { source: 'unknown' } },
          },
        ],
        '/workspace'
      )
    ).toEqual([]);
    expect(readCodexTurnModels).not.toHaveBeenCalled();
    expect(
      await recoverCodexModelHistory(
        [user, { ...assistant, modelExecution: { source: 'unknown' } as never }],
        '/workspace'
      )
    ).toEqual([]);
    expect(readCodexTurnModels).not.toHaveBeenCalled();
  });
  it('does not duplicate an existing execution with its original random turn ID', async () => {
    expect(
      await recoverCodexModelHistory([user, assistant], '/workspace', undefined, [
        {
          turnId: 'original-random-id',
          backend: 'codex',
          source: 'unknown',
          status: 'completed',
          providerSessionId: 'historical-provider',
          startedAt: '2026-09-01T00:00:01Z',
          updatedAt: '2026-09-01T00:00:59Z',
          observedModels: [],
        },
      ])
    ).toEqual([]);
    expect(readCodexTurnModels).not.toHaveBeenCalled();
  });
});
