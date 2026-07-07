import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StreamSession,
  DEFAULT_SPINNER_FRAMES,
  DEFAULT_STATUS_VERBS,
  type StreamView,
} from '../src/stream-session.js';

describe('StreamSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('思考中 tick でスピナーが回り、verbRotateTicks ごとにステータス語が変わる', async () => {
    const views: StreamView[] = [];
    const session = new StreamSession({
      render: (v) => {
        views.push(v);
      },
      tickMs: 1000,
      verbRotateTicks: 2,
    });
    session.start();

    await vi.advanceTimersByTimeAsync(1000); // tick 1
    await vi.advanceTimersByTimeAsync(1000); // tick 2 (verb 切替)
    await vi.advanceTimersByTimeAsync(1000); // tick 3

    expect(views).toHaveLength(3);
    expect(views[0].phase).toBe('thinking');
    expect(views[0].statusLine).toContain(DEFAULT_SPINNER_FRAMES[1]);
    expect(views[0].statusLine).toContain(DEFAULT_STATUS_VERBS[0]);
    expect(views[1].statusLine).toContain(DEFAULT_STATUS_VERBS[1]); // tick2 で切替
    expect(views[2].statusLine).toContain(`3s`); // 経過秒
    session.finish();
  });

  it('onText で streaming フェーズへ遷移し、スロットリング間隔内の連続更新は 1 回に抑える', async () => {
    const views: StreamView[] = [];
    const session = new StreamSession({
      render: (v) => {
        views.push(v);
      },
      streamUpdateIntervalMs: 1000,
    });
    const cb = session.callbacks();

    cb.onText?.('Hel', 'Hel'); // 初回: lastUpdateTime=0 から interval 経過扱い → render
    cb.onText?.('lo', 'Hello'); // 1 秒以内 → スキップ
    expect(views).toHaveLength(1);
    expect(views[0].phase).toBe('streaming');
    expect(views[0].text).toBe('Hel');
    expect(session.isStreaming).toBe(true);

    await vi.advanceTimersByTimeAsync(1100);
    cb.onText?.('!', 'Hello!');
    expect(views).toHaveLength(2);
    expect(views[1].text).toBe('Hello!');
    expect(session.lastText).toBe('Hello!');
    session.finish();
  });

  it('render の Promise が未解決の間は次のストリーム更新を抑制する', async () => {
    let resolveRender: (() => void) | undefined;
    let renderCount = 0;
    const session = new StreamSession({
      render: () => {
        renderCount++;
        return new Promise<void>((resolve) => {
          resolveRender = resolve;
        });
      },
      streamUpdateIntervalMs: 100,
    });
    const cb = session.callbacks();

    cb.onText?.('a', 'a');
    expect(renderCount).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    cb.onText?.('b', 'ab'); // 前回 render が pending → スキップ
    expect(renderCount).toBe(1);

    resolveRender?.();
    await vi.advanceTimersByTimeAsync(200);
    cb.onText?.('c', 'abc'); // pending 解除後 → render される
    expect(renderCount).toBe(2);
    session.finish();
  });

  it('streaming 遷移後は思考中 tick が描画しない', async () => {
    const views: StreamView[] = [];
    const session = new StreamSession({
      render: (v) => {
        views.push(v);
      },
      tickMs: 1000,
    });
    session.start();
    const cb = session.callbacks();
    cb.onText?.('x', 'x');
    const countAfterText = views.length;

    await vi.advanceTimersByTimeAsync(3000); // tick は no-op になる
    expect(views).toHaveLength(countAfterText);
    session.finish();
  });

  it('onToolUse でツール行を重複排除して蓄積し、即時描画する', () => {
    const views: StreamView[] = [];
    const session = new StreamSession({
      render: (v) => {
        views.push(v);
      },
      formatToolLine: (name) => `🔧 ${name}`,
    });
    const cb = session.callbacks();

    cb.onToolUse?.('Bash', { command: 'ls' });
    cb.onToolUse?.('Bash', { command: 'ls' }); // 重複 → 描画なし
    cb.onToolUse?.('Read', { file_path: 'a.ts' });

    expect(views).toHaveLength(2);
    expect(session.currentToolLines).toEqual(['🔧 Bash', '🔧 Read']);
    session.finish();
  });

  it('formatToolLine が null を返すツールは表示しない', () => {
    const views: StreamView[] = [];
    const session = new StreamSession({
      render: (v) => {
        views.push(v);
      },
      formatToolLine: (name) => (name === 'Bash' ? `🔧 ${name}` : null),
    });
    const cb = session.callbacks();

    cb.onToolUse?.('Read', { file_path: 'a.ts' });
    expect(views).toHaveLength(0);
    expect(session.currentToolLines).toEqual([]);
    session.finish();
  });

  it('inner コールバックへ委譲する', () => {
    const session = new StreamSession({ render: () => {} });
    const onText = vi.fn();
    const onToolUse = vi.fn();
    const onComplete = vi.fn();
    const cb = session.callbacks({ onText, onToolUse, onComplete });

    cb.onText?.('a', 'a');
    cb.onToolUse?.('Bash', { command: 'ls' });
    cb.onComplete?.({ result: 'done', sessionId: 's' });

    expect(onText).toHaveBeenCalledWith('a', 'a');
    expect(onToolUse).toHaveBeenCalledWith('Bash', { command: 'ls' });
    expect(onComplete).toHaveBeenCalledWith({ result: 'done', sessionId: 's' });
    session.finish();
  });

  it('finish 後は tick もツール行追加も描画しない', async () => {
    const views: StreamView[] = [];
    const session = new StreamSession({
      render: (v) => {
        views.push(v);
      },
      tickMs: 1000,
      formatToolLine: (name) => `🔧 ${name}`,
    });
    session.start();
    session.finish();

    await vi.advanceTimersByTimeAsync(3000);
    expect(views).toHaveLength(0);
  });
});

import { capToolLines, DEFAULT_TOOL_HISTORY_MAX_LINES } from '../src/stream-session.js';
import { addToolHistory, appendToolHistory } from '../src/tool-history.js';

describe('capToolLines', () => {
  const original = process.env.TOOL_HISTORY_MAX_LINES;

  beforeEach(() => {
    delete process.env.TOOL_HISTORY_MAX_LINES;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TOOL_HISTORY_MAX_LINES;
    } else {
      process.env.TOOL_HISTORY_MAX_LINES = original;
    }
  });

  const lines = (n: number) => Array.from({ length: n }, (_, i) => `🔧 tool-${i + 1}`);

  it('デフォルト 10 行以下はそのまま', () => {
    expect(capToolLines(lines(10))).toHaveLength(10);
    expect(DEFAULT_TOOL_HISTORY_MAX_LINES).toBe(10);
  });

  it('超過分は先頭の省略行にまとめ、最新 N 行を残す', () => {
    const capped = capToolLines(lines(15));
    expect(capped).toHaveLength(11);
    expect(capped[0]).toBe('… (+5 件省略)');
    expect(capped[1]).toBe('🔧 tool-6');
    expect(capped[10]).toBe('🔧 tool-15');
  });

  it('TOOL_HISTORY_MAX_LINES で上限を変えられる', () => {
    process.env.TOOL_HISTORY_MAX_LINES = '3';
    const capped = capToolLines(lines(5));
    expect(capped).toEqual(['… (+2 件省略)', '🔧 tool-3', '🔧 tool-4', '🔧 tool-5']);
  });

  it('0 以下で無制限', () => {
    process.env.TOOL_HISTORY_MAX_LINES = '0';
    expect(capToolLines(lines(50))).toHaveLength(50);
  });

  it('不正値はデフォルトにフォールバック', () => {
    process.env.TOOL_HISTORY_MAX_LINES = 'abc';
    expect(capToolLines(lines(15))).toHaveLength(11);
  });

  it('cap 済みリストは二重適用しても変化しない (idempotent)', () => {
    const once = capToolLines(lines(20));
    expect(capToolLines(once)).toEqual(once);
  });

  it('StreamSession.view() / currentToolLines が cap 済みを返す', () => {
    process.env.TOOL_HISTORY_MAX_LINES = '2';
    const session = new StreamSession({
      render: () => {},
      formatToolLine: (name) => `🔧 ${name}`,
    });
    const cb = session.callbacks();
    for (let i = 1; i <= 4; i++) cb.onToolUse?.(`t${i}`, {});
    expect(session.view().toolLines).toEqual(['… (+2 件省略)', '🔧 t3', '🔧 t4']);
    expect(session.currentToolLines).toEqual(['… (+2 件省略)', '🔧 t3', '🔧 t4']);
  });

  it('appendToolHistory も cap を適用する', () => {
    process.env.TOOL_HISTORY_MAX_LINES = '2';
    const result = appendToolHistory('本文', ['🔧 a', '🔧 b', '🔧 c']);
    expect(result).toBe('… (+1 件省略)\n🔧 b\n🔧 c\n\n本文');
  });
});

describe('addToolHistory', () => {
  it('Bash の内部文脈参照を生コマンドではなく要約表示にする', () => {
    const history: string[] = [];
    addToolHistory(history, 'Bash', {
      command:
        'cat /home/karaage/borot/AGENTS.md 2>/dev/null; cat /home/karaage/xangi-dev/AGENTS.md',
    });

    expect(history).toEqual(['🔧 AGENTS参照']);
  });
});
