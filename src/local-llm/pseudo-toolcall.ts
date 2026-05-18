// 一部のローカル LLM は tool_choice='none' を指定しても、
// 「tool 呼びたい気持ち」を special token ナシの擬似テキストで hallucinate する drift がある。
// 例: `<|channel>thought\ncall:fn{args}<channel|>` や bare `call:fn{args}`。
// OpenAI 互換 inference サーバの tool_call parser は special token 経路のみ拾う実装が多く、
// このような raw text 形式の擬似 tool_call は素通りしてしまう。
//
// このモジュールは drift の検出 (containsPseudoToolCall) と除去 (stripPseudoToolCalls) を提供する。
// runner は最終 chatStream 完了後に containsPseudoToolCall で drift を検知し、検知時は
// LLM にフィードバックして再生成させる (Step C)。retry でも drift なら strip して
// 親切な fallback メッセージに差し替える (Step D)。

/**
 * Strict drift = LLM が「tool 呼びたい」気持ちを擬似テキストで吐いた状態。
 * このパターンが見つかったら Step C で LLM に feedback して retry を要求する
 * (実応答が欠けてる/置き換えられてる可能性が高いため)。
 */
const STRICT_DRIFT_PATTERNS: RegExp[] = [
  // Harmony channel タグ (open + 中身 + close、close 形式の揺れ対応)
  /<\|channel\|?>[\s\S]*?<\|?\/?channel\|?>/g,
  // 擬似 tool_call タグ (open/close 揺れ)
  /<\|tool_call\|?>[\s\S]*?<\|?\/?tool_call\|?>/g,
  // open のみで close が来ない (stream 途中 or 不完全) パターン
  /<\|channel\|?>[\s\S]*$/,
  /<\|tool_call\|?>[\s\S]*$/,
  // thought\ncall:fn{args} の bare 形式 (タグ無しで直接漏れる場合)
  /^thought\s*\n+call:\w+\s*\{[^}]*\}\s*$/gm,
  // 単独行の call:fn{args}
  /^\s*call:\w+\s*\{[^}]*\}\s*$/gm,
];

/**
 * Cosmetic leak = harmony 系の section marker が漏れただけで、本文は通常通り出てる状態。
 * 例: 応答の先頭・末尾に bare `thought\n` だけある (本来 special token で囲まれるべき箇所が
 * raw text として漏れた)。Step C retry の必要は無く、silent strip だけする。
 */
const COSMETIC_LEAK_PATTERNS: RegExp[] = [
  // 先頭の bare `thought\n` (後続に本文がある場合の harmony marker leak)
  /^thought\s*\n+/,
  // 末尾の bare `\nthought` (本文の後に marker が残った場合)
  /\n+thought\s*$/,
];

/**
 * Strict drift パターンを検出する (1 つでもマッチすれば true)。
 * これが true の時は Step C で LLM に feedback して retry を要求する。
 */
export function containsPseudoToolCall(text: string): boolean {
  for (const pattern of STRICT_DRIFT_PATTERNS) {
    if (new RegExp(pattern.source, pattern.flags).test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Strict drift + cosmetic leak を全部除去して trim する。
 * containsPseudoToolCall が false でも cosmetic leak は残ってる可能性があるので、
 * 最終出力の整形には常にこの関数を通す。
 */
export function stripPseudoToolCalls(text: string): string {
  let result = text;
  for (const pattern of [...STRICT_DRIFT_PATTERNS, ...COSMETIC_LEAK_PATTERNS]) {
    result = result.replace(pattern, '');
  }
  return result.trim();
}

/** drift 検出時に LLM に返すフィードバック system message */
export const PSEUDO_TOOLCALL_FEEDBACK_PROMPT = `Your previous response contained pseudo tool_call text (e.g., \`call:tool_name{args}\` or \`<|channel>...<|channel>\`). This is invalid syntax — the system cannot execute it.

Choose ONE of the following:
1. Call a real tool from your tools[] list using the proper tool_call structure (not as text).
2. Respond to the user in plain text WITHOUT any tool_call-like syntax. Even if you can't fully answer, explain what you tried and what's missing.

Do NOT repeat the pseudo tool_call text. Do NOT write \`thought\\ncall:...\` or \`<|channel>...\`.`;

/** Step D の親切な fallback メッセージ */
export const FRIENDLY_FALLBACK_MESSAGE =
  'ごめん、うまく応答を組み立てられなかった。質問をシンプルにして、もう一度試してくれる？';
