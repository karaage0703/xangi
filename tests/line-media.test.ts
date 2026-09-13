import { describe, it, expect } from 'vitest';
import {
  lineContentUrl,
  lineContentAuthHeader,
  resolveContentSource,
  stickerToText,
  locationToText,
  mediaNoticeText,
} from '../src/line.js';
import { buildPromptWithAttachments } from '../src/file-utils.js';

describe('コンテンツの取得先', () => {
  it('No.1 LINEサーバのコンテンツはapi-dataホストから取る', () => {
    expect(lineContentUrl('123456')).toBe(
      'https://api-data.line.me/v2/bot/message/123456/content'
    );
  });

  it('No.2 外部提供のコンテンツはoriginalContentUrlから取る', () => {
    expect(
      resolveContentSource(
        { type: 'external', originalContentUrl: 'https://example.com/a.jpg' },
        '123456'
      )
    ).toBe('https://example.com/a.jpg');
  });

  it('No.2 LINE提供ならコンテンツエンドポイントを返す', () => {
    expect(resolveContentSource({ type: 'line' }, '123456')).toBe(
      'https://api-data.line.me/v2/bot/message/123456/content'
    );
  });

  it('No.3 コンテンツ取得にBearer認証が付く', () => {
    expect(lineContentAuthHeader('tok_abc')).toEqual({ Authorization: 'Bearer tok_abc' });
  });
});

describe('スタンプのテキスト化', () => {
  it('No.7 キーワードを先頭3個だけ使う', () => {
    expect(
      stickerToText({ keywords: ['OK', 'okie', 'super', 'great', 'alright'] })
    ).toBe('ユーザーがスタンプを送った。意味: OK, okie, super');
  });

  it('No.8 メッセージスタンプは入力文字を主に置く', () => {
    expect(stickerToText({ keywords: ['happy'], text: 'ありがとう' })).toBe(
      'ユーザーがスタンプを送った。「ありがとう」（意味: happy）'
    );
  });

  it('No.8b キーワードが3個未満でもそのまま使う', () => {
    expect(stickerToText({ keywords: ['happy'] })).toBe(
      'ユーザーがスタンプを送った。意味: happy'
    );
  });

  it('No.9 キーワードのないスタンプでも種別は伝わる', () => {
    expect(stickerToText({})).toBe('ユーザーがスタンプを送った。');
  });
});

describe('位置情報のテキスト化', () => {
  it('No.10 題名と住所と座標を渡す', () => {
    expect(
      locationToText({
        title: 'LINE本社',
        address: '東京都新宿区西新宿1-2-3',
        latitude: 35.687574,
        longitude: 139.692566,
      })
    ).toBe(
      'ユーザーが位置情報を送った。LINE本社 / 東京都新宿区西新宿1-2-3 (35.687574, 139.692566)'
    );
  });

  it('No.11 題名がなくても住所と座標は渡る', () => {
    expect(
      locationToText({
        address: '東京都新宿区西新宿1-2-3',
        latitude: 35.687574,
        longitude: 139.692566,
      })
    ).toBe('ユーザーが位置情報を送った。東京都新宿区西新宿1-2-3 (35.687574, 139.692566)');
  });

  it('No.11b 住所も題名もなくても座標は渡る', () => {
    expect(locationToText({ latitude: 35.687574, longitude: 139.692566 })).toBe(
      'ユーザーが位置情報を送った。(35.687574, 139.692566)'
    );
  });
});

describe('メディア種別の通知文', () => {
  it('取得できなかった動画は種別だけ伝える', () => {
    expect(mediaNoticeText('video')).toBe('ユーザーが動画を送った。');
  });

  it('ファイルは名前を添える', () => {
    expect(mediaNoticeText('file', '見積書.pdf')).toBe(
      'ユーザーがファイルを送った。名前: 見積書.pdf'
    );
  });

  it('音声は種別だけ伝える', () => {
    expect(mediaNoticeText('audio')).toBe('ユーザーが音声を送った。');
  });
});

describe('添付パスのプロンプトへの合流', () => {
  it('No.12 保存したパスがプロンプトに入る', () => {
    expect(
      buildPromptWithAttachments('添付ファイルを確認してください', ['/tmp/line_m1.jpg'])
    ).toBe('添付ファイルを確認してください\n\n[添付ファイル]\n  - /tmp/line_m1.jpg');
  });
});
