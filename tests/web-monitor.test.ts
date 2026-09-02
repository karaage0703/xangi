import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { deriveSessionOrigin } from '../src/session-title.js';
import {
  accountUsageStatusLabel,
  activityFromEvent,
  applyActivitySnapshot,
  conversationLabel,
  displayUsageProviders,
  formatSessionTokens,
  formatEstimatedCost,
  isMonitorVisible,
  monitorLane,
  revealMonitorDetail,
  sessionMatchesActivityThread,
  sessionLine,
  sessionProgressSummary,
  usageGroupPresentation,
  usagePacePercent,
  visibleUsageGroups,
  type MonitorSession,
  totalSessionTokens,
} from '../web-ui/src/Monitor.js';

describe('Monitor account usage', () => {
  it('keeps provider usage expanded instead of using a disclosure control', () => {
    const monitorSource = readFileSync(join(process.cwd(), 'web-ui', 'src', 'Monitor.tsx'), 'utf8');
    expect(monitorSource).toContain('<article className="monitor-usage-provider"');
    expect(monitorSource).not.toContain('<details className="monitor-usage-provider"');
  });

  it('shows a status only when cached usage is stale', () => {
    expect(accountUsageStatusLabel()).toBeUndefined();
    expect(accountUsageStatusLabel(false)).toBeUndefined();
    expect(accountUsageStatusLabel(true)).toBe('前回値');
  });

  it('shows elapsed-window pace for comparison with actual usage', () => {
    const start = Date.parse('2026-08-26T00:00:00.000Z');
    const reset = start + 5 * 60 * 60 * 1000;
    expect(
      usagePacePercent(
        { resetsAt: reset / 1000, windowDurationMins: 5 * 60 },
        start + 2 * 60 * 60 * 1000
      )
    ).toBe(40);
  });

  it('clamps the pace to the active window and omits incomplete metadata', () => {
    const reset = Date.parse('2026-08-27T00:00:00.000Z');
    const window = { resetsAt: reset / 1000, windowDurationMins: 60 };
    expect(usagePacePercent(window, reset - 2 * 60 * 60 * 1000)).toBe(0);
    expect(usagePacePercent(window, reset + 60 * 1000)).toBe(100);
    expect(usagePacePercent({ resetsAt: reset / 1000 }, reset)).toBeUndefined();
  });

  it('labels the shared Codex quota bucket', () => {
    expect(usageGroupPresentation({ id: 'codex', label: 'Codex', planType: 'pro' })).toEqual({
      title: 'Codex共通枠',
      description: 'Codex · pro',
    });
  });

  it('omits the Spark-specific quota from Monitor', () => {
    expect(
      visibleUsageGroups([
        { id: 'codex', label: 'Codex', planType: 'pro', windows: [] },
        { id: 'codex_bengalfox', label: 'GPT-5.3-Codex-Spark', planType: 'pro', windows: [] },
      ]).map((group) => group.id)
    ).toEqual(['codex']);
  });

  it('shows every provider returned by an official usage source without requiring a Session', () => {
    expect(
      displayUsageProviders([
        {
          id: 'codex',
          label: 'Codex',
          groups: [{ id: 'codex', label: 'Codex', windows: [] }],
        },
        {
          id: 'github-copilot',
          label: 'GitHub Copilot',
          groups: [{ id: 'copilot', label: 'GitHub Copilot', windows: [] }],
        },
      ]).map((provider) => provider.id)
    ).toEqual(['codex', 'github-copilot']);
  });

  it('formats provider-reported estimated cost without inventing a currency', () => {
    expect(formatEstimatedCost(0)).toBe('0');
    expect(formatEstimatedCost(0.012345678)).toBe('0.012346');
  });
});

function session(overrides: Partial<MonitorSession>): MonitorSession {
  return {
    id: 'session-1',
    platform: 'web',
    isCurrent: true,
    lifecycle: 'open',
    updatedAt: '2026-08-11T05:00:00.000Z',
    ...overrides,
  };
}

describe('Monitor kanban lanes', () => {
  it('shows stateless backends only while their request is running', () => {
    expect(isMonitorVisible(session({ sessionMode: 'stateless', isActive: true }))).toBe(true);
    expect(isMonitorVisible(session({ sessionMode: 'stateless', isActive: false }))).toBe(false);
    expect(
      isMonitorVisible(
        session({ sessionMode: 'stateless', scope: 'scheduler', lifecycle: 'closed' })
      )
    ).toBe(false);
    expect(
      isMonitorVisible(
        session({ sessionMode: 'stateless', scope: 'scheduler', lifecycle: 'open', isActive: true })
      )
    ).toBe(false);
    expect(isMonitorVisible(session({ sessionMode: 'stateful', isActive: false }))).toBe(true);
  });

  it('puts active sessions in running even when the last activity was an error', () => {
    expect(
      monitorLane(
        session({
          isActive: true,
          activity: { state: 'error', summary: 'retrying', active: true },
        })
      )
    ).toBe('running');
  });

  it('keeps an open scheduler run in running before its first activity event arrives', () => {
    const scheduled = session({
      id: 'scheduler-run-discord-1',
      platform: 'discord',
      scope: 'scheduler',
      lifecycle: 'open',
      isActive: false,
    });
    expect(monitorLane(scheduled)).toBe('running');
    expect(sessionLine(scheduled)).toBe('スケジュールを実行中');
  });

  it('matches scheduler activity to exactly one run session', () => {
    const scheduled = session({
      id: 'scheduler-run-discord-1',
      platform: 'discord',
      scope: 'scheduler',
      contextKey: 'channel-1',
    });
    expect(
      sessionMatchesActivityThread('discord-schedule:scheduler-run-discord-1', scheduled)
    ).toBe(true);
    expect(
      sessionMatchesActivityThread('discord-schedule:scheduler-run-discord-2', scheduled)
    ).toBe(false);
    expect(sessionMatchesActivityThread('discord:channel-1', scheduled)).toBe(false);
  });

  it.each(['error', 'aborted'])('keeps inactive %s sessions in waiting', (state) => {
    expect(monitorLane(session({ activity: { state, summary: state, active: false } }))).toBe(
      'waiting'
    );
  });

  it('separates open sessions that can continue from closed sessions', () => {
    expect(
      monitorLane(
        session({
          lifecycle: 'open',
          activity: { state: 'complete', summary: 'done', active: false },
        })
      )
    ).toBe('waiting');
    expect(
      monitorLane(
        session({
          lifecycle: 'closed',
          activity: { state: 'complete', summary: 'done', active: false },
        })
      )
    ).toBe('completed');
  });

  it('keeps a completed session completed even if its last activity was aborted', () => {
    expect(
      monitorLane(
        session({
          lifecycle: 'closed',
          activity: { state: 'aborted', summary: 'closed', active: false },
        })
      )
    ).toBe('completed');
  });

  it('treats an active session without an explicit lifecycle as closed', () => {
    expect(
      monitorLane(
        session({
          lifecycle: undefined,
          isActive: true,
          activity: { state: 'tool', summary: 'old', active: true },
        })
      )
    ).toBe('completed');
  });

  it('moves a closed session to running when a turn starts', () => {
    const updated = activityFromEvent(
      session({
        lifecycle: 'closed',
        closedAt: '2026-08-11T04:00:00.000Z',
        closeReason: 'new',
        isActive: false,
      }),
      {
        type: 'turn.started',
        thread_id: 'web:session-1',
        user_text: 'hello',
        ts: Date.parse('2026-08-11T05:01:00.000Z') / 1000,
      }
    );

    expect(updated).toMatchObject({
      lifecycle: 'open',
      isActive: true,
      closedAt: undefined,
      closeReason: undefined,
    });
    expect(monitorLane(updated)).toBe('running');
  });

  it('opens a closed session when an active activity snapshot arrives', () => {
    const updated = applyActivitySnapshot(
      session({
        lifecycle: 'closed',
        closedAt: '2026-08-11T04:00:00.000Z',
        closeReason: 'leave',
        isActive: false,
      }),
      {
        state: 'tool',
        summary: 'running',
        active: true,
        updatedAt: Date.parse('2026-08-11T05:02:00.000Z'),
      }
    );

    expect(updated).toMatchObject({
      lifecycle: 'open',
      isActive: true,
      closedAt: undefined,
      closeReason: undefined,
    });
    expect(monitorLane(updated)).toBe('running');
  });

  it('does not reopen a closed session for an inactive completion event', () => {
    const updated = activityFromEvent(session({ lifecycle: 'closed', isActive: false }), {
      type: 'turn.complete',
      thread_id: 'web:session-1',
      ts: Date.parse('2026-08-11T05:03:00.000Z') / 1000,
    });

    expect(updated.lifecycle).toBe('closed');
    expect(monitorLane(updated)).toBe('completed');
  });
});

describe('Monitor session token usage', () => {
  it('counts cached input as part of provider-reported input, not twice', () => {
    expect(
      totalSessionTokens({
        inputTokens: 1_000,
        cachedInputTokens: 800,
        outputTokens: 200,
        updatedAt: '2026-09-01T00:00:00.000Z',
      })
    ).toBe(1_200);
  });

  it('uses compact units so large token totals remain scannable', () => {
    expect(formatSessionTokens(999)).toBe('999');
    expect(formatSessionTokens(1_000)).toBe('1K');
    expect(formatSessionTokens(132_624)).toBe('132.6K');
    expect(formatSessionTokens(1_250_000)).toBe('1.3M');
  });
});

describe('Monitor session details', () => {
  it('keeps internal IDs out and groups secondary metadata below the activity', () => {
    const monitorSource = readFileSync(join(process.cwd(), 'web-ui', 'src', 'Monitor.tsx'), 'utf8');
    const card = monitorSource.match(
      /<span className="monitor-session-body">([\s\S]*?)<\/button>/
    )?.[1];
    const metadataStart = card?.indexOf('<span className="monitor-session-right">') ?? -1;
    const metadata = metadataStart >= 0 ? card?.slice(metadataStart) : undefined;

    expect(card).toBeDefined();
    expect(card).not.toContain('shortId(session.id)');
    expect(card).not.toContain('session.contextKey');
    expect(card).not.toContain('monitor-session-meta');
    expect(metadata).toContain('platformLabel(session.platform)');
    expect(metadata).toContain('stateLabel(session)');
    expect(metadata).toContain('formatAge(');
    expect(metadata).toContain('formatSessionTokens(');
  });

  it('summarizes the current step and completion count for collapsed cards', () => {
    expect(
      sessionProgressSummary(
        session({
          progressCard: {
            revision: 2,
            updatedAt: '2020-01-01T00:00:00.000Z',
            plan: [
              { step: '調査', status: 'completed' },
              { step: '実装', status: 'in_progress' },
              { step: '確認', status: 'pending' },
            ],
          },
        })
      )
    ).toEqual({ current: '実装', completed: 1, total: 3 });
  });

  it('labels completed and not-started plans without inventing a current step', () => {
    expect(
      sessionProgressSummary(
        session({
          progressCard: {
            revision: 1,
            updatedAt: '2020-01-01T00:00:00.000Z',
            plan: [{ step: '確認', status: 'pending' }],
          },
        })
      )
    ).toEqual({ current: '開始前', completed: 0, total: 1 });
    expect(
      sessionProgressSummary(
        session({
          progressCard: {
            revision: 2,
            updatedAt: '2020-01-01T00:00:00.000Z',
            plan: [{ step: '確認', status: 'completed' }],
          },
        })
      )
    ).toEqual({ current: '全工程完了', completed: 1, total: 1 });
  });

  it('keeps the destination compact and leaves the thread title to technical details', () => {
    expect(
      conversationLabel(
        session({
          platform: 'discord',
          origin: {
            channelName: 'test_xangi_dev_01',
            threadName: 'バックエンド設定を保存しました。新しいセッションを開始します。',
          },
        })
      )
    ).toBe('Discord · #test_xangi_dev_01');
  });

  it('uses the in-page confirm dialog instead of window.confirm for WKWebView', () => {
    const monitorSource = readFileSync(join(process.cwd(), 'web-ui', 'src', 'Monitor.tsx'), 'utf8');
    const confirmDialogSource = readFileSync(
      join(process.cwd(), 'web-ui', 'src', 'ConfirmDialog.tsx'),
      'utf8'
    );
    const sourceStylesheet = readFileSync(
      join(process.cwd(), 'web-ui', 'src', 'styles.css'),
      'utf8'
    );

    expect(monitorSource).toContain('<ConfirmDialog');
    expect(monitorSource).not.toContain('window.confirm');
    expect(confirmDialogSource).toContain('dialog.showModal()');
    expect(confirmDialogSource).toContain('clickedBackdrop');
    expect(sourceStylesheet).toContain('.monitor-page > :not(.app-topbar, .confirm-dialog)');
  });

  it('uses semantic action hierarchy instead of danger styling for session completion', () => {
    const sourceStylesheet = readFileSync(
      join(process.cwd(), 'web-ui', 'src', 'styles.css'),
      'utf8'
    );

    expect(sourceStylesheet).toMatch(
      /\.monitor-detail-session-close\s*\{[^}]*color:\s*var\(--ink-secondary\)[^}]*border-color:\s*var\(--border\)/s
    );
    expect(sourceStylesheet).toMatch(
      /\.monitor-detail-close\s*\{[^}]*color:\s*var\(--ink-muted\)[^}]*border-color:\s*transparent/s
    );
    expect(sourceStylesheet).not.toMatch(
      /\.monitor-detail-session-close\s*\{[^}]*var\(--danger\)/s
    );
  });

  it('offers a confirmed bulk completion action for all waiting sessions', () => {
    const monitorSource = readFileSync(join(process.cwd(), 'web-ui', 'src', 'Monitor.tsx'), 'utf8');

    expect(monitorSource).toContain('入力待ちをすべて完了');
    expect(monitorSource).toContain('waitingSessions.length');
    expect(monitorSource).toContain('setCloseAllWaitingOpen(true)');
    expect(monitorSource).toContain('onConfirm={() => void closeAllWaitingSessions()}');
  });

  it('reveals an off-screen detail with motion that follows the user preference', () => {
    const calls: ScrollIntoViewOptions[] = [];
    const element = {
      getBoundingClientRect: () => ({ top: -400, bottom: -100 }) as DOMRect,
      scrollIntoView: (options?: boolean | ScrollIntoViewOptions) => {
        calls.push(options as ScrollIntoViewOptions);
      },
    };

    expect(revealMonitorDetail(element, false, 812)).toBe(true);
    expect(calls).toEqual([{ behavior: 'smooth', block: 'start' }]);

    calls.length = 0;
    expect(revealMonitorDetail(element, true, 812)).toBe(true);
    expect(calls).toEqual([{ behavior: 'auto', block: 'start' }]);
  });

  it('does not move the page when the selected detail is already visible', () => {
    let calls = 0;
    const element = {
      getBoundingClientRect: () => ({ top: 120, bottom: 620 }) as DOMRect,
      scrollIntoView: () => {
        calls += 1;
      },
    };

    expect(revealMonitorDetail(element, false, 812)).toBe(false);
    expect(calls).toBe(0);
  });

  it('derives Discord channel and thread details from the first prompt', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'xangi-monitor-origin-'));
    mkdirSync(join(workdir, 'logs', 'sessions'), { recursive: true });
    writeFileSync(
      join(workdir, 'logs', 'sessions', 'session-1.jsonl'),
      `${JSON.stringify({
        role: 'user',
        content:
          '[プラットフォーム: Discord]\n[チャンネル: #dev_xangi (ID: 123) / thread: monitor details (ID: 456)]\nhello',
      })}\n`
    );

    expect(deriveSessionOrigin(workdir, 'session-1')).toEqual({
      channelName: 'dev_xangi',
      channelId: '123',
      threadName: 'monitor details',
      threadId: '456',
    });
  });

  it('derives Slack channel and thread IDs from the first prompt', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'xangi-monitor-origin-'));
    mkdirSync(join(workdir, 'logs', 'sessions'), { recursive: true });
    writeFileSync(
      join(workdir, 'logs', 'sessions', 'session-2.jsonl'),
      `${JSON.stringify({
        role: 'user',
        content: '[プラットフォーム: Slack]\n[チャンネル: C012345]\n[スレッド: 123.456]\nhello',
      })}\n`
    );

    expect(deriveSessionOrigin(workdir, 'session-2')).toEqual({
      channelId: 'C012345',
      threadId: '123.456',
    });
  });
});
