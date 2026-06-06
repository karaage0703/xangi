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
 * Strict drift + cosmetic leak を除去する（trim はしない素の core）。
 * 汎用サニタイザ（tool-call-sanitize.ts）から他ファミリと合成するために公開する。
 */
export function applyPseudoToolCallStrip(text: string): string {
  let result = text;
  for (const pattern of [...STRICT_DRIFT_PATTERNS, ...COSMETIC_LEAK_PATTERNS]) {
    result = result.replace(pattern, '');
  }
  return result;
}

/**
 * Strict drift + cosmetic leak を全部除去して trim する。
 * containsPseudoToolCall が false でも cosmetic leak は残ってる可能性があるので、
 * 最終出力の整形には常にこの関数を通す。
 */
export function stripPseudoToolCalls(text: string): string {
  return applyPseudoToolCallStrip(text).trim();
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

// ============================================================================
// parse-and-execute rescue + structured feedback
//
// 旧 Step C/D は drift を「検出 → generic prompt で retry → strip して fallback」
// しかしなかったため、出力意図が parseable な擬似 tool_call (例: `call:fn{args}`)
// も意図ごと捨てて空 fallback に落ちる事故があった。本セクションは drift から意図を
// 救済する 3 層を提供する:
//
// 1. parsePseudoToolCall: 擬似テキストから (name, args) を抽出
// 2. isSafeForRescue: 副作用なしの read-only tool だけ救済対象に判定 (allowlist)
// 3. buildStructuredFeedback: 構造化エラーで LLM に self-correct を促す
// ============================================================================

/**
 * 擬似 tool_call テキストの parse 対象パターン (anchored grammar)。
 * 「出力全体が pseudo call だけ」or「thought + call だけ」のケース限定で rescue する。
 * 文中の `API call:` 等は false positive を避けるため対象外。
 */
const PSEUDO_TOOLCALL_PARSE_PATTERNS: RegExp[] = [
  // Harmony channel タグ内の call:fn{args}
  /<\|channel\|?>\s*(?:thought\s*\n+)?call:(\w+)\s*\{([\s\S]*?)\}\s*<\|?\/?channel\|?>/,
  // tool_call タグ内の call:fn{args}
  /<\|tool_call\|?>\s*call:(\w+)\s*\{([\s\S]*?)\}\s*<\|?\/?tool_call\|?>/,
  // 行頭 thought\ncall:fn{args} (close タグなし)
  /^thought\s*\n+call:(\w+)\s*\{([^}]*)\}\s*$/m,
  // 行頭 単独 call:fn{args}
  /^\s*call:(\w+)\s*\{([^}]*)\}\s*$/m,
];

/**
 * 擬似 tool_call args の tolerant parser。
 * Gemma 4 が吐く形式は厳密な JSON ではなく、unquoted key/value が混じる:
 *   `{command:xangi-cmd discord_history --channel 1505... --count 10}`
 *   `{query: arxiv}`
 *   `{"command": "ls"}`  ← まれに JSON が出る場合もある
 *
 * 1. まず JSON.parse を試す (proper JSON のケース)
 * 2. 失敗したら `key:value` 形式の tolerant parse
 *    - 最初の `:` で key と value を分割
 *    - quote 無しの value はそのまま (前後 trim)
 *    - 複数 key は `,` 区切り (但し value 内の `,` は厳密扱いせず安全側で fail)
 *
 * 失敗時は null。
 */
function parsePseudoArgs(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (!trimmed) return {};

  // 1. proper JSON
  try {
    const parsed = JSON.parse(`{${trimmed}}`);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to tolerant parse
  }

  // 2. tolerant: 単一 key:value のみ厳密に拾う (`,` を含む場合は failsafe)
  // (Gemma 4 の現実の出力はほぼ単一 key の `{command: "..."}` 形式)
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx < 0) return null;
  const rawKey = trimmed.slice(0, colonIdx).trim();
  const rawValue = trimmed.slice(colonIdx + 1).trim();
  // key は ASCII 識別子のみ受け付ける (false positive 回避)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawKey)) return null;
  // value の前後 quote を剥がす
  let value: string = rawValue;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { [rawKey]: value };
}

/**
 * 擬似 tool_call テキストから tool_name と args を抽出する。
 * anchored grammar (出力全体 or thought+call 形式) にマッチしない場合は null。
 * 「文中の `call:` 単語」のような false positive は対象外。
 */
export function parsePseudoToolCall(
  text: string
): { name: string; args: Record<string, unknown> } | null {
  for (const pattern of PSEUDO_TOOLCALL_PARSE_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      const name = m[1];
      const body = m[2] ?? '';
      const args = parsePseudoArgs(body);
      if (args === null) continue;
      return { name, args };
    }
  }
  return null;
}

/**
 * 擬似 tool_call を救済実行してよいかの安全判定 (allowlist)。
 * 副作用のないツール / 副作用のない xangi-cmd サブコマンドだけ救済対象にする。
 *
 * denylist 方式 (例えば `rm/curl/git` を弾く) は抜け道が多いため使わない。allowlist で
 * 安全なツール/サブコマンドのみを明示的に許可する。`exec` 系は shell metacharacter
 * (pipe / redirect / `&&` / `;` / `$()` / backtick) を含んでいたら即 reject。
 */
const READ_ONLY_RESCUE_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'tool_search',
  'discord_history',
  'web_history',
  'slack_history',
  'discord_channels',
  'discord_search',
  'schedule_list',
]);

const SAFE_XANGI_SUBCOMMANDS = new Set([
  'discord_history',
  'web_history',
  'slack_history',
  'discord_channels',
  'discord_search',
  'schedule_list',
  'system_settings',
]);

const SHELL_METACHAR_PATTERN = /[|&;`$<>]/;
const PARENTHESIS_PATTERN = /\$\(|`/;
const REDIRECT_PATTERN = />>?\s*\S/;
const AND_OR_PATTERN = /&&|\|\|/;

export interface SafetyCheck {
  safe: boolean;
  reason?: string;
}

export function isSafeForRescue(name: string, args: Record<string, unknown>): SafetyCheck {
  if (READ_ONLY_RESCUE_TOOLS.has(name)) {
    return { safe: true };
  }

  if (name === 'exec' || name === 'bash') {
    const cmd = String(args.command ?? args.script ?? args.code ?? '');
    if (!cmd) return { safe: false, reason: 'empty command' };
    if (
      SHELL_METACHAR_PATTERN.test(cmd) ||
      PARENTHESIS_PATTERN.test(cmd) ||
      REDIRECT_PATTERN.test(cmd) ||
      AND_OR_PATTERN.test(cmd)
    ) {
      return {
        safe: false,
        reason:
          'shell metacharacters (pipe/redirect/&&/;/$()/backtick) detected — not safe to rescue',
      };
    }
    const match = cmd.match(/^xangi-cmd\s+([a-z_]+)/);
    if (match && SAFE_XANGI_SUBCOMMANDS.has(match[1])) {
      return { safe: true };
    }
    return {
      safe: false,
      reason: `exec command not in rescue allowlist (only xangi-cmd ${[...SAFE_XANGI_SUBCOMMANDS].join('/')} allowed)`,
    };
  }

  return {
    safe: false,
    reason: `tool '${name}' is not in rescue allowlist (read-only tools and safe xangi-cmd subcommands only)`,
  };
}

/**
 * 構造化エラーレコード。
 * LLM に self-correct を促すため、何が起きたか + どう直すか + 許可された次アクションを
 * JSON で明示する。汎用 prompt よりも構造化された情報のほうが moderately-sized LLM の
 * 自己修正率が高いことが知られている。
 */
export interface StructuredErrorRecord {
  kind:
    | 'pseudo_format_drift'
    | 'unsafe_tool_in_pseudo_format'
    | 'already_executed'
    | 'unparseable_pseudo_call';
  attempted_tool?: string;
  attempted_args?: Record<string, unknown>;
  reason: string;
  hint: string;
  allowed_actions: string[];
}

/**
 * 構造化エラーを LLM 向け system message に整形する。
 * `[SYSTEM ERROR RECORD]` デリミタで LLM の出力汚染 (構造化 JSON をそのまま貼り付ける誤動作) を抑止。
 */
export function buildStructuredFeedback(record: StructuredErrorRecord): string {
  return `[SYSTEM ERROR RECORD]
${JSON.stringify(record, null, 2)}
[END SYSTEM ERROR RECORD]

Use this information to make your next attempt. Do NOT copy or echo this JSON into your reply. Either:
1. Call a tool using the proper function_calling structure (not text like \`call:fn{args}\`), or
2. Respond to the user in plain text without any tool_call-like syntax. Explain briefly what you'll do differently.`;
}

/**
 * 末尾にあれば「partial drift (close 待ち)」と判断する partial パターン。
 * これらが末尾にある間は chunk を release せず hold する。
 *
 * - `<|channel` / `<|tool_call` の open のみ (close が来ていない stream 途中)
 * - 単独行末尾の `thought` (改行が来れば `call:` が続く可能性、別の意味なら release)
 * - `call:fn{...` の閉じ括弧 `}` が来ていない (引数 stream 途中)
 *
 * 安全側に倒す: 「partial の可能性がある」と判定した時点で hold、明確に通常 text と
 * 分かる文字 (改行で文を完結している等) が来てから release する。
 */
const PARTIAL_DRIFT_TAIL_PATTERNS: RegExp[] = [
  /<\|channel[^>]*$/,
  /<\|tool_call[^>]*$/,
  /(?:^|\n)thought\s*\n*\s*$/,
  /(?:^|\n)\s*call:\w*\{[^}]*$/,
  /(?:^|\n)\s*call:\w*$/,
];

/**
 * streaming chunk を受け取り、Discord 等にすぐ release してよいテキストと、
 * drift パターン途中の可能性があり hold すべきテキストを分離する hold buffer。
 *
 * streaming 中に `thought\n` / `call:` / `<|tool_call` 等の partial pattern を検出
 * したらチャンク表示を停止し、後続 chunk と合わせて strict drift として再解釈する。
 *
 * 動作:
 * - feed(chunk): chunk を buffer に追加
 *   1. 完全な strict drift パターンがあれば strip (drop)
 *   2. buffer 末尾に partial drift パターンがあれば、そこから先を hold
 *   3. それ以外を release として返す
 * - flush(): stream 終了時に呼ぶ。残った hold は安全側で drop (drift だった可能性が高い)。
 *   ただし呼び出し側で残骸を Step C/D の最終 drift 検証 (containsPseudoToolCall) に
 *   通すために `getHeld()` で取り出してもよい。
 */
export class StreamingDriftBuffer {
  private buf: string = '';
  private droppedAny: boolean = false;

  /**
   * chunk を受け取り、release すべきテキストと drift drop の有無を返す。
   * release が空文字列の場合、呼び出し側は Discord に送信してはいけない (hold 状態)。
   */
  feed(chunk: string): { release: string; dropped: boolean } {
    this.buf += chunk;

    // 1. 完全な strict drift パターンを除去 (drop 検出)
    let dropped = false;
    for (const pattern of STRICT_DRIFT_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      if (re.test(this.buf)) {
        this.buf = this.buf.replace(re, '');
        dropped = true;
        this.droppedAny = true;
      }
    }

    // 2. buffer 末尾に partial drift パターンがあるか確認
    let earliestPartialIdx = -1;
    for (const pattern of PARTIAL_DRIFT_TAIL_PATTERNS) {
      const match = pattern.exec(this.buf);
      if (match && match.index >= 0) {
        if (earliestPartialIdx === -1 || match.index < earliestPartialIdx) {
          earliestPartialIdx = match.index;
        }
      }
    }

    if (earliestPartialIdx >= 0) {
      // partial の手前までを release、partial 部分は次回 feed まで hold
      const release = this.buf.slice(0, earliestPartialIdx);
      this.buf = this.buf.slice(earliestPartialIdx);
      return { release, dropped };
    }

    // partial なし → 全部 release
    const release = this.buf;
    this.buf = '';
    return { release, dropped };
  }

  /**
   * stream 終了時に呼ぶ。残った hold buffer を返す (呼び出し側で最終 drift 検証に通す)。
   * 安全側で「partial のまま残った場合」は drop 扱いにせず最終応答にマージして
   * Step C/D の通常フロー (containsPseudoToolCall + retry + strip) で処理する。
   */
  flush(): { release: string; droppedAny: boolean } {
    const release = this.buf;
    this.buf = '';
    const droppedAny = this.droppedAny;
    this.droppedAny = false;
    return { release, droppedAny };
  }

  /** テスト/デバッグ用: 現在 hold 中の内容を読み取る (副作用なし) */
  peek(): string {
    return this.buf;
  }
}
