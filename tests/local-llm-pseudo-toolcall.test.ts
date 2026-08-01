import { describe, it, expect } from 'vitest';
import {
  containsPseudoToolCall,
  stripPseudoToolCalls,
  parsePseudoToolCall,
  isSafeForRescue,
  buildStructuredFeedback,
  StreamingDriftBuffer,
  PSEUDO_TOOLCALL_FEEDBACK_PROMPT,
  FRIENDLY_FALLBACK_MESSAGE,
} from '../src/local-llm/pseudo-toolcall.js';

describe('containsPseudoToolCall', () => {
  it('plain text は false', () => {
    expect(containsPseudoToolCall('こんにちは、今日もお疲れさま。')).toBe(false);
  });

  it('Harmony channel タグを検出', () => {
    expect(
      containsPseudoToolCall(
        '了解。<|channel>thought\ncall:tool_search{query:arxiv}<channel|>続けます。'
      )
    ).toBe(true);
  });

  it('tool_call タグを検出', () => {
    expect(
      containsPseudoToolCall('<|tool_call>call:fetch{url:http://example.com}<tool_call|>')
    ).toBe(true);
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

describe('StreamingDriftBuffer', () => {
  it('plain text は即 release', () => {
    const buf = new StreamingDriftBuffer();
    expect(buf.feed('こんにちは ')).toEqual({ release: 'こんにちは ', dropped: false });
    expect(buf.feed('今日もお疲れさま。')).toEqual({
      release: '今日もお疲れさま。',
      dropped: false,
    });
    expect(buf.flush()).toEqual({ release: '', droppedAny: false });
  });

  it('chunk 途中の <|channel open は hold、次 chunk の close 後に drop', () => {
    const buf = new StreamingDriftBuffer();
    const r1 = buf.feed('先頭テキスト <|channel');
    // open のみ → 先頭テキスト release、open 以降は hold
    expect(r1.release).toBe('先頭テキスト ');
    expect(r1.dropped).toBe(false);
    expect(buf.peek()).toContain('<|channel');

    // close 完成 + 続きの本文
    const r2 = buf.feed('>thought\ncall:tool_search{query:arxiv}<channel|>続けます。');
    // 完全な drift は drop、後続の通常テキストだけ release
    expect(r2.dropped).toBe(true);
    expect(r2.release).toContain('続けます');
    expect(r2.release).not.toContain('channel');
    expect(r2.release).not.toContain('call:');
  });

  it('bare call: 末尾は hold (直前の改行も hold 側に含める)', () => {
    const buf = new StreamingDriftBuffer();
    const r1 = buf.feed('結果は\ncall:fetch{url:http');
    // partial pattern は (?:^|\n)\s*call:... を含むので \n から hold 開始
    expect(r1.release).toBe('結果は');
    expect(buf.peek()).toContain('call:fetch');
    expect(buf.peek().startsWith('\n')).toBe(true);
  });

  it('完全 strict drift は途中で drop、release は drift 除去後のみ', () => {
    const buf = new StreamingDriftBuffer();
    const r = buf.feed('まずは <|tool_call>call:exec{cmd:ls}<tool_call|> を実行します。');
    expect(r.dropped).toBe(true);
    expect(r.release).toContain('まずは ');
    expect(r.release).toContain('を実行します');
    expect(r.release).not.toContain('tool_call');
  });

  it('flush() で残った hold を release (Step C/D の最終検証に通す)', () => {
    const buf = new StreamingDriftBuffer();
    buf.feed('途中で切れた <|channel');
    const flushed = buf.flush();
    expect(flushed.release).toContain('<|channel');
    expect(flushed.droppedAny).toBe(false);
  });

  it('drop が一度でもあったら flush の droppedAny は true', () => {
    const buf = new StreamingDriftBuffer();
    buf.feed('<|tool_call>call:x{a:1}<tool_call|>');
    expect(buf.flush().droppedAny).toBe(true);
  });

  it('部分的な thought\\ncall: が前後の text と混在 → 適切に release/hold 分離', () => {
    const buf = new StreamingDriftBuffer();
    // 通常 text に bare "thought\n" が末尾に来る = partial として hold (\n から hold 側)
    const r1 = buf.feed('前段の本文があって\nthought\n');
    expect(r1.release).toBe('前段の本文があって');
    expect(buf.peek()).toContain('thought');
  });

  it('peek() は副作用なしで buffer 内容を返す', () => {
    const buf = new StreamingDriftBuffer();
    buf.feed('aaa <|channel');
    const before = buf.peek();
    const before2 = buf.peek();
    expect(before).toBe(before2);
    expect(before).toContain('<|channel');
  });
});

// ============================================================================
// parsePseudoToolCall
// ============================================================================

describe('parsePseudoToolCall', () => {
  it('bare call:fn{key:value} を name + args に分解', () => {
    const parsed = parsePseudoToolCall('call:tool_search{query:arxiv}');
    expect(parsed).toEqual({ name: 'tool_search', args: { query: 'arxiv' } });
  });

  it('実例: call:exec{command:xangi-cmd discord_history ...} を分解', () => {
    const parsed = parsePseudoToolCall(
      'call:exec{command:xangi-cmd discord_history --channel 1505945594835898460 --count 10}'
    );
    expect(parsed).toEqual({
      name: 'exec',
      args: { command: 'xangi-cmd discord_history --channel 1505945594835898460 --count 10' },
    });
  });

  it('thought\\ncall:fn{args} 形式も parse', () => {
    const parsed = parsePseudoToolCall('thought\ncall:read{path:/tmp/foo.txt}');
    expect(parsed).toEqual({ name: 'read', args: { path: '/tmp/foo.txt' } });
  });

  it('Harmony channel タグ内の call も parse', () => {
    const parsed = parsePseudoToolCall(
      '<|channel>thought\ncall:tool_search{query:calendar}<channel|>'
    );
    expect(parsed).toEqual({ name: 'tool_search', args: { query: 'calendar' } });
  });

  it('proper JSON 形式の args も parse', () => {
    const parsed = parsePseudoToolCall('call:read{"path": "/tmp/foo.txt"}');
    expect(parsed).toEqual({ name: 'read', args: { path: '/tmp/foo.txt' } });
  });

  it('quote 付き value も剥がす', () => {
    const parsed = parsePseudoToolCall('call:read{path:"/tmp/foo.txt"}');
    expect(parsed).toEqual({ name: 'read', args: { path: '/tmp/foo.txt' } });
  });

  it('plain text には false (null)', () => {
    expect(parsePseudoToolCall('普通の会話です')).toBeNull();
  });

  it('「API call: GET /v1/foo」のような文中 call: は false (anchored grammar)', () => {
    expect(parsePseudoToolCall('API call: GET /v1/foo を実行しました')).toBeNull();
  });

  it('args が空 { } の場合は空 args を返す', () => {
    const parsed = parsePseudoToolCall('call:tool_search{}');
    expect(parsed).toEqual({ name: 'tool_search', args: {} });
  });

  it('args 内に `:` が含まれる URL のような値も parse', () => {
    const parsed = parsePseudoToolCall('call:fetch{url:https://example.com/foo}');
    expect(parsed).toEqual({ name: 'fetch', args: { url: 'https://example.com/foo' } });
  });
});

// ============================================================================
// isSafeForRescue
// ============================================================================

describe('isSafeForRescue', () => {
  it('read-only tool (read) は safe', () => {
    expect(isSafeForRescue('read', { path: '/tmp/foo.txt' }).safe).toBe(true);
  });

  it('read-only tool (tool_search) は safe', () => {
    expect(isSafeForRescue('tool_search', { query: 'arxiv' }).safe).toBe(true);
  });

  it('discord_history は safe (read-only tool list)', () => {
    expect(isSafeForRescue('discord_history', { channel: '123', count: 10 }).safe).toBe(true);
  });

  it('discord_message は safe (read-only tool list)', () => {
    expect(isSafeForRescue('discord_message', { channel: '123', 'message-id': '456' }).safe).toBe(
      true
    );
  });

  it('exec で xangi-cmd discord_history は safe (allowlist)', () => {
    expect(
      isSafeForRescue('exec', { command: 'xangi-cmd discord_history --channel 123 --count 10' })
        .safe
    ).toBe(true);
  });

  it('exec で xangi-cmd discord_message は safe (allowlist)', () => {
    expect(
      isSafeForRescue('exec', {
        command: 'xangi-cmd discord_message --channel 123 --message-id 456',
      }).safe
    ).toBe(true);
  });

  it('exec で xangi-cmd web_history も safe', () => {
    expect(isSafeForRescue('exec', { command: 'xangi-cmd web_history --count 10' }).safe).toBe(
      true
    );
  });

  it('slack_search は safe (read-only tool list)', () => {
    expect(isSafeForRescue('slack_search', { channel: 'C123', keyword: 'PR' }).safe).toBe(true);
  });

  it('exec で xangi-cmd slack_channels は safe (allowlist)', () => {
    expect(isSafeForRescue('exec', { command: 'xangi-cmd slack_channels --limit 20' }).safe).toBe(
      true
    );
  });

  it('exec で xangi-cmd slack_send は unsafe (副作用あり、allowlist 外)', () => {
    const check = isSafeForRescue('exec', {
      command: 'xangi-cmd slack_send --channel C123 --message hi',
    });
    expect(check.safe).toBe(false);
    expect(check.reason).toContain('allowlist');
  });

  it('exec で xangi-cmd schedule_remove は unsafe (副作用あり、allowlist 外)', () => {
    const check = isSafeForRescue('exec', { command: 'xangi-cmd schedule_remove --id foo' });
    expect(check.safe).toBe(false);
    expect(check.reason).toContain('allowlist');
  });

  it('exec で読み取り専用の xangi-cmd models は safe', () => {
    expect(isSafeForRescue('exec', { command: 'xangi-cmd models --backend codex' }).safe).toBe(
      true
    );
  });

  it('exec でモデルを変更する xangi-cmd models --use は unsafe', () => {
    const check = isSafeForRescue('exec', {
      command: 'xangi-cmd models --backend codex --use gpt-test',
    });
    expect(check.safe).toBe(false);
    expect(check.reason).toContain('changes');
  });

  it('exec で xangi-cmd discord_history にパイプ付き = unsafe (shell metachar)', () => {
    const check = isSafeForRescue('exec', {
      command: 'xangi-cmd discord_history --channel 123 | grep foo',
    });
    expect(check.safe).toBe(false);
    expect(check.reason).toContain('shell metacharacters');
  });

  it('exec で && 連結 = unsafe', () => {
    const check = isSafeForRescue('exec', {
      command: 'xangi-cmd discord_history --channel 123 && rm -rf /tmp',
    });
    expect(check.safe).toBe(false);
  });

  it('exec で redirect > = unsafe', () => {
    const check = isSafeForRescue('exec', {
      command: 'xangi-cmd discord_history --channel 123 > /tmp/log',
    });
    expect(check.safe).toBe(false);
  });

  it('exec で backtick = unsafe', () => {
    const check = isSafeForRescue('exec', { command: 'echo `whoami`' });
    expect(check.safe).toBe(false);
  });

  it('exec で $() = unsafe', () => {
    const check = isSafeForRescue('exec', { command: 'echo $(whoami)' });
    expect(check.safe).toBe(false);
  });

  it('exec で rm = unsafe (allowlist 外、xangi-cmd prefix 無し)', () => {
    const check = isSafeForRescue('exec', { command: 'rm /tmp/foo' });
    expect(check.safe).toBe(false);
    expect(check.reason).toContain('allowlist');
  });

  it('exec で empty command = unsafe', () => {
    const check = isSafeForRescue('exec', { command: '' });
    expect(check.safe).toBe(false);
    expect(check.reason).toContain('empty');
  });

  it('unknown tool は unsafe', () => {
    const check = isSafeForRescue('weird_tool', { foo: 'bar' });
    expect(check.safe).toBe(false);
    expect(check.reason).toContain('not in rescue allowlist');
  });
});

// ============================================================================
// buildStructuredFeedback
// ============================================================================

describe('buildStructuredFeedback', () => {
  it('SYSTEM ERROR RECORD デリミタを含む', () => {
    const msg = buildStructuredFeedback({
      kind: 'pseudo_format_drift',
      reason: 'test',
      hint: 'test hint',
      allowed_actions: ['act1', 'act2'],
    });
    expect(msg).toContain('[SYSTEM ERROR RECORD]');
    expect(msg).toContain('[END SYSTEM ERROR RECORD]');
  });

  it('JSON 部分に kind / reason / hint / allowed_actions が含まれる', () => {
    const msg = buildStructuredFeedback({
      kind: 'unsafe_tool_in_pseudo_format',
      attempted_tool: 'exec',
      attempted_args: { command: 'rm -rf /' },
      reason: 'dangerous',
      hint: 'do not',
      allowed_actions: ['stop'],
    });
    expect(msg).toContain('"kind"');
    expect(msg).toContain('"unsafe_tool_in_pseudo_format"');
    expect(msg).toContain('"attempted_tool"');
    expect(msg).toContain('"exec"');
    expect(msg).toContain('"reason"');
    expect(msg).toContain('"hint"');
    expect(msg).toContain('"allowed_actions"');
  });

  it('LLM が JSON をそのまま貼り付けるのを抑止する指示を含む', () => {
    const msg = buildStructuredFeedback({
      kind: 'already_executed',
      reason: 'cached',
      hint: 'use prior result',
      allowed_actions: ['respond'],
    });
    expect(msg.toLowerCase()).toContain('do not copy');
  });

  it('proper function_calling を促す instruction を含む', () => {
    const msg = buildStructuredFeedback({
      kind: 'pseudo_format_drift',
      reason: 'test',
      hint: 'test',
      allowed_actions: ['x'],
    });
    expect(msg).toContain('function_calling');
  });
});

// ============================================================================
// 統合シナリオ (decision tree 実証)
//
// runner.ts の executeStreamLoop 内 rescue 経路を full integration するには
// LLMClient のモック化が必要だが、ここでは「drift 検出 → parse → safety →
// 実行/拒否 → structured feedback 生成」の決定木が正しく繋がることを公開関数の
// 組み合わせとして実証する。実機の executeStreamLoop は同じ pieces を順に呼ぶ。
// ============================================================================

describe('drift rescue scenario (decision tree)', () => {
  it('実例: discord_history 擬似 call は parse + safe 判定で rescue 対象', () => {
    // 実観測された drift の例
    const drift =
      'call:exec{command:xangi-cmd discord_history --channel 1505945594835898460 --count 10}';

    // Step 1: drift 検出
    expect(containsPseudoToolCall(drift)).toBe(true);

    // Step 2: parse
    const parsed = parsePseudoToolCall(drift);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('exec');
    expect(parsed!.args.command).toBe(
      'xangi-cmd discord_history --channel 1505945594835898460 --count 10'
    );

    // Step 3: safety = safe (xangi-cmd discord_history は allowlist)
    const safety = isSafeForRescue(parsed!.name, parsed!.args);
    expect(safety.safe).toBe(true);

    // runner.ts はこの後 executeTool(parsed.name, parsed.args) で実行、結果を
    // [RESCUED TOOL RESULT] system message として session.messages に push する
  });

  it('unsafe シナリオ: rm 含む exec は parse 成功するが safety で reject → structured feedback', () => {
    const drift = 'call:exec{command:rm -rf /tmp/foo}';

    expect(containsPseudoToolCall(drift)).toBe(true);

    const parsed = parsePseudoToolCall(drift);
    expect(parsed).toEqual({ name: 'exec', args: { command: 'rm -rf /tmp/foo' } });

    // safety = unsafe (rm は xangi-cmd allowlist 外)
    const safety = isSafeForRescue(parsed!.name, parsed!.args);
    expect(safety.safe).toBe(false);
    expect(safety.reason).toContain('allowlist');

    // 構造化フィードバック生成
    const feedback = buildStructuredFeedback({
      kind: 'unsafe_tool_in_pseudo_format',
      attempted_tool: parsed!.name,
      attempted_args: parsed!.args,
      reason: safety.reason!,
      hint: 'Use proper function_calling structure for this tool, or choose a safer alternative',
      allowed_actions: [
        'Call the tool using proper function_calling structure',
        'Choose a different read-only tool',
        'Respond in plain text without tool use',
      ],
    });

    expect(feedback).toContain('[SYSTEM ERROR RECORD]');
    expect(feedback).toContain('"kind"');
    expect(feedback).toContain('"unsafe_tool_in_pseudo_format"');
    expect(feedback).toContain('"attempted_tool"');
    expect(feedback).toContain('"exec"');
    expect(feedback).toContain('"rm -rf /tmp/foo"');
    expect(feedback.toLowerCase()).toContain('do not copy');
  });

  it('shell metachar シナリオ: パイプ付き xangi-cmd は reject', () => {
    const drift = 'call:exec{command:xangi-cmd discord_history --channel 123 | grep keyword}';

    const parsed = parsePseudoToolCall(drift);
    expect(parsed).not.toBeNull();

    const safety = isSafeForRescue(parsed!.name, parsed!.args);
    expect(safety.safe).toBe(false);
    expect(safety.reason).toContain('shell metacharacters');
  });

  it('parse 失敗シナリオ: 不正な擬似形式は unparseable_pseudo_call feedback', () => {
    // STRICT_DRIFT_PATTERN にマッチするが parsePseudoToolCall は失敗するケース。
    // (実際の Gemma 4 drift で args が極端に malformed なケースを想定)
    //
    // ※ containsPseudoToolCall === true だが parsePseudoToolCall === null になる
    //   ケースは現実には稀。decision tree の安全網が機能することだけ確認する。

    // 不正な形式 (key が ASCII 識別子に該当しない、JSON 解析もできない) を渡す。
    // ここでは containsPseudoToolCall(true) かつ parsePseudoToolCall(null) を
    // 直接構築するのが難しいので、unparseable_pseudo_call の feedback 整形のみテスト。
    const feedback = buildStructuredFeedback({
      kind: 'unparseable_pseudo_call',
      reason: 'Pseudo tool_call text detected but could not be parsed',
      hint: 'Use proper function_calling structure for tool invocation',
      allowed_actions: [
        'Call a tool using proper function_calling structure',
        'Respond to the user in plain text',
      ],
    });

    expect(feedback).toContain('[SYSTEM ERROR RECORD]');
    expect(feedback).toContain('unparseable_pseudo_call');
  });

  it('read-only tool シナリオ: tool_search 擬似 call は直接 rescue', () => {
    const drift = 'call:tool_search{query:calendar}';

    const parsed = parsePseudoToolCall(drift);
    expect(parsed).toEqual({ name: 'tool_search', args: { query: 'calendar' } });

    const safety = isSafeForRescue(parsed!.name, parsed!.args);
    expect(safety.safe).toBe(true);
  });

  it('Harmony channel タグ内の擬似 call も同じ decision tree を通る', () => {
    const drift = '<|channel>thought\ncall:read{path:/tmp/foo.txt}<channel|>';

    expect(containsPseudoToolCall(drift)).toBe(true);

    const parsed = parsePseudoToolCall(drift);
    expect(parsed).toEqual({ name: 'read', args: { path: '/tmp/foo.txt' } });

    const safety = isSafeForRescue(parsed!.name, parsed!.args);
    expect(safety.safe).toBe(true);
  });

  it('redirect 含む exec は reject', () => {
    const drift = 'call:exec{command:xangi-cmd web_history > /tmp/output.txt}';

    const parsed = parsePseudoToolCall(drift);
    expect(parsed).not.toBeNull();

    const safety = isSafeForRescue(parsed!.name, parsed!.args);
    expect(safety.safe).toBe(false);
    // > は SHELL_METACHAR_PATTERN (`<>`) または REDIRECT_PATTERN にマッチする
    expect(safety.reason).toMatch(/shell metacharacters|redirect/);
  });

  it('already_executed シナリオの feedback フォーマット', () => {
    // session の冪等キャッシュ HIT 時 (runner.ts で発火) の feedback 整形を確認
    const feedback = buildStructuredFeedback({
      kind: 'already_executed',
      attempted_tool: 'exec',
      attempted_args: { command: 'xangi-cmd discord_history --channel 123 --count 5' },
      reason: 'This tool call was already executed earlier in this turn',
      hint: 'Do not re-execute. Read the prior tool result and respond to the user',
      allowed_actions: [
        'Respond to the user using the prior tool result',
        'Call a different tool if you need new information',
      ],
    });

    expect(feedback).toContain('[SYSTEM ERROR RECORD]');
    expect(feedback).toContain('already_executed');
    expect(feedback).toContain('xangi-cmd discord_history');
  });
});
