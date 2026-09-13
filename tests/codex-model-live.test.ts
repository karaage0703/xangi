import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRunner } from '../src/codex-cli.js';
import { readCodexTurnModels } from '../src/codex-model-evidence.js';
import type { StreamCallbacks } from '../src/agent-runner.js';
vi.mock('../src/codex-model-evidence.js', () => ({ readCodexTurnModels: vi.fn() }));
class TestRunner extends CodexRunner {
  parser(callbacks: StreamCallbacks) {
    return this.createStreamParser(callbacks);
  }
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T13:00:00Z'));
});
afterEach(() => vi.useRealTimers());
describe('Codex live model evidence', () => {
  it('publishes session-linked evidence while running and throttles event-triggered reads', async () => {
    vi.mocked(readCodexTurnModels).mockResolvedValue(['astra']);
    const onModel = vi.fn();
    const parser = new TestRunner({ workdir: '/workspace' }).parser({ onModel });
    parser.handleEvent({ type: 'thread.started', thread_id: 'provider-id' }, 'stream');
    await vi.advanceTimersByTimeAsync(0);
    expect(onModel).toHaveBeenCalledWith('astra');
    expect(readCodexTurnModels).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSessionId: 'provider-id',
        cwd: '/workspace',
        startedAt: '2026-09-08T13:00:00.000Z',
      })
    );
    parser.handleEvent({ type: 'item.started' }, 'stream');
    expect(readCodexTurnModels).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    parser.handleEvent({ type: 'item.started' }, 'stream');
    await vi.advanceTimersByTimeAsync(0);
    expect(readCodexTurnModels).toHaveBeenCalledTimes(2);
    expect(parser.finalize()).toMatchObject({ model: 'astra', models: ['astra'] });
  });
  it.each(['complete', 'error'])('does not emit late evidence after %s', async (ending) => {
    let resolveEvidence!: (models: string[]) => void;
    vi.mocked(readCodexTurnModels).mockReturnValue(
      new Promise((resolve) => {
        resolveEvidence = resolve;
      })
    );
    const onModel = vi.fn();
    const parser = new TestRunner({ workdir: '/workspace' }).parser({ onModel });
    parser.handleEvent({ type: 'thread.started', thread_id: 'provider-id' }, 'stream');
    if (ending === 'complete') parser.finalize();
    else parser.exitErrorDetail?.();
    resolveEvidence(['old-model']);
    await vi.advanceTimersByTimeAsync(0);
    expect(onModel).not.toHaveBeenCalled();
  });
});
