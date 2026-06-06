import { describe, it, expect } from 'vitest';
import { stripToolCallArtifacts, finalizeDisplayText } from '../src/tool-call-sanitize.js';
import { FRIENDLY_FALLBACK_MESSAGE } from '../src/local-llm/pseudo-toolcall.js';

describe('stripToolCallArtifacts', () => {
  it('ツールコール構文を含まないテキストはそのまま返す', () => {
    const text = '📚 過去記事から掘り出し物\nずっと欲しかったアプリの話';
    expect(stripToolCallArtifacts(text)).toBe(text);
  });

  it('空文字はそのまま返す', () => {
    expect(stripToolCallArtifacts('')).toBe('');
  });

  // --- Anthropic / Claude 形式 ---

  it('先頭の call 行 + <invoke>ブロック + 後続テキストから XML だけ消す（実事象の再現）', () => {
    const leaked =
      'call\n<invoke name="Bash">\n<parameter name="command">cd /x && uv run python fetch.py | head -c 4000</parameter>\n<parameter name="description">取得</parameter>\n</invoke>記事を選んで X 向けの投稿文を作った。';
    const out = stripToolCallArtifacts(leaked);
    expect(out).not.toContain('<invoke');
    expect(out).not.toContain('<parameter');
    expect(out).not.toMatch(/(^|\n)call(\n|$)/);
    expect(out).toContain('記事を選んで X 向けの投稿文を作った。');
  });

  it('<function_calls> ラッパ形式も除去する', () => {
    const leaked =
      '<function_calls>\n<invoke name="Read">\n<parameter name="file_path">/a</parameter>\n</invoke>\n</function_calls>\n本文';
    const out = stripToolCallArtifacts(leaked);
    expect(out).not.toContain('<function_calls');
    expect(out).not.toContain('<invoke');
    expect(out).toContain('本文');
  });

  it('閉じタグ欠落でストリームが途中切断した場合は開きタグ以降を落とす', () => {
    const leaked = '進捗報告です。\ncall\n<invoke name="Bash">\n<parameter name="command">long...';
    const out = stripToolCallArtifacts(leaked);
    expect(out).not.toContain('<invoke');
    expect(out).not.toContain('<parameter');
    expect(out).toContain('進捗報告です。');
  });

  it('antml: prefix 付きの invoke も除去する', () => {
    // リテラルでタグを書くとツール解析を誘発するため連結で組み立てる
    const open = '<' + 'antml:invoke name="X">';
    const param = '<' + 'antml:parameter name="p">v</' + 'antml:parameter>';
    const close = '</' + 'antml:invoke>';
    const leaked = 'before' + open + param + close + 'after';
    const out = stripToolCallArtifacts(leaked);
    expect(out).not.toContain('invoke');
    expect(out).not.toContain('parameter');
    expect(out).toBe('beforeafter');
  });

  it('ツールコール XML だけのブロックは空文字に倒す', () => {
    const strayOnly =
      'call\n<invoke name="Bash">\n<parameter name="command">x</parameter>\n</invoke>';
    expect(stripToolCallArtifacts(strayOnly)).toBe('');
  });

  // --- Local LLM / Gemma・Harmony 形式（汎用層が pseudo もカバーすることの確認）---

  it('擬似 tool_call（call:fn{args}）も同じ関数で除去する', () => {
    const leaked = '回答準備中\ncall:tool_search{query:arxiv}\nです。';
    const out = stripToolCallArtifacts(leaked);
    expect(out).not.toContain('call:tool_search');
    expect(out).toContain('回答準備中');
    expect(out).toContain('です。');
  });

  it('Harmony channel タグも除去する', () => {
    expect(stripToolCallArtifacts('前置き<|channel>foo</channel|>後置き', { trim: true })).toBe(
      '前置き後置き'
    );
  });

  // --- 両ファミリ混在（汎用化の意義）---

  it('Anthropic 形式と擬似 tool_call が混在しても両方除去する', () => {
    const leaked =
      'まず調べる。\ncall\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>\ncall:tool_search{query:foo}\n結果はこちら。';
    const out = stripToolCallArtifacts(leaked, { trim: true });
    expect(out).not.toContain('<invoke');
    expect(out).not.toContain('call:tool_search');
    expect(out).toContain('まず調べる。');
    expect(out).toContain('結果はこちら。');
  });

  it('trim オプションで前後の空白を落とす', () => {
    const leaked = '\n\n<invoke name="X"><parameter name="p">v</parameter></invoke>本文\n\n';
    expect(stripToolCallArtifacts(leaked, { trim: true })).toBe('本文');
  });
});

describe('finalizeDisplayText', () => {
  it('通常テキストはそのまま返す（trim される）', () => {
    expect(finalizeDisplayText('  画像生成の再現性の話だね  ')).toBe('画像生成の再現性の話だね');
  });

  it('モデルが本文を出さず空 result の場合は ✅ ではなく fallback を返す（実事象の再現）', () => {
    // 6/2 21:52 #xangi_work_02: end_turn だが result が空 → Discord 層で `|| '✅'` に落ちた
    expect(finalizeDisplayText('')).toBe(FRIENDLY_FALLBACK_MESSAGE);
    expect(finalizeDisplayText('   \n  ')).toBe(FRIENDLY_FALLBACK_MESSAGE);
  });

  it('null / undefined でも fallback を返す', () => {
    expect(finalizeDisplayText(null)).toBe(FRIENDLY_FALLBACK_MESSAGE);
    expect(finalizeDisplayText(undefined)).toBe(FRIENDLY_FALLBACK_MESSAGE);
  });

  it('tool-call 構文だけで本文が無い場合も fallback を返す（strip → 空 → ✅ を防ぐ）', () => {
    const onlyXml =
      'call\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>';
    expect(finalizeDisplayText(onlyXml)).toBe(FRIENDLY_FALLBACK_MESSAGE);
  });

  it('構文 + 本文が混在する場合は本文だけ返す', () => {
    const mixed =
      'call\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>調べた結果はこう。';
    expect(finalizeDisplayText(mixed)).toBe('調べた結果はこう。');
  });
});
