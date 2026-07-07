import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { slackHistoryCmd } from '../src/cli/slack-history-cmd.js';

const DUMMY_RUNTIME_CWD = '/workspace/xangi-dev';

const originalWorkspacePath = process.env.WORKSPACE_PATH;
const originalChannelId = process.env.XANGI_CHANNEL_ID;
let tempDir: string | undefined;

function withSessionFile(name: string, lines: unknown[]): void {
  if (!tempDir) throw new Error('tempDir is not initialized');
  const sessionsDir = join(tempDir, 'logs', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${name}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf-8'
  );
}

function setupWorkspace(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'xangi-slack-history-'));
  process.env.WORKSPACE_PATH = tempDir;
  delete process.env.XANGI_CHANNEL_ID;
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  if (originalWorkspacePath === undefined) {
    delete process.env.WORKSPACE_PATH;
  } else {
    process.env.WORKSPACE_PATH = originalWorkspacePath;
  }
  if (originalChannelId === undefined) {
    delete process.env.XANGI_CHANNEL_ID;
  } else {
    process.env.XANGI_CHANNEL_ID = originalChannelId;
  }
});

describe('slackHistoryCmd', () => {
  it('resolves Slack sessions from injected Japanese channel header', () => {
    setupWorkspace();
    withSessionFile('session-a', [
      {
        role: 'user',
        content:
          `[runtime] cwd=${DUMMY_RUNTIME_CWD}\n\n[プラットフォーム: Slack]\n[チャンネル: C123]\nこんばんは`,
        createdAt: '2026-07-01T00:00:00.000Z',
      },
      {
        role: 'assistant',
        content: 'こんばんは',
        createdAt: '2026-07-01T00:00:01.000Z',
      },
    ]);

    const result = slackHistoryCmd({ channel: 'C123', count: '2' });

    expect(result).toContain('session: session-a');
    expect(result).toContain('こんばんは');
  });

  it('keeps resolving legacy sessions from contextKey', () => {
    setupWorkspace();
    withSessionFile('session-b', [
      {
        role: 'user',
        contextKey: 'C456',
        content: 'hello',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ]);

    const result = slackHistoryCmd({ channel: 'C456' });

    expect(result).toContain('session: session-b');
    expect(result).toContain('hello');
  });

  it('returns a clear message when no session matches', () => {
    const workspace = setupWorkspace();
    withSessionFile('session-c', [{ role: 'user', content: '[チャンネル: C999]\nhello' }]);

    const result = slackHistoryCmd({ channel: 'C000' });

    expect(result).toBe(`(no slack session found for channel C000 in ${workspace}/logs/sessions)`);
  });
});
