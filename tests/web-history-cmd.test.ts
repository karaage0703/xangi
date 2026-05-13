import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { webHistoryCmd } from '../src/cli/web-history-cmd.js';

/**
 * src/cli/web-history-cmd.ts のテスト。
 *
 * - 現ペインの解決は `--session` フラグ or env `XANGI_CHANNEL_ID` (`web-chat:<id>` 形式)
 * - 解決できない場合は明示的にエラーメッセージを返す（mtime フォールバック無し）
 * - 末尾 N 件のみ表示、長文は省略
 */
describe('web-history-cmd', () => {
  let tmpDir: string;
  let sessionsDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'web-history-test-'));
    sessionsDir = join(tmpDir, 'logs', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.WORKSPACE_PATH = tmpDir;
    delete process.env.XANGI_CHANNEL_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(
    name: string,
    msgs: Array<{ role: string; content: unknown; createdAt?: string }>
  ): string {
    const path = join(sessionsDir, name);
    const lines = msgs.map((m) =>
      JSON.stringify({
        id: `m_${Math.random().toString(36).slice(2)}`,
        createdAt: m.createdAt ?? new Date().toISOString(),
        ...m,
      })
    );
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  it('returns helpful message when no current pane is resolvable', () => {
    writeSession('a.jsonl', [{ role: 'user', content: '[プラットフォーム: Web]\nhello' }]);
    const result = webHistoryCmd({});
    expect(result).toContain('no current Web pane');
    expect(result).toContain('--session');
  });

  it('ignores non-web-chat XANGI_CHANNEL_ID (e.g. Discord channel id)', () => {
    writeSession('a.jsonl', [{ role: 'user', content: '[プラットフォーム: Web]\nhello' }]);
    process.env.XANGI_CHANNEL_ID = '1234567890123456789'; // Discord channel id 形式
    const result = webHistoryCmd({});
    expect(result).toContain('no current Web pane');
  });

  it('resolves current pane from --session flag', () => {
    writeSession('specific.jsonl', [
      { role: 'user', content: '[プラットフォーム: Web]\nspecific-msg' },
      { role: 'assistant', content: 'reply' },
    ]);
    writeSession('other.jsonl', [{ role: 'user', content: '[プラットフォーム: Web]\nother-msg' }]);
    const result = webHistoryCmd({ session: 'specific' });
    expect(result).toContain('specific.jsonl');
    expect(result).toContain('specific-msg');
    expect(result).toContain('reply');
    expect(result).not.toContain('other-msg');
  });

  it('resolves current pane from XANGI_CHANNEL_ID env (web-chat:<id>)', () => {
    writeSession('pane123.jsonl', [
      { role: 'user', content: '[プラットフォーム: Web]\npane-msg' },
    ]);
    writeSession('other.jsonl', [{ role: 'user', content: '[プラットフォーム: Web]\nother-msg' }]);
    process.env.XANGI_CHANNEL_ID = 'web-chat:pane123';
    const result = webHistoryCmd({});
    expect(result).toContain('pane123.jsonl');
    expect(result).toContain('pane-msg');
    expect(result).not.toContain('other-msg');
  });

  it('--session takes precedence over XANGI_CHANNEL_ID', () => {
    writeSession('env-pane.jsonl', [{ role: 'user', content: '[プラットフォーム: Web]\nenv-msg' }]);
    writeSession('flag-pane.jsonl', [
      { role: 'user', content: '[プラットフォーム: Web]\nflag-msg' },
    ]);
    process.env.XANGI_CHANNEL_ID = 'web-chat:env-pane';
    const result = webHistoryCmd({ session: 'flag-pane' });
    expect(result).toContain('flag-pane.jsonl');
    expect(result).toContain('flag-msg');
    expect(result).not.toContain('env-msg');
  });

  it('returns helpful message when --session not found', () => {
    writeSession('a.jsonl', [{ role: 'user', content: '[プラットフォーム: Web]\nok' }]);
    const result = webHistoryCmd({ session: 'nonexistent' });
    expect(result).toContain('nonexistent.jsonl not found');
  });

  it('limits to --count messages from tail', () => {
    const msgs = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({
        role: i === 0 ? 'user' : 'assistant',
        content: i === 0 ? '[プラットフォーム: Web]\nfirst' : `msg-${i}`,
      });
    }
    writeSession('big.jsonl', msgs);

    const result = webHistoryCmd({ session: 'big', count: '5' });
    const bodyLines = result.split('\n').filter((l) => l && !l.startsWith('# '));
    expect(bodyLines).toHaveLength(5);
    expect(result).toContain('msg-29');
    expect(result).not.toContain('msg-20');
  });

  it('truncates long content with --max-chars', () => {
    const longText = 'x'.repeat(2000);
    writeSession('long.jsonl', [
      { role: 'user', content: '[プラットフォーム: Web]\n' + longText },
    ]);
    const result = webHistoryCmd({ session: 'long', 'max-chars': '100' });
    expect(result).toContain('…');
    const userLine = result.split('\n').find((l) => l.includes('[user]'));
    expect(userLine).toBeTruthy();
    expect(userLine!.length).toBeLessThan(200);
  });

  it('handles assistant content as object (result field)', () => {
    writeSession('obj.jsonl', [
      { role: 'user', content: '[プラットフォーム: Web]\nq' },
      {
        role: 'assistant',
        content: { type: 'result', result: 'extracted answer text' },
      },
    ]);
    const result = webHistoryCmd({ session: 'obj' });
    expect(result).toContain('extracted answer text');
  });

  it('handles malformed jsonl lines gracefully', () => {
    const path = join(sessionsDir, 'malformed.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ role: 'user', content: '[プラットフォーム: Web]\nok' }),
        'not-valid-json',
        JSON.stringify({ role: 'assistant', content: 'reply' }),
      ].join('\n')
    );
    const result = webHistoryCmd({ session: 'malformed' });
    expect(result).toContain('ok');
    expect(result).toContain('reply');
  });
});
