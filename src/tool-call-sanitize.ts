// 表示テキストに漏れた「ツールコール構文」を除去する汎用サニタイザ。
//
// バックエンド（Claude / Local LLM）に関わらず、LLM はまれに構造化された
// tool 呼び出しではなく、ツールコール構文を **そのままテキストとして** 吐く
// ことがある。中継 UI（Discord / Slack / Web）に生の構文が届くのを防ぐため、
// 表示境界でこの 1 関数を通す。バックエンドごとの個別パッチを増やさず、
// 「ユーザーに生のツールコール構文を見せない」という単一の不変条件に集約する。
//
// 対応する構文ファミリ:
// - Anthropic / Claude 形式: `call\n<invoke name="...">...<parameter ...>...</invoke>`
//   `<function_calls>...</function_calls>`（`antml:` prefix 付き含む）
// - Local LLM / Gemma・Harmony 形式: `<|tool_call>call:fn{args}<tool_call|>`、
//   `<|channel>thought...<channel|>`、bare `call:fn{args}` 等
//   （後者の実パターンは local-llm/pseudo-toolcall.ts が一次定義し、ここから委譲）

import {
  applyPseudoToolCallStrip,
  FRIENDLY_FALLBACK_MESSAGE,
} from './local-llm/pseudo-toolcall.js';

/** Anthropic（Claude）形式のツールコール XML を除去する（trim はしない） */
function stripAnthropicToolCallXml(text: string): string {
  if (!/<(?:antml:)?(?:invoke|function_calls)\b/i.test(text)) {
    return text;
  }
  let t = text;
  // ツールコールブロック直前の単独 `call` 行を、ブロックごと巻き込んで消す
  t = t.replace(
    /(?:^|\n)[ \t]*call[ \t]*(?=\n[ \t]*<(?:antml:)?(?:invoke|function_calls)\b)/gi,
    '\n'
  );
  // <function_calls>...</function_calls>
  t = t.replace(/<(?:antml:)?function_calls\b[\s\S]*?<\/(?:antml:)?function_calls>/gi, '');
  // <invoke ...>...</invoke>
  t = t.replace(/<(?:antml:)?invoke\b[\s\S]*?<\/(?:antml:)?invoke>/gi, '');
  // 孤立した <parameter ...>...</parameter>
  t = t.replace(/<(?:antml:)?parameter\b[\s\S]*?<\/(?:antml:)?parameter>/gi, '');
  // 閉じタグが無いまま末尾まで続く開きタグ（ストリーム途中切断の保険）
  t = t.replace(/<(?:antml:)?(?:invoke|function_calls)\b[\s\S]*$/gi, '');
  return t;
}

export interface SanitizeOptions {
  /** 前後の空白を trim するか（最終表示は true、ストリーミング途中の連結は false 推奨） */
  trim?: boolean;
}

/**
 * 全ファミリのツールコール構文を表示テキストから除去する汎用サニタイザ。
 *
 * - Anthropic 形式と Local LLM 形式の両方を順に除去
 * - 除去後に空白のみ残るブロックは空文字に倒す（バブル蓄積で余計な空行が
 *   前置されるのを防ぐ）
 * - `trim: true` で最終表示向けに前後空白も落とす
 */
export function stripToolCallArtifacts(text: string, opts: SanitizeOptions = {}): string {
  if (!text) return text;
  let t = stripAnthropicToolCallXml(text);
  t = applyPseudoToolCallStrip(t);
  // 除去で生じた 3 連以上の空行を畳む
  t = t.replace(/\n{3,}/g, '\n\n');
  if (opts.trim) t = t.trim();
  // ツールコール構文だけのブロックは中身が空白のみになる → 空文字に倒す
  if (t.trim() === '') return '';
  return t;
}

/**
 * 最終表示テキストを確定する汎用ヘルパ。
 *
 * tool-call 構文を除去（trim 付き）した上で、結果が空になった場合は
 * 誤解を招く成功マーク（Discord/Slack の `|| '✅'` fallback）ではなく
 * 正直な fallback メッセージを返す。
 *
 * 空になる経路は 2 つあり、どちらも「✅」を出すべきでない:
 * - 出力が tool-call 構文だけで、strip した結果が空（drift / XML 漏れの裏返し）
 * - モデルが本文テキストを 1 文字も出さずにターンを終えた
 *   （例: 拡張思考だけで end_turn、`result: ""` + `output_tokens > 0`）
 *
 * Claude 経路・Local LLM 経路のどちらの最終 result にも通せる
 * （strip は idempotent なので二重適用しても安全）。
 */
export function finalizeDisplayText(text: string | undefined | null): string {
  const clean = stripToolCallArtifacts(text ?? '', { trim: true });
  return clean || FRIENDLY_FALLBACK_MESSAGE;
}
