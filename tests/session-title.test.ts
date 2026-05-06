import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  stripPromptMetadata,
  deriveTitleFromFirstMessage,
} from '../src/session-title.js';

describe('stripPromptMetadata', () => {
  it('Discord 形式のメタデータ4行をすべて剥がす', () => {
    const input =
      '[プラットフォーム: Discord]\n' +
      '[チャンネル: #dev_xangi (ID: 1469726038291386523)]\n' +
      '[発言者: からあげ (ID: 865948822738567178)]\n' +
      '[現在時刻: 2026/4/26 15:06:50(日)]\n' +
      'こんにちは、テストです';
    expect(stripPromptMetadata(input)).toBe('こんにちは、テストです');
  });

  it('Slack 形式（プラットフォーム + チャンネルのみ）も剥がせる', () => {
    const input =
      '[プラットフォーム: Slack]\n' + '[チャンネル: C12345]\n' + 'メッセージ本体';
    expect(stripPromptMetadata(input)).toBe('メッセージ本体');
  });

  it('Web 形式（プラットフォームのみ）も剥がせる', () => {
    const input = '[プラットフォーム: Web]\nweb からの発話';
    expect(stripPromptMetadata(input)).toBe('web からの発話');
  });

  it('メタデータ無しの素のテキストはそのまま', () => {
    expect(stripPromptMetadata('生のメッセージ')).toBe('生のメッセージ');
  });

  it('空文字なら空文字を返す', () => {
    expect(stripPromptMetadata('')).toBe('');
  });
});

describe('deriveTitleFromFirstMessage', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'session-title-test-'));
    mkdirSync(join(workdir, 'logs', 'sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function writeLog(sessionId: string, lines: object[]): void {
    const path = join(workdir, 'logs', 'sessions', `${sessionId}.jsonl`);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  it('最初の user メッセージのメタデータを剥がして 50 文字に切り詰める', () => {
    writeLog('sess1', [
      {
        id: 'm1',
        role: 'user',
        content:
          '[プラットフォーム: Discord]\n[チャンネル: #ch (ID: 1234567890)]\n[発言者: からあげ]\n[現在時刻: 2026/5/5 10:00:00(火)]\nDiscord 経由のテストメッセージです',
        createdAt: '2026-05-05T10:00:00Z',
      },
    ]);
    expect(deriveTitleFromFirstMessage(workdir, 'sess1')).toBe(
      'Discord 経由のテストメッセージです'
    );
  });

  it('長文は 50 文字でカット', () => {
    const longBody = 'あ'.repeat(100);
    writeLog('sess2', [{ id: 'm1', role: 'user', content: longBody, createdAt: '' }]);
    expect(deriveTitleFromFirstMessage(workdir, 'sess2')).toHaveLength(50);
  });

  it('ログファイルが無いセッションは空文字', () => {
    expect(deriveTitleFromFirstMessage(workdir, 'no-such-session')).toBe('');
  });

  it('1 行目が user でなければ空文字', () => {
    writeLog('sess3', [
      { id: 'm1', role: 'system', content: 'system note', createdAt: '' },
    ]);
    expect(deriveTitleFromFirstMessage(workdir, 'sess3')).toBe('');
  });

  it('壊れた JSON 行は空文字（例外を投げない）', () => {
    const path = join(workdir, 'logs', 'sessions', 'sess4.jsonl');
    writeFileSync(path, 'not-json-at-all\n');
    expect(deriveTitleFromFirstMessage(workdir, 'sess4')).toBe('');
  });
});
