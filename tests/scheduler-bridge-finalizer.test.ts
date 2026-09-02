import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerDiscordSchedulerBridge } from '../src/discord/scheduler-bridge.js';
import { finalizeActiveStreams, activeStreamFinalizerCount } from '../src/stream-finalizer.js';
import {
  clearSessions,
  createSession,
  getActiveSessionId,
  getSessionEntry,
  initSessions,
} from '../src/sessions.js';
import type { AgentRunContext } from '../src/scheduler.js';
import { DiscordTurnCoordinator } from '../src/discord/turn-coordinator.js';

type AgentRunResult = { result: string; sessionId: string; attachments?: string[] };
type StreamCallbacks = {
  onText?: (chunk: string, fullText: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  onComplete?: (result: AgentRunResult) => void;
  onError?: (error: Error) => void;
};

function buildBridge(
  runImpl: (callbacks: StreamCallbacks) => Promise<AgentRunResult>,
  workspaceRegistry?: {
    resolve: (
      platform: string,
      channelId: string
    ) => Promise<{
      id: string;
      name: string;
      path: string;
      isDefault: boolean;
    }>;
  },
  turnCoordinator?: DiscordTurnCoordinator
) {
  let capturedRunner:
    | ((
        prompt: string,
        channelId: string,
        schedule?: undefined,
        context?: AgentRunContext
      ) => Promise<string>)
    | undefined;
  const thinkingMsg = {
    id: 'discord-message-1',
    edit: vi.fn(async (_content: string) => {}),
    delete: vi.fn(async () => {}),
  };
  const channel = { send: vi.fn(async (_content: unknown) => thinkingMsg) };
  const scheduler = {
    registerSender: vi.fn(),
    registerAgentRunner: vi.fn(
      (
        _platform: string,
        fn: (
          prompt: string,
          channelId: string,
          schedule?: undefined,
          context?: AgentRunContext
        ) => Promise<string>
      ) => {
        capturedRunner = fn;
      }
    ),
  };
  const client = { channels: { fetch: vi.fn(async () => channel) } };
  const config = {
    discord: { injectTimestamp: false },
    agent: { config: { skipPermissions: true } },
  };
  const agentRunner = {
    runStream: vi.fn(async (_prompt: string, callbacks: StreamCallbacks) => {
      try {
        const result = await runImpl(callbacks);
        callbacks.onComplete?.(result);
        return result;
      } catch (error) {
        callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }),
  };
  registerDiscordSchedulerBridge({
    scheduler,
    client,
    config,
    agentRunner,
    workspaceRegistry,
    turnCoordinator,
  } as unknown as Parameters<typeof registerDiscordSchedulerBridge>[0]);
  if (!capturedRunner) throw new Error('agent runner not registered');
  return { runner: capturedRunner, thinkingMsg, channel, agentRunner };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('scheduler-bridge stream finalizer (issue #293)', () => {
  let sessionsDir: string;

  beforeEach(async () => {
    // 前のテストの残留 finalizer を掃除（finalize は registry をクリアする）
    await finalizeActiveStreams(10);
    clearSessions();
    sessionsDir = mkdtempSync(join(tmpdir(), 'xangi-scheduler-bridge-'));
    initSessions(sessionsDir);
  });

  afterEach(() => {
    clearSessions();
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('通常ターン中のscheduler taskを共有調停器で待たせ、完了後に開始する', async () => {
    const coordinator = new DiscordTurnCoordinator();
    let releaseNormal!: () => void;
    const normal = coordinator.tryRun(
      'channel-1',
      () => new Promise<void>((resolve) => (releaseNormal = resolve))
    );
    const { runner, agentRunner } = buildBridge(
      async () => ({ result: 'scheduled', sessionId: 'scheduler-session' }),
      undefined,
      coordinator
    );

    const scheduled = runner('scheduled prompt', 'channel-1');
    await flush();
    expect(agentRunner.runStream).not.toHaveBeenCalled();

    releaseNormal();
    await normal;
    await scheduled;
    expect(agentRunner.runStream).toHaveBeenCalledTimes(1);
  });

  it('queued scheduler taskの onStart を実行開始時に呼ぶ', async () => {
    const coordinator = new DiscordTurnCoordinator();
    let releaseNormal!: () => void;
    const normal = coordinator.tryRun(
      'channel-1',
      () => new Promise<void>((resolve) => (releaseNormal = resolve))
    );
    const { runner, agentRunner } = buildBridge(
      async () => ({ result: 'scheduled', sessionId: 'scheduler-session' }),
      undefined,
      coordinator
    );
    const onStart = vi.fn();

    const scheduled = runner('scheduled prompt', 'channel-1', undefined, { onStart });
    await flush();
    expect(onStart).not.toHaveBeenCalled();

    releaseNormal();
    await normal;
    await scheduled;
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.invocationCallOrder[0]).toBeLessThan(
      agentRunner.runStream.mock.invocationCallOrder[0]
    );
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

    const onDelivery = vi.fn();
    await runner('test prompt', 'channel-1', undefined, { onDelivery });
    expect(activeStreamFinalizerCount()).toBe(0);

    await finalizeActiveStreams();
    expect(thinkingMsg.edit).not.toHaveBeenCalledWith({
      content: '⏸ プロセス再起動により中断されました',
      components: [],
    });
    expect(thinkingMsg.edit).toHaveBeenCalledWith({
      content: expect.stringMatching(/^done\n\n✅ 完了（⏱ /),
      components: [],
    });
    expect(onDelivery).toHaveBeenCalledWith({
      platform: 'discord',
      destinationId: 'channel-1',
      messageIds: ['discord-message-1'],
      sessionId: 's1',
    });
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

  it('スケジューラ起点の tool event をストリーミング経路で受け取る', async () => {
    const { runner, agentRunner } = buildBridge(async (callbacks) => {
      callbacks.onToolUse?.('Read', { file_path: 'skills/xs-example/SKILL.md' });
      callbacks.onToolUse?.('Bash', { command: 'uv run example.py' });
      return { result: 'done', sessionId: 's1' };
    });

    await runner('xs-example を実行して', 'channel-1');

    const activity = await import('../src/activity-store.js');
    const appSessionId = agentRunner.runStream.mock.calls[0]?.[2]?.appSessionId as string;
    const snapshot = activity.getActivity(`discord-schedule:${appSessionId}`);
    expect(snapshot?.toolLines).toEqual([
      'Read: skills/xs-example/SKILL.md',
      'Bash: uv run example.py',
    ]);
    expect(snapshot?.state).toBe('complete');
    expect(agentRunner.runStream).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        sessionId: undefined,
        channelId: 'channel-1',
        runnerKey: 'schedule:channel-1',
        appSessionId: expect.stringMatching(/^scheduler-run-discord-/),
      })
    );
  });

  it('スケジューラ実行はチャンネル設定のワークスペースを使う', async () => {
    const workspaceRegistry = {
      resolve: vi.fn(async () => ({
        id: 'project',
        name: 'project',
        path: '/mounted/project',
        isDefault: false,
      })),
    };
    const { runner, agentRunner } = buildBridge(
      async () => ({ result: 'done', sessionId: 's1' }),
      workspaceRegistry
    );

    await runner('scheduled prompt', 'channel-1');

    expect(workspaceRegistry.resolve).toHaveBeenCalledWith('discord', 'channel-1');
    expect(agentRunner.runStream).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        channelId: 'channel-1',
        runnerKey: 'schedule:channel-1',
        settingsChannelId: 'channel-1',
        workdir: '/mounted/project',
      })
    );
  });

  it('スケジューラ実行で同じDiscordチャンネルの通常セッションを更新しない', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xangi-discord-scheduler-'));
    try {
      initSessions(tmpDir);
      const interactiveId = createSession('channel-1', { platform: 'discord' });
      const interactiveBefore = structuredClone(getSessionEntry(interactiveId));
      const { runner } = buildBridge(async () => ({ result: 'done', sessionId: 'scheduled' }));

      await runner('scheduled prompt', 'channel-1');

      expect(getActiveSessionId('channel-1')).toBe(interactiveId);
      expect(getSessionEntry(interactiveId)).toEqual(interactiveBefore);
    } finally {
      clearSessions();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('同じDiscordチャンネルのscheduled turnを直列に実行する', async () => {
    const resolvers: Array<(value: AgentRunResult) => void> = [];
    let started = 0;
    const { runner } = buildBridge(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          started += 1;
          resolvers.push(resolve);
        })
    );

    const first = runner('first prompt', 'channel-1');
    const second = runner('second prompt', 'channel-1');
    await flush();

    expect(started).toBe(1);

    resolvers[0]({ result: 'first done', sessionId: 's1' });
    await first;
    await flush();

    expect(started).toBe(2);
    resolvers[1]({ result: 'second done', sessionId: 's2' });
    await second;
  });

  it('異なるDiscordチャンネルのscheduled turnは並列に実行する', async () => {
    const resolvers: Array<(value: AgentRunResult) => void> = [];
    let started = 0;
    const { runner } = buildBridge(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          started += 1;
          resolvers.push(resolve);
        })
    );

    const first = runner('first prompt', 'channel-1');
    const second = runner('second prompt', 'channel-2');
    await flush();

    expect(started).toBe(2);

    resolvers[0]({ result: 'first done', sessionId: 's1' });
    resolvers[1]({ result: 'second done', sessionId: 's2' });
    await Promise.all([first, second]);
  });

  it('先行turnが失敗しても同じチャンネルの次のturnを実行する', async () => {
    let attempt = 0;
    const { runner } = buildBridge(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first failed');
      return { result: 'second done', sessionId: 's2' };
    });

    const first = runner('first prompt', 'channel-1');
    const second = runner('second prompt', 'channel-1');

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('second done');
    expect(attempt).toBe(2);
  });

  it('本文もsession IDもない終了を成功扱いしない', async () => {
    const { runner, thinkingMsg } = buildBridge(async () => ({
      result: '',
      sessionId: '',
    }));

    await expect(runner('test prompt', 'channel-1')).rejects.toThrow(
      'Agent process ended without a response or session ID'
    );
    expect(thinkingMsg.delete).not.toHaveBeenCalled();
    expect(thinkingMsg.edit).toHaveBeenCalledWith({
      content: expect.stringMatching(
        /Agent process ended without a response or session ID[\s\S]*⚠️ 終了（⏱ /
      ),
      components: [],
    });
  });

  it('session IDがある空応答は従来どおり投稿を省略する', async () => {
    const { runner, thinkingMsg } = buildBridge(async () => ({
      result: '',
      sessionId: 's1',
    }));

    await expect(runner('test prompt', 'channel-1')).resolves.toBe('');
    expect(thinkingMsg.delete).toHaveBeenCalledOnce();
  });
});
