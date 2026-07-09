import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDiscordSchedulerBridge } from '../src/discord/scheduler-bridge.js';
import { finalizeActiveStreams, activeStreamFinalizerCount } from '../src/stream-finalizer.js';

vi.mock('../src/sessions.js', () => ({
  ensureSession: vi.fn(() => 'app-session-id'),
  setSession: vi.fn(),
}));

type AgentRunResult = { result: string; sessionId: string; attachments?: string[] };

function buildBridge(runImpl: () => Promise<AgentRunResult>) {
  let capturedRunner: ((prompt: string, channelId: string) => Promise<string>) | undefined;
  const thinkingMsg = {
    edit: vi.fn(async (_content: string) => {}),
    delete: vi.fn(async () => {}),
  };
  const channel = { send: vi.fn(async (_content: unknown) => thinkingMsg) };
  const scheduler = {
    registerSender: vi.fn(),
    registerAgentRunner: vi.fn(
      (_platform: string, fn: (prompt: string, channelId: string) => Promise<string>) => {
        capturedRunner = fn;
      }
    ),
  };
  const client = { channels: { fetch: vi.fn(async () => channel) } };
  const config = {
    discord: { injectTimestamp: false },
    agent: { config: { skipPermissions: true } },
  };
  const agentRunner = { run: vi.fn(runImpl) };
  registerDiscordSchedulerBridge({
    scheduler,
    client,
    config,
    agentRunner,
  } as unknown as Parameters<typeof registerDiscordSchedulerBridge>[0]);
  if (!capturedRunner) throw new Error('agent runner not registered');
  return { runner: capturedRunner, thinkingMsg, channel };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('scheduler-bridge stream finalizer (issue #293)', () => {
  beforeEach(async () => {
    // 前のテストの残留 finalizer を掃除（finalize は registry をクリアする）
    await finalizeActiveStreams(10);
  });

  it('turn 実行中に finalize されると「考え中」表示が中断表示に確定する', async () => {
    let resolveRun: (value: AgentRunResult) => void;
    const { runner, thinkingMsg } = buildBridge(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          resolveRun = resolve;
        })
    );

    const turn = runner('test prompt', 'channel-1');
    await flush();
    expect(activeStreamFinalizerCount()).toBe(1);

    await finalizeActiveStreams();
    expect(thinkingMsg.edit).toHaveBeenCalledWith({
      content: '⏸ プロセス再起動により中断されました',
      components: [],
    });

    resolveRun!({ result: 'done', sessionId: 's1' });
    await turn;
  });

  it('正常完了したら finalizer は解除され、後から finalize しても中断表示にならない', async () => {
    const { runner, thinkingMsg } = buildBridge(async () => ({
      result: 'done',
      sessionId: 's1',
    }));

    await runner('test prompt', 'channel-1');
    expect(activeStreamFinalizerCount()).toBe(0);

    await finalizeActiveStreams();
    expect(thinkingMsg.edit).not.toHaveBeenCalledWith({
      content: '⏸ プロセス再起動により中断されました',
      components: [],
    });
    expect(thinkingMsg.edit).toHaveBeenCalledWith({ content: 'done', components: [] });
  });

  it('agent がエラーで落ちても finalizer は解除される', async () => {
    const { runner } = buildBridge(async () => {
      throw new Error('boom');
    });

    await expect(runner('test prompt', 'channel-1')).rejects.toThrow('boom');
    expect(activeStreamFinalizerCount()).toBe(0);
  });

  it('スケジューラ起点でも処理中メッセージに timeout UI 用ボタンを付ける', async () => {
    const { runner, channel } = buildBridge(async () => ({
      result: 'done',
      sessionId: 's1',
    }));

    await runner('test prompt', 'channel-1');

    expect(channel.send).toHaveBeenCalledWith({
      content: '🤔 考え中...',
      components: expect.any(Array),
    });
  });
});
