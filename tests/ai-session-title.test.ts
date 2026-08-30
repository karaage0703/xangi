import { describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from '../src/agent-runner.js';
import {
  buildAiSessionTitleSource,
  generateAiSessionTitle,
  normalizeAiSessionTitle,
  startAiSessionTitle,
} from '../src/ai-session-title.js';

function runnerWithRun(run: AgentRunner['run']): AgentRunner {
  return {
    run,
    runStream: vi.fn(),
    cancel: vi.fn(),
    destroy: vi.fn(),
  };
}

describe('normalizeAiSessionTitle', () => {
  it('引用符・改行・末尾記号を除去して50文字へ収める', () => {
    expect(normalizeAiSessionTitle('「AIタイトル生成の設計相談。」\n説明')).toBe(
      'AIタイトル生成の設計相談'
    );
    expect(normalizeAiSessionTitle('あ'.repeat(60))).toHaveLength(50);
    expect(normalizeAiSessionTitle('LLMエラー: API error 404')).toBe('');
    expect(normalizeAiSessionTitle('Error: model unavailable')).toBe('');
    expect(normalizeAiSessionTitle('LLMサーバーに接続できませんでした。')).toBe('');
  });
});

describe('generateAiSessionTitle', () => {
  it('完了を待って正規化したタイトルを返し、専用runnerを破棄する', async () => {
    const runner = runnerWithRun(vi.fn().mockResolvedValue({ result: '「再生成タイトル。」', sessionId: 'provider' }));

    await expect(
      generateAiSessionTitle({
        runner,
        appSessionId: 'retitle-1',
        userText: '既存スレッドのタイトルを直したい',
        runOptions: { platform: 'discord' },
      })
    ).resolves.toBe('再生成タイトル');

    expect(runner.run).toHaveBeenCalledWith(
      expect.stringContaining('既存スレッドのタイトルを直したい'),
      expect.objectContaining({
        channelId: 'session-title:retitle-1',
        internalTask: true,
        localLlmMode: 'chat',
      })
    );
    expect(runner.destroy).toHaveBeenCalledWith('session-title:retitle-1');
  });
});

describe('buildAiSessionTitleSource', () => {
  it('メタデータを除いた直近8件を再生成入力にする', () => {
    const source = buildAiSessionTitleSource([
      '<system-context>内部</system-context>最初',
      ...Array.from({ length: 9 }, (_, index) => `発言${index + 1}`),
    ]);
    expect(source).not.toContain('最初');
    expect(source).not.toContain('発言1');
    expect(source).toContain('発言2');
    expect(source).toContain('発言9');
  });
});

describe('startAiSessionTitle', () => {
  it('内部タスクを同じ設定経路で実行し、成功時だけタイトルを通知する', async () => {
    const run = vi.fn<AgentRunner['run']>().mockResolvedValue({
      result: 'セッションタイトルのAI要約',
      sessionId: 'provider-title',
    });
    const runner = runnerWithRun(run);
    const onTitle = vi.fn();

    expect(
      startAiSessionTitle({
        runner,
        appSessionId: 'app-1',
        userText: '[プラットフォーム: Web]\nタイトルについて相談したい',
        runOptions: {
          settingsChannelId: 'web-chat:app-1',
          platform: 'web',
          defaultBackend: 'codex',
          defaultModel: 'gpt-test',
        },
        onTitle,
      })
    ).toBe(true);

    await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('セッションタイトルのAI要約'));
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('タイトルについて相談したい'),
      expect.objectContaining({
        channelId: 'session-title:app-1',
        runnerKey: 'session-title:app-1',
        settingsChannelId: 'web-chat:app-1',
        defaultBackend: 'codex',
        defaultModel: 'gpt-test',
        internalTask: true,
        localLlmMode: 'chat',
      })
    );
    expect(runner.destroy).toHaveBeenCalledWith('session-title:app-1');
  });

  it('同じセッションの重複生成を抑止する', async () => {
    let resolveRun!: (value: { result: string; sessionId: string }) => void;
    const runner = runnerWithRun(
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRun = resolve;
          })
      )
    );
    const options = {
      runner,
      appSessionId: 'app-duplicate',
      userText: '重複確認',
      runOptions: {},
      onTitle: vi.fn(),
    };

    expect(startAiSessionTitle(options)).toBe(true);
    expect(startAiSessionTitle(options)).toBe(false);
    resolveRun({ result: '重複なし', sessionId: 'provider-title' });
    await vi.waitFor(() => expect(options.onTitle).toHaveBeenCalledOnce());
  });

  it('timeout時はタイトルを変更せず、タイトル専用実行だけを停止する', async () => {
    const runner = runnerWithRun(vi.fn(() => new Promise(() => undefined)));
    const onTitle = vi.fn();

    startAiSessionTitle({
      runner,
      appSessionId: 'app-timeout',
      userText: 'timeout確認',
      runOptions: {},
      onTitle,
      timeoutMs: 5,
    });

    await vi.waitFor(() =>
      expect(runner.cancel).toHaveBeenCalledWith('session-title:app-timeout')
    );
    expect(onTitle).not.toHaveBeenCalled();
    expect(runner.destroy).toHaveBeenCalledWith('session-title:app-timeout');
  });
});
