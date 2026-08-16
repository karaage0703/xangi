/**
 * runWithBubbleEvents の events.* 配信契約をロックするテスト。
 *
 * 4箇所 (web-chat / Discord / Slack / auto-talk) すべてが
 * このラッパー経由で events.* を投げる構造になっているため、ここで仕様を固定する
 * ことで「呼び出し元によって events.* が抜ける」回帰を防ぐ。
 *
 * pull 型 SSE 配信に切り替えたので、テストは external collector ではなく
 * subscribeEvents() でイベントを集める。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunner, RunOptions, StreamCallbacks, RunResult } from '../src/agent-runner.js';

interface ReceivedEvent {
  type: string;
  thread_id: string;
  turn_id: string;
  thread_label?: string;
  platform?: string;
  ts: number;
  [key: string]: unknown;
}

class FakeRunner implements AgentRunner {
  constructor(
    private behavior: (
      prompt: string,
      callbacks: StreamCallbacks,
      options?: RunOptions
    ) => Promise<RunResult>
  ) {}
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    return this.runStream(prompt, {}, options);
  }
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    return this.behavior(prompt, callbacks, options);
  }
}

describe('runWithBubbleEvents', () => {
  let collected: ReceivedEvent[];
  let unsubscribe: () => void;
  let testDir: string;
  const prevWorkspace = process.env.WORKSPACE_PATH;

  beforeEach(async () => {
    vi.resetModules();
    testDir = mkdtempSync(join(tmpdir(), 'bubble-events-test-'));
    process.env.WORKSPACE_PATH = testDir;
    collected = [];
    const ee = await import('../src/events-emitter.js');
    unsubscribe = ee.subscribeEvents((ev) => {
      collected.push(ev as unknown as ReceivedEvent);
    });
  });

  afterEach(() => {
    unsubscribe?.();
    delete process.env.XANGI_EVENTS_ENABLED;
    if (prevWorkspace === undefined) delete process.env.WORKSPACE_PATH;
    else process.env.WORKSPACE_PATH = prevWorkspace;
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('publishes turn.started → message.delta×N → turn.complete in normal flow', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const runner = new FakeRunner(async (_p, cb) => {
      cb.onText?.('a', 'a');
      cb.onText?.('b', 'ab');
      const result = { result: 'ab', sessionId: 'sess-1' };
      cb.onComplete?.(result);
      return result;
    });
    const r = await runWithBubbleEvents(
      runner,
      'hi',
      { threadId: 'web:s1', turnId: 'u1', platform: 'web', userText: 'hi' },
      {}
    );
    expect(r.result).toBe('ab');
    expect(collected.map((e) => e.type)).toEqual([
      'turn.started',
      'message.delta',
      'message.delta',
      'turn.complete',
    ]);
    expect(collected[0].user_text).toBe('hi');
    expect(collected[3].text).toBe('ab');
  });

  it('passes through caller callbacks (onText / onToolUse / onComplete / onError)', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const seen = { texts: [] as string[], tools: [] as string[], complete: 0, error: 0 };
    const runner = new FakeRunner(async (_p, cb) => {
      cb.onText?.('x', 'x');
      cb.onToolUse?.('Bash', { cmd: 'ls' });
      const result = { result: 'x', sessionId: 's' };
      cb.onComplete?.(result);
      return result;
    });
    await runWithBubbleEvents(
      runner,
      'hi',
      { threadId: 't', turnId: 'u', platform: 'web' },
      {
        onText: (_c, full) => seen.texts.push(full),
        onToolUse: (name) => seen.tools.push(name),
        onComplete: () => {
          seen.complete++;
        },
        onError: () => {
          seen.error++;
        },
      }
    );
    expect(seen.texts).toEqual(['x']);
    expect(seen.tools).toEqual(['Bash']);
    expect(seen.complete).toBe(1);
    expect(seen.error).toBe(0);
  });

  it('passes the unexpanded user text to deterministic runners', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    let receivedOptions: RunOptions | undefined;
    const runner = new FakeRunner(async (_prompt, callbacks, options) => {
      receivedOptions = options;
      const result = { result: 'ok', sessionId: 's' };
      callbacks.onComplete?.(result);
      return result;
    });

    await runWithBubbleEvents(
      runner,
      '[platform metadata]\nexpanded prompt',
      { threadId: 't', turnId: 'raw-user-text', platform: 'discord', userText: 'RAGを探して' },
      {}
    );

    expect(receivedOptions?.userText).toBe('RAGを探して');
  });

  it('keeps reply suggestion markup out of shared events while preserving raw callbacks', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const rawTexts: string[] = [];
    const fullResult =
      '回答本文\n<xangi_reply_suggestions>["続けて","詳しく","別案"]</xangi_reply_suggestions>';
    const runner = new FakeRunner(async (_p, cb) => {
      cb.onText?.('回答本文\n<xangi_reply_suggestions>', '回答本文\n<xangi_reply_suggestions>');
      cb.onText?.(
        '["続けて","詳しく","別案"]</xangi_reply_suggestions>',
        fullResult
      );
      const result = { result: fullResult, sessionId: 's' };
      cb.onComplete?.(result);
      return result;
    });

    const result = await runWithBubbleEvents(
      runner,
      'hi',
      {
        threadId: 'web:s1',
        turnId: 'u-suggestions',
        platform: 'web',
        eventTextSanitizer: (text) => text.split('<xangi_reply')[0].trimEnd(),
      },
      { onText: (_chunk, fullText) => rawTexts.push(fullText) }
    );

    expect(result.result).toBe(fullResult);
    expect(rawTexts.at(-1)).toBe(fullResult);
    expect(collected.filter((event) => event.type === 'message.delta')).toEqual([
      expect.objectContaining({ text: '回答本文', full_text: '回答本文' }),
    ]);
    expect(collected.find((event) => event.type === 'turn.complete')?.text).toBe('回答本文');
  });

  it('updates current activity snapshots through the turn lifecycle', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const { getActivity, getTurnHistory, readTurnHistory, clearActivities } = await import(
      '../src/activity-store.js'
    );
    clearActivities();
    const runner = new FakeRunner(async (_p, cb) => {
      cb.onToolUse?.('Bash', { command: 'npm test' });
      cb.onText?.('o', 'ok');
      const result = { result: 'ok', sessionId: 's' };
      cb.onComplete?.(result);
      return result;
    });

    await runWithBubbleEvents(
      runner,
      'hi',
      { threadId: 'web:s1', turnId: 'u-activity', platform: 'web', userText: 'hi' },
      {}
    );

    const activity = getActivity('web:s1');
    expect(activity?.state).toBe('complete');
    expect(activity?.summary).toContain('完了');
    expect(activity?.toolLines).toEqual(['Bash: npm test']);
    expect(activity?.history.map((h) => h.state)).toEqual([
      'thinking',
      'tool',
      'streaming',
      'complete',
    ]);
    expect(activity?.active).toBe(false);

    const logPath = join(testDir, 'logs', 'monitor-activity', 'web_s1.jsonl');
    const logged = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            state: string;
            summary: string;
            toolName?: string;
            toolInputPreview?: string;
          }
      );
    expect(logged.map((e) => e.state)).toEqual(['thinking', 'tool', 'streaming', 'complete']);
    expect(logged[1]).toMatchObject({
      toolName: 'Bash',
      toolInputPreview: '{"command":"npm test"}',
    });
    expect(logged.at(-1)?.summary).toContain('完了');
    expect(getTurnHistory('web:s1')).toEqual([
      expect.objectContaining({ kind: 'tool', turnId: 'u-activity', toolName: 'Bash' }),
      expect.objectContaining({ kind: 'text', turnId: 'u-activity', text: 'o' }),
    ]);
    expect(readTurnHistory('web:s1')).toEqual([
      expect.objectContaining({ kind: 'tool', turnId: 'u-activity', toolName: 'Bash' }),
    ]);
  });

  it('restores the sanitized completed history after in-memory activity is cleared', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const { getTurnHistory, readTurnHistory, clearActivities } = await import(
      '../src/activity-store.js'
    );
    const { withoutFinalResponse } = await import('../src/tool-history.js');
    clearActivities();
    const finalResult = '最終回答です。\n<xangi_reply_suggestions>["続けて"]</xangi_reply_suggestions>';
    const runner = new FakeRunner(async (_p, cb) => {
      cb.onText?.('調べます。', '調べます。');
      cb.onToolUse?.('Read', { file_path: '/tmp/a.txt' });
      cb.onText?.('最終回答です。', '最終回答です。');
      cb.onText?.(
        '<xangi_reply_suggestions>["続けて"]</xangi_reply_suggestions>',
        '<xangi_reply_suggestions>["続けて"]</xangi_reply_suggestions>'
      );
      const result = { result: finalResult, sessionId: 's' };
      cb.onComplete?.(result);
      return result;
    });

    await runWithBubbleEvents(
      runner,
      'hi',
      { threadId: 'discord:restart', turnId: 'discord-msg-restart', platform: 'discord' },
      {}
    );

    const expected = [
      expect.objectContaining({ kind: 'text', text: '調べます。' }),
      expect.objectContaining({ kind: 'tool', toolName: 'Read' }),
    ];
    expect(withoutFinalResponse(getTurnHistory('discord:restart'), finalResult)).toEqual(expected);

    clearActivities();
    expect(readTurnHistory('discord:restart')).toEqual(expected);
  });

  it('keeps tools but hides ambiguous streamed text from legacy completed logs', async () => {
    const { readTurnHistory, clearActivities } = await import('../src/activity-store.js');
    clearActivities();
    const logDir = join(testDir, 'logs', 'monitor-activity');
    mkdirSync(logDir, { recursive: true });
    const events = [
      { ts: '2026-08-13T00:00:00.000Z', state: 'streaming', turnId: 'legacy', text: '途中表示' },
      {
        ts: '2026-08-13T00:00:01.000Z',
        state: 'tool',
        turnId: 'legacy',
        toolName: 'Bash',
        summary: '実行中: Bash: pwd',
      },
      { ts: '2026-08-13T00:00:02.000Z', state: 'streaming', turnId: 'legacy', text: '最終回答' },
      { ts: '2026-08-13T00:00:03.000Z', state: 'complete', turnId: 'legacy', summary: '完了' },
    ];
    writeFileSync(
      join(logDir, 'discord_legacy.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    );

    expect(readTurnHistory('discord:legacy')).toEqual([
      expect.objectContaining({ kind: 'tool', turnId: 'legacy', toolName: 'Bash' }),
    ]);
  });

  it('keeps commentary and tools in order while separating replaced Codex messages', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const { getTurnHistory, clearActivities } = await import('../src/activity-store.js');
    clearActivities();
    const runner = new FakeRunner(async (_p, cb) => {
      cb.onText?.('調べます。', '調べます。');
      cb.onToolUse?.('Read', { file_path: '/tmp/a.txt' });
      cb.onText?.('確認できました。', '確認できました。');
      cb.onToolUse?.('Bash', { command: 'pwd' });
      cb.onText?.('最終回答です。', '最終回答です。');
      const result = { result: '最終回答です。', sessionId: 's' };
      cb.onComplete?.(result);
      return result;
    });

    await runWithBubbleEvents(
      runner,
      'hi',
      { threadId: 'discord:1', turnId: 'discord-msg-1', platform: 'discord' },
      {}
    );

    expect(getTurnHistory('discord:1')).toEqual([
      expect.objectContaining({ kind: 'text', text: '調べます。' }),
      expect.objectContaining({ kind: 'tool', toolName: 'Read' }),
      expect.objectContaining({ kind: 'text', text: '確認できました。' }),
      expect.objectContaining({ kind: 'tool', toolName: 'Bash' }),
    ]);
  });

  it('separates cumulative Claude-style text at tool boundaries', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const { getTurnHistory, clearActivities } = await import('../src/activity-store.js');
    clearActivities();
    const runner = new FakeRunner(async (_p, cb) => {
      cb.onText?.('調査します。', '調査します。');
      cb.onToolUse?.('Read', { file_path: '/tmp/a.txt' });
      cb.onText?.('最終回答です。', '調査します。最終回答です。');
      const result = { result: '調査します。最終回答です。', sessionId: 's' };
      cb.onComplete?.(result);
      return result;
    });

    await runWithBubbleEvents(
      runner,
      'hi',
      { threadId: 'slack:1', turnId: 'slack-msg-1', platform: 'slack' },
      {}
    );

    expect(getTurnHistory('slack:1')).toEqual([
      expect.objectContaining({ kind: 'text', text: '調査します。' }),
      expect.objectContaining({ kind: 'tool', toolName: 'Read' }),
    ]);
  });

  it('coalesces repeated streaming activity history entries', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const { getActivity, clearActivities } = await import('../src/activity-store.js');
    clearActivities();
    const runner = new FakeRunner(async (_p, cb) => {
      cb.onText?.('a', 'a');
      cb.onText?.('b', 'ab');
      cb.onText?.('c', 'abc');
      const result = { result: 'abc', sessionId: 's' };
      cb.onComplete?.(result);
      return result;
    });

    await runWithBubbleEvents(
      runner,
      'hi',
      { threadId: 'web:s1', turnId: 'u-streaming-history', platform: 'web', userText: 'hi' },
      {}
    );

    const activity = getActivity('web:s1');
    expect(activity?.history.map((h) => h.state)).toEqual(['thinking', 'streaming', 'complete']);
    expect(activity?.history[1]?.summary).toBe('応答中: abc');
  });

  it('publishes turn.aborted (not agent.error) when the runner reports cancel via onError', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const runner = new FakeRunner(async (_p, cb) => {
      const err = new Error('Request cancelled by user');
      cb.onError?.(err);
      throw err;
    });
    await expect(
      runWithBubbleEvents(runner, 'hi', { threadId: 't', turnId: 'u', platform: 'web' }, {})
    ).rejects.toThrow('Request cancelled by user');
    const types = collected.map((e) => e.type);
    expect(types).toContain('turn.aborted');
    expect(types).not.toContain('agent.error');
  });

  it('publishes agent.error on non-cancel runner failure', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const runner = new FakeRunner(async () => {
      throw new Error('boom');
    });
    await expect(
      runWithBubbleEvents(runner, 'hi', { threadId: 't', turnId: 'u', platform: 'web' }, {})
    ).rejects.toThrow('boom');
    const errEv = collected.find((e) => e.type === 'agent.error');
    expect(errEv?.message).toBe('boom');
  });

  it('does not double-publish error when runner throws after onError', async () => {
    const { runWithBubbleEvents } = await import('../src/bubble-events-runner.js');
    const runner = new FakeRunner(async (_p, cb) => {
      const err = new Error('boom');
      cb.onError?.(err);
      throw err;
    });
    await expect(
      runWithBubbleEvents(runner, 'hi', { threadId: 't', turnId: 'u', platform: 'web' }, {})
    ).rejects.toThrow('boom');
    expect(collected.filter((e) => e.type === 'agent.error')).toHaveLength(1);
  });
});
