import { describe, it, expect } from 'vitest';
import {
  containsPseudoToolCall,
  stripPseudoToolCalls,
  PSEUDO_TOOLCALL_FEEDBACK_PROMPT,
  FRIENDLY_FALLBACK_MESSAGE,
} from '../src/local-llm/pseudo-toolcall.js';

describe('containsPseudoToolCall', () => {
  it('plain text は false', () => {
    expect(containsPseudoToolCall('こんにちは、今日もお疲れさま。')).toBe(false);
  });

  it('Harmony channel タグを検出', () => {
    expect(
      containsPseudoToolCall('了解。<|channel>thought\ncall:tool_search{query:arxiv}<channel|>続けます。')
    ).toBe(true);
  });

  it('tool_call タグを検出', () => {
    expect(containsPseudoToolCall('<|tool_call>call:fetch{url:http://example.com}<tool_call|>')).toBe(
      true
    );
  });

  it('stream 途中の open のみ (close 不在) も検出', () => {
    expect(containsPseudoToolCall('まずは <|channel>thought\ncall:tool_search{quer')).toBe(true);
  });

  it('bare 単独行 call:fn{args} を検出', () => {
    expect(containsPseudoToolCall('回答準備中\ncall:tool_search{query:arxiv}\nです。')).toBe(true);
  });

  it('普通の文中の「API call:」は誤検出しない', () => {
    expect(containsPseudoToolCall('API call: GET /v1/foo を実行しました。')).toBe(false);
  });

  it('cosmetic leak (先頭 bare thought) は strict drift 扱いしない (Step C 不要)', () => {
    // 本文がちゃんとあるので Step C で retry させる必要はない、silent strip だけで OK
    expect(containsPseudoToolCall('thought\narXiv検索中…\n結果は ...')).toBe(false);
  });

  it('cosmetic leak (末尾 bare thought) も strict drift 扱いしない', () => {
    expect(containsPseudoToolCall('応答完了\nthought')).toBe(false);
  });
});

describe('stripPseudoToolCalls', () => {
  it('plain text を変更しない', () => {
    const input = 'こんにちは、今日もお疲れさま。';
    expect(stripPseudoToolCalls(input)).toBe(input);
  });

  it('Harmony channel タグ全体を削除', () => {
    const input = '了解。<|channel>thought\ncall:tool_search{query:arxiv}<channel|>続けます。';
    expect(stripPseudoToolCalls(input)).toBe('了解。続けます。');
  });

  it('tool_call タグ全体を削除', () => {
    const input = '結果: <|tool_call>call:fetch{url:http://example.com}<tool_call|> done.';
    expect(stripPseudoToolCalls(input)).toBe('結果:  done.');
  });

  it('close 形式の揺れ (`</channel|>`) も削除', () => {
    expect(stripPseudoToolCalls('前置き<|channel>foo</channel|>後置き')).toBe('前置き後置き');
  });

  it('stream 途中の open のみ (close 不在) も削除', () => {
    expect(stripPseudoToolCalls('まずは <|channel>thought\ncall:tool_search{quer')).toBe('まずは');
  });

  it('bare 単独行 call:fn{args} を削除', () => {
    expect(stripPseudoToolCalls('回答準備中\ncall:tool_search{query:arxiv}\nです。')).toBe(
      '回答準備中\n\nです。'
    );
  });

  it('全体が drift のみなら空文字を返す', () => {
    expect(stripPseudoToolCalls('<|channel>thought\ncall:tool_search{query:arxiv}<channel|>')).toBe(
      ''
    );
  });

  it('「API call:」は素通り', () => {
    const input = 'API call: GET /v1/foo を実行しました。';
    expect(stripPseudoToolCalls(input)).toBe(input);
  });

  it('cosmetic leak (先頭 bare thought) を除去して本文を残す', () => {
    expect(stripPseudoToolCalls('thought\narXiv検索中…\n結果は ...')).toBe(
      'arXiv検索中…\n結果は ...'
    );
  });

  it('cosmetic leak (末尾 bare thought) を除去', () => {
    expect(stripPseudoToolCalls('応答完了\nthought')).toBe('応答完了');
  });

  it('strict drift と cosmetic leak が混在しても両方除去', () => {
    expect(stripPseudoToolCalls('thought\n結果\n<|channel>x<channel|>\nthought')).toBe('結果');
  });
});

describe('constants', () => {
  it('FEEDBACK_PROMPT は LLM 修正用文面を含む', () => {
    expect(PSEUDO_TOOLCALL_FEEDBACK_PROMPT).toContain('pseudo tool_call');
    expect(PSEUDO_TOOLCALL_FEEDBACK_PROMPT).toContain('plain text');
  });

  it('FRIENDLY_FALLBACK_MESSAGE はユーザフレンドリーな日本語', () => {
    expect(FRIENDLY_FALLBACK_MESSAGE).toContain('ごめん');
    expect(FRIENDLY_FALLBACK_MESSAGE).not.toMatch(/擬似|drift|tool_call/);
  });
});
