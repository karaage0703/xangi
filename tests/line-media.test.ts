import { describe, it, expect } from 'vitest';
import {
  lineContentUrl,
  lineContentAuthHeader,
  resolveContentSource,
  resolveContentRequest,
  stickerToText,
  locationToText,
  mediaNoticeText,
  mediaLabel,
  attachmentOnlyPrompt,
  extensionForMedia,
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

  it('LINE提供コンテンツの取得だけにBearer認証を付ける', () => {
    expect(resolveContentRequest({ type: 'line' }, '123456', 'tok_abc')).toEqual({
      url: 'https://api-data.line.me/v2/bot/message/123456/content',
      authHeader: { Authorization: 'Bearer tok_abc' },
    });
  });

  it('外部提供URLへChannel Access Tokenを送らない', () => {
    expect(
      resolveContentRequest(
        { type: 'external', originalContentUrl: 'https://media.example.com/video.mp4' },
        '123456',
        'tok_secret'
      )
    ).toEqual({ url: 'https://media.example.com/video.mp4' });
  });
});

describe('スタンプのテキスト化', () => {
  it('No.7 キーワードを先頭3個だけ使う', () => {
    expect(
      stickerToText({ keywords: ['OK', 'okie', 'super', 'great', 'alright'] })
    ).toBe('The user sent a sticker. Meaning: OK, okie, super');
  });

  it('No.8 メッセージスタンプは入力文字を主に置く', () => {
    expect(stickerToText({ keywords: ['happy'], text: 'ありがとう' })).toBe(
      'The user sent a sticker. 「ありがとう」（Meaning: happy）'
    );
  });

  it('No.8b キーワードが3個未満でもそのまま使う', () => {
    expect(stickerToText({ keywords: ['happy'] })).toBe(
      'The user sent a sticker. Meaning: happy'
    );
  });

  it('No.9 キーワードのないスタンプでも種別は伝わる', () => {
    expect(stickerToText({})).toBe('The user sent a sticker. ');
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
      'The user sent a location. LINE本社 / 東京都新宿区西新宿1-2-3 (35.687574, 139.692566)'
    );
  });

  it('No.11 題名がなくても住所と座標は渡る', () => {
    expect(
      locationToText({
        address: '東京都新宿区西新宿1-2-3',
        latitude: 35.687574,
        longitude: 139.692566,
      })
    ).toBe('The user sent a location. 東京都新宿区西新宿1-2-3 (35.687574, 139.692566)');
  });

  it('No.11b 住所も題名もなくても座標は渡る', () => {
    expect(locationToText({ latitude: 35.687574, longitude: 139.692566 })).toBe(
      'The user sent a location. (35.687574, 139.692566)'
    );
  });
});

describe('メディア種別の通知文', () => {
  it('取得できなかった動画は種別だけ伝える', () => {
    expect(mediaNoticeText('video')).toBe('The user sent 動画.');
  });

  it('ファイルは名前を添える', () => {
    expect(mediaNoticeText('file', '見積書.pdf')).toBe(
      'The user sent ファイル. Name: 見積書.pdf'
    );
  });

  it('音声は種別だけ伝える', () => {
    expect(mediaNoticeText('audio')).toBe('The user sent 音声.');
  });
});

describe('添付パスのプロンプトへの合流', () => {
  it('No.12 保存したパスがプロンプトに入る', () => {
    expect(
      buildPromptWithAttachments('添付ファイルを確認してください', ['/tmp/line_m1.jpg'])
    ).toBe('添付ファイルを確認してください\n\n[添付ファイル]\n  - /tmp/line_m1.jpg');
  });
});

describe('添付だけが届いたときの指示文', () => {
  it('種別・LINEの制約・文脈での判断・質問の許可をすべて含む', () => {
    expect(attachmentOnlyPrompt('ファイル')).toBe(
      [
        'The user sent ファイル.',
        '- LINE cannot include text with images or files, so no instruction accompanies this attachment',
        '- Inspect the content and respond based on the conversation so far',
        '- Ask the user if the desired action is unclear from context',
      ].join('\n')
    );
  });

  it('種別ラベルが差し替わる', () => {
    expect(attachmentOnlyPrompt('画像')).toContain('The user sent 画像.');
    expect(mediaLabel('video')).toBe('動画');
    expect(mediaLabel('audio')).toBe('音声');
  });
});

describe('保存名の拡張子', () => {
  it('ファイルは fileName の拡張子を使う', () => {
    expect(extensionForMedia({ type: 'file', fileName: '見積書.pdf' })).toBe('pdf');
  });

  it('拡張子のないファイル名なら bin に落とす', () => {
    expect(extensionForMedia({ type: 'file', fileName: 'README' })).toBe('bin');
  });

  it('怪しい拡張子は採らない', () => {
    expect(extensionForMedia({ type: 'file', fileName: 'a.thisisnotanext' })).toBe('bin');
  });

  it('画像・動画・音声は種別から決める', () => {
    expect(extensionForMedia({ type: 'image' })).toBe('jpg');
    expect(extensionForMedia({ type: 'video' })).toBe('mp4');
    expect(extensionForMedia({ type: 'audio' })).toBe('m4a');
  });
});
