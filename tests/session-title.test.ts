import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stripPromptMetadata, deriveTitleFromFirstMessage } from '../src/session-title.js';

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
    const input = '[プラットフォーム: Slack]\n' + '[チャンネル: C12345]\n' + 'メッセージ本体';
    expect(stripPromptMetadata(input)).toBe('メッセージ本体');
  });

  it('Web 形式（プラットフォームのみ）も剥がせる', () => {
    const input = '[プラットフォーム: Web]\nweb からの発話';
    expect(stripPromptMetadata(input)).toBe('web からの発話');
  });

  it('Web Projectの追加プロンプトを表示用本文から剥がす', () => {
    const input = `[プラットフォーム: Web]
<web-project-context name="調査">
一次情報を優先する
</web-project-context>

表示したい質問`;
    expect(stripPromptMetadata(input)).toBe('表示したい質問');
  });

  it('メタデータ無しの素のテキストはそのまま', () => {
    expect(stripPromptMetadata('生のメッセージ')).toBe('生のメッセージ');
  });

  it('空文字なら空文字を返す', () => {
    expect(stripPromptMetadata('')).toBe('');
  });

  it('履歴先読みと返信候補の内部コンテキストを剥がす', () => {
    const input = `[runtime] cwd=/tmp repo=test

[プラットフォーム: Web]
<prefetched-history platform="Web">
xangiが初期文脈確認用の直近履歴を先読み済みです。
</prefetched-history>
初期文脈確認だけを目的に history コマンドを再実行しないでください。さらに古い履歴や追加件数が必要な場合だけ実行してください。

本当の質問です

[system-context]
通常の回答に続けて、ユーザーが次に送りそうな短い返信候補を3件生成してください。出力の末尾に次の形式を厳密に付け、通常の回答本文では候補に言及しないでください。候補はユーザー視点の自然な日本語にしてください。
<xangi_reply_suggestions>["候補1","候補2","候補3"]</xangi_reply_suggestions>`;
    expect(stripPromptMetadata(input)).toBe('本当の質問です');
  });

  it('チャットプラットフォームのsystem-contextブロックを剥がす', () => {
    const input = `<system-context>
あなたはチャットプラットフォーム（Discord）経由で会話しています。
</system-context>
[プラットフォーム: Discord]
[発言者: からあげ]
表示したい発言`;
    expect(stripPromptMetadata(input)).toBe('表示したい発言');
  });

  it('再起動注記とDiscordのスレッド文脈を剥がして実際の発言だけを返す', () => {
    const input = `[システム注記: xangi プロセスは 2026/7/30 12:24:55 に起動（再起動）した。]
[プラットフォーム: Discord]
[チャンネル: #dev_xangi / thread: 表示確認 (ID: 123)]
[発言者: からあげ (ID: 456)]
[現在時刻: 2026/7/30 12:27:45(木)]

---
🧵 スレッド元 (karaage0703):
最初の話題です
---
実際に表示したい発言です`;
    expect(stripPromptMetadata(input)).toBe('実際に表示したい発言です');
  });

  it('返信元とチャンネルルールを表示用本文から剥がす', () => {
    const input = `[プラットフォーム: Discord]
[発言者: からあげ]
---
💬 返信元 (borot-xangi#8987):
以前の回答です
---
この部分だけ表示します

[チャンネルルール（必ず従うこと）]
内部ルール`;
    expect(stripPromptMetadata(input)).toBe('この部分だけ表示します');
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

  it('先頭JSONL行が64KiBを超えてもタイトルを導出する', () => {
    writeLog('sess-large', [
      {
        id: 'm1',
        role: 'user',
        content: '大'.repeat(70_000),
        createdAt: '',
      },
    ]);
    expect(deriveTitleFromFirstMessage(workdir, 'sess-large')).toBe('大'.repeat(50));
  });

  it('ログファイルが無いセッションは空文字', () => {
    expect(deriveTitleFromFirstMessage(workdir, 'no-such-session')).toBe('');
  });

  it('1 行目が user でなければ空文字', () => {
    writeLog('sess3', [{ id: 'm1', role: 'system', content: 'system note', createdAt: '' }]);
    expect(deriveTitleFromFirstMessage(workdir, 'sess3')).toBe('');
  });

  it('壊れた JSON 行は空文字（例外を投げない）', () => {
    const path = join(workdir, 'logs', 'sessions', 'sess4.jsonl');
    writeFileSync(path, 'not-json-at-all\n');
    expect(deriveTitleFromFirstMessage(workdir, 'sess4')).toBe('');
  });
});
