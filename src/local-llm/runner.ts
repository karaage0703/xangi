/**
 * ローカルLLMバックエンド — xangi本体に統合
 *
 * Ollama等のOpenAI互換APIを直接叩いてエージェントループを実行する。
 * 外部HTTPサーバー不要。
 */
import { EventEmitter } from 'events';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../agent-runner.js';
import { TimeoutController } from '../timeout-controller.js';
import type { LocalLlmMode } from '../backend-resolver.js';
import type { AgentConfig } from '../config.js';
import type { LLMMessage, LLMImageContent } from './types.js';
import { LLMClient } from './llm-client.js';
import { extractAttachmentPaths, encodeImageToBase64, getMimeType } from './image-utils.js';
import { loadWorkspaceContext } from './context.js';
import {
  getAllTools,
  toLLMTools,
  executeTool,
  registerDynamicTools,
  loadAlwaysLoadedToolNames,
  getActiveTools,
  getDeferredToolCatalog,
} from './tools.js';
import { loadSkills } from '../skills.js';
import { CHAT_SYSTEM_PROMPT_PERSISTENT, buildXangiCommands } from '../base-runner.js';
import type { ChatPlatform } from '../prompts/index.js';
import { TOOLS_USAGE_PROMPT } from '../prompts/index.js';
import { checkApprovalServer } from '../approval-server.js';
import {
  logPrompt,
  logResponse,
  logError,
  readSessionMessages,
  type TranscriptEntry,
} from '../transcript-logger.js';
import { loadTriggers, triggersToToolHandlers, type Trigger } from './triggers.js';
import { getAllXangiTools } from './xangi-tools.js';
import { prependRuntimeContext } from '../runtime-context.js';
import {
  containsPseudoToolCall,
  stripPseudoToolCalls,
  parsePseudoToolCall,
  isSafeForRescue,
  buildStructuredFeedback,
  StreamingDriftBuffer,
  FRIENDLY_FALLBACK_MESSAGE,
} from './pseudo-toolcall.js';

const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_OUTPUT_CHARS = 8000;

/** 1 token あたりの文字数概算（日本語混じり保守側） */
const CHARS_PER_TOKEN = 3;

/**
 * コンテキスト関連の設定（env から読み込み）
 * - LOCAL_LLM_CONTEXT_MAX_CHARS: 明示指定（最優先）
 * - 未指定時: LOCAL_LLM_NUM_CTX - SYSTEM_PROMPT_BUDGET - OUTPUT_BUDGET - SAFETY_MARGIN から逆算
 */
export interface ContextBudget {
  contextMaxChars: number;
  contextKeepLast: number;
  toolResultMaxChars: number;
  maxSessionMessages: number;
  /** 計算根拠（log/test 用） */
  source: 'explicit' | 'derived';
  numCtx?: number;
  systemPromptBudgetTokens?: number;
  outputBudgetTokens?: number;
  safetyMarginTokens?: number;
}

/** 環境変数から context budget 設定を読み込む */
export function loadContextBudget(env: NodeJS.ProcessEnv = process.env): ContextBudget {
  const contextKeepLast = env.LOCAL_LLM_CONTEXT_KEEP_LAST
    ? parseInt(env.LOCAL_LLM_CONTEXT_KEEP_LAST, 10)
    : 10;
  const toolResultMaxChars = env.LOCAL_LLM_TOOL_RESULT_MAX_CHARS
    ? parseInt(env.LOCAL_LLM_TOOL_RESULT_MAX_CHARS, 10)
    : 4000;
  const maxSessionMessages = env.LOCAL_LLM_MAX_SESSION_MESSAGES
    ? parseInt(env.LOCAL_LLM_MAX_SESSION_MESSAGES, 10)
    : 50;

  // 明示優先: LOCAL_LLM_CONTEXT_MAX_CHARS
  if (env.LOCAL_LLM_CONTEXT_MAX_CHARS) {
    const explicit = parseInt(env.LOCAL_LLM_CONTEXT_MAX_CHARS, 10);
    if (!Number.isNaN(explicit) && explicit > 0) {
      return {
        contextMaxChars: explicit,
        contextKeepLast,
        toolResultMaxChars,
        maxSessionMessages,
        source: 'explicit',
      };
    }
  }

  // 逆算: NUM_CTX から - SYSTEM_BUDGET - OUTPUT_BUDGET - SAFETY
  const numCtx = env.LOCAL_LLM_NUM_CTX ? parseInt(env.LOCAL_LLM_NUM_CTX, 10) : 32768;
  const systemPromptBudgetTokens = env.LOCAL_LLM_SYSTEM_PROMPT_BUDGET_TOKENS
    ? parseInt(env.LOCAL_LLM_SYSTEM_PROMPT_BUDGET_TOKENS, 10)
    : 8000;
  const outputBudgetTokens = env.LOCAL_LLM_OUTPUT_BUDGET_TOKENS
    ? parseInt(env.LOCAL_LLM_OUTPUT_BUDGET_TOKENS, 10)
    : 4096;
  const safetyMarginTokens = env.LOCAL_LLM_SAFETY_MARGIN_TOKENS
    ? parseInt(env.LOCAL_LLM_SAFETY_MARGIN_TOKENS, 10)
    : 1000;

  const historyTokens = numCtx - systemPromptBudgetTokens - outputBudgetTokens - safetyMarginTokens;
  const minChars = 8000; // 最低保証
  const derivedChars = historyTokens > 0 ? historyTokens * CHARS_PER_TOKEN : minChars;
  const contextMaxChars = Math.max(derivedChars, minChars);

  return {
    contextMaxChars,
    contextKeepLast,
    toolResultMaxChars,
    maxSessionMessages,
    source: 'derived',
    numCtx,
    systemPromptBudgetTokens,
    outputBudgetTokens,
    safetyMarginTokens,
  };
}

/**
 * 古い tool 結果メッセージを 1 行サマリに置換して context を圧縮する (Prune)。
 *
 * - 直近 `recentKeepCount` 件は保護 (本文を保持)
 * - それより古い tool 結果は `[<tool_name>] (M chars, pruned from old turn)` に置換
 * - 同一 file path の `read` 重複は最新のみ本文を残し、それ以外は `(deduped - see latest read of same path below)` に置換
 *
 * Hermes Agent / sst/opencode の context_compressor / overflow.ts を参考にした
 * 上流対策。LLM が tool 結果を呼び出すたびに増える context を、古い分から構造的に
 * 圧縮することで KV cache 効率と LLM の集中を改善する。head/tail 切り詰め
 * (`trimToolResult`) より粒度が粗いが、古い結果は本文不要という前提で削り込む。
 *
 * - 本文が極端に短い結果 (200 char 未満) は元から圧縮済 / コスト低なのでスキップ
 * - 既に「(... chars, pruned from old turn)」サマリ形式 (再呼出による idempotent) もスキップ
 */
export function compactOldToolResults(
  session: Session,
  recentKeepCount: number
): { compactedCount: number; bytesReclaimed: number } {
  const messages = session.messages;
  if (messages.length <= recentKeepCount) {
    return { compactedCount: 0, bytesReclaimed: 0 };
  }

  const oldIndexEnd = messages.length - recentKeepCount;

  // assistant の toolCalls から tool_call_id → name / args のマップを構築
  const callIdToName = new Map<string, string>();
  const callIdToArgs = new Map<string, unknown>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        callIdToName.set(tc.id, tc.name);
        callIdToArgs.set(tc.id, tc.arguments);
      }
    }
  }

  // 同一 file path の read 重複検出: 古い範囲内での「最新の index」を記録
  const latestReadIdxByPath = new Map<string, number>();
  for (let i = 0; i < oldIndexEnd; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || !msg.toolCallId) continue;
    const name = callIdToName.get(msg.toolCallId);
    if (name !== 'read') continue;
    const args = callIdToArgs.get(msg.toolCallId);
    if (!args || typeof args !== 'object') continue;
    const path = (args as Record<string, unknown>).path;
    if (typeof path !== 'string') continue;
    latestReadIdxByPath.set(path, i);
  }

  let compactedCount = 0;
  let bytesReclaimed = 0;
  const PRUNE_MIN_BYTES = 200; // これより短い結果はスキップ
  const ALREADY_PRUNED_MARKER = ', pruned from old turn)';

  for (let i = 0; i < oldIndexEnd; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;
    const originalSize = msg.content.length;
    if (originalSize < PRUNE_MIN_BYTES) continue;
    if (msg.content.endsWith(ALREADY_PRUNED_MARKER)) continue;

    const name = msg.toolCallId ? (callIdToName.get(msg.toolCallId) ?? 'tool') : 'tool';

    let summary: string;
    if (name === 'read' && msg.toolCallId) {
      const args = callIdToArgs.get(msg.toolCallId);
      const path =
        args && typeof args === 'object'
          ? ((args as Record<string, unknown>).path as unknown)
          : undefined;
      if (typeof path === 'string' && latestReadIdxByPath.get(path) !== i) {
        summary = `[read] path=${path} (${originalSize} chars, deduped - see latest read of same path below)`;
      } else {
        summary = `[read] (${originalSize} chars${ALREADY_PRUNED_MARKER}`;
      }
    } else {
      summary = `[${name}] (${originalSize} chars${ALREADY_PRUNED_MARKER}`;
    }
    msg.content = summary;
    compactedCount += 1;
    bytesReclaimed += originalSize - summary.length;
  }

  return { compactedCount, bytesReclaimed };
}

/** ツール結果を切り詰める（head/tail方式、karaagebot準拠） */
function trimToolResult(content: string, maxChars: number = MAX_TOOL_OUTPUT_CHARS): string {
  if (content.length <= maxChars) return content;
  const headChars = Math.floor(maxChars * 0.4);
  const tailChars = Math.floor(maxChars * 0.4);
  return (
    content.slice(0, headChars) +
    `\n\n... [${content.length - headChars - tailChars} chars truncated] ...\n\n` +
    content.slice(-tailChars)
  );
}

/** セッション（会話履歴） */
export interface Session {
  messages: LLMMessage[];
  updatedAt: number;
  /**
   * tool_search でアクティブ化された tool 名のセット。
   * 起動時 default は LOCAL_LLM_ALWAYS_LOADED_TOOLS から計算。
   * tool_search 実行で動的に拡張される（per-session）。
   */
  activeToolNames: Set<string>;
  /**
   * 直近の tool_call シグネチャ履歴 (name + args の正規化キー)。
   * 同一シグネチャが連続するとループ状態と判定し、tool 実行をスキップして
   * 「Repeated call: 別アプローチ取れ」を tool result に差し替える。
   */
  recentToolCallSigs: string[];
  /**
   * recentToolCallSigs に対応する正規化シグネチャ (normalizeSignature 適用後)。
   * args 微差を吸収して「同じ意図 / 別 wording」のループを Jaccard 類似度で
   * 検出するために使う。
   */
  recentNormSigs: string[];
  /**
   * 冪等な tool_call (wc -c / base64 / hash / URL encode 等) の結果キャッシュ。
   * 同一シグネチャが args 微差で再呼出されたら exec せずキャッシュ返却。
   * 冪等・低価値 tool は 2 回目以降キャッシュ再利用する戦略。
   */
  idempotentResultCache: Map<string, string>;
}

/** 同一 tool_call が何回連続したらループと判定するか */
const REPEATED_TOOL_CALL_THRESHOLD = 3;

/** 直近 tool_call シグネチャを何件保持するか */
const RECENT_TOOL_CALL_BUFFER = 8;

/** 冪等キャッシュの上限 (FIFO で古いものから捨てる) */
const IDEMPOTENT_CACHE_LIMIT = 32;

/** 正規化シグネチャの Jaccard 類似度の発火閾値 (0..1) */
const SIMILAR_SIGNATURE_THRESHOLD = 0.85;

/**
 * 直近の正規化シグネチャ群と類似度しきい値を超えるエントリが何件あったら
 * 類似ループと判定するか (今回を含めず、過去履歴中の件数)。
 * 値 2 = 過去 2 件以上類似 → 今回で 3 件目 → 発火 (完全一致 3 回と同等の厳しさ)。
 */
const SIMILAR_LOOP_MATCH_COUNT = 2;

/**
 * tool_call をシグネチャ文字列に正規化する (順序非依存)。
 * args が object なら key sort、それ以外は JSON.stringify。
 */
export function toolCallSignature(name: string, args: unknown): string {
  let normalizedArgs: string;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(args as Record<string, unknown>).sort()) {
      sorted[k] = (args as Record<string, unknown>)[k];
    }
    normalizedArgs = JSON.stringify(sorted);
  } else {
    normalizedArgs = JSON.stringify(args ?? null);
  }
  return `${name}::${normalizedArgs}`;
}

/**
 * 末尾の同一シグネチャ連続回数を返す。
 * 例: [a, b, b, b] → 3 (末尾 b が 3 回連続)
 */
export function countTrailingRepeats(sigs: string[], target: string): number {
  let count = 0;
  for (let i = sigs.length - 1; i >= 0; i--) {
    if (sigs[i] === target) count++;
    else break;
  }
  return count;
}

/**
 * セッションに tool_call シグネチャを記録 + 完全一致ループ判定。
 *
 * 後方互換のため boolean を返す wrapper。詳細な kind ('exact'/'similar') が
 * 必要な場合は recordToolCallAndDetectLoop を直接使う。
 *
 * @returns true = exact または similar のいずれかでループ検出
 */
export function recordToolCallAndCheckLoop(session: Session, sig: string): boolean {
  return recordToolCallAndDetectLoop(session, sig).kind !== 'none';
}

/** ループ検出時に LLM に返す tool result メッセージ */
export function repeatedToolCallErrorMessage(toolName: string, repeats: number): string {
  return `Tool '${toolName}' has been called ${repeats} times consecutively with identical arguments. This is a loop. Stop calling this tool with these args. Try one of:
1. Call this tool with different arguments
2. Call a different tool from the active tool list
3. Stop calling tools and respond to the user in plain text — even if you can't fully answer, explain what you tried and what's missing.`;
}

/**
 * 類似ループ検出時に LLM に返す tool result メッセージ。
 * 「args 微差を試しても結果は変わらない、別 intent / 別 tool / 終了 を選べ」。
 */
export function similarToolCallErrorMessage(toolName: string, count: number): string {
  return `Tool '${toolName}' has been called with similar (normalized) arguments ${count} times within the recent window. Small wording tweaks won't change the result. Stop calling this tool with near-duplicate args. Try one of:
1. Call this tool with a substantially different intent or arguments
2. Call a different tool from the active tool list
3. Stop calling tools and respond to the user in plain text — explain what you tried and what's missing.`;
}

/** ループ検出の種類: 'none' = 未検出 / 'exact' = 完全一致 / 'similar' = 類似一致 */
export type LoopKind = 'none' | 'exact' | 'similar';

/**
 * tool_call シグネチャを「意図の同一性」レベルに正規化する。
 * - lowercase
 * - 数字 (整数/小数) を 'N' に置換
 * - ASCII 句読点を空白に置換 → 連続空白を 1 個に圧縮
 * - 前後空白を trim
 *
 * これで「args 微差で同じ意図」を Jaccard 類似度で検出しやすい形に揃える。
 */
export function normalizeSignature(sig: string): string {
  return sig
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?/g, 'n')
    .replace(/[`~!@#$%^&*()_\-+=[\]{};':"\\|,.<>/?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 文字 trigram の Set を返す (短い文字列でも 1 個以上は出る、空文字列は空 Set) */
export function trigrams(s: string): Set<string> {
  const grams = new Set<string>();
  if (s.length === 0) return grams;
  const padded = ` ${s} `;
  for (let i = 0; i < padded.length - 2; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/**
 * 文字 trigram ベースの Jaccard 類似度 (0..1)。
 * 言語非依存、計算 O(N+M)、短い tool_call args なら数 μs。
 * - 同一文字列: 1
 * - 完全に重複なし: 0
 * - 両方空文字列: 1 (扱いを定義)
 */
export function jaccardSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * normSigs (過去の正規化シグネチャ群) のうち target との Jaccard 類似度が
 * threshold 以上のエントリ数を返す。
 */
export function countSimilarMatches(
  normSigs: string[],
  target: string,
  threshold: number = SIMILAR_SIGNATURE_THRESHOLD
): number {
  let count = 0;
  for (const ns of normSigs) {
    if (jaccardSimilarity(ns, target) >= threshold) count++;
  }
  return count;
}

/**
 * セッションに tool_call シグネチャを記録 + ループ判定。
 *
 * - exact: 完全一致が REPEATED_TOOL_CALL_THRESHOLD (=3) 回連続
 * - similar: 正規化シグネチャの Jaccard 類似度 >= SIMILAR_SIGNATURE_THRESHOLD
 *   なエントリが直近 RECENT_TOOL_CALL_BUFFER 件中 SIMILAR_LOOP_MATCH_COUNT 件以上
 *
 * exact が優先 (完全に同一 args の繰り返しは確実なループ判定)。
 */
export function recordToolCallAndDetectLoop(
  session: Session,
  sig: string
): { kind: LoopKind; repeats?: number } {
  // exact 用バッファ更新
  const priorRepeats = countTrailingRepeats(session.recentToolCallSigs, sig);
  session.recentToolCallSigs.push(sig);
  if (session.recentToolCallSigs.length > RECENT_TOOL_CALL_BUFFER) {
    session.recentToolCallSigs.shift();
  }

  if (priorRepeats + 1 >= REPEATED_TOOL_CALL_THRESHOLD) {
    return { kind: 'exact', repeats: priorRepeats + 1 };
  }

  // similar 用: 既存バッファ (push 前の履歴) と比較してから今回を push
  const normSig = normalizeSignature(sig);
  if (!session.recentNormSigs) session.recentNormSigs = [];
  const similarPriorCount = countSimilarMatches(
    session.recentNormSigs,
    normSig,
    SIMILAR_SIGNATURE_THRESHOLD
  );
  session.recentNormSigs.push(normSig);
  if (session.recentNormSigs.length > RECENT_TOOL_CALL_BUFFER) {
    session.recentNormSigs.shift();
  }

  if (similarPriorCount >= SIMILAR_LOOP_MATCH_COUNT) {
    // 過去 N 件と類似 (今回含めると N+1 件目)
    return { kind: 'similar', repeats: similarPriorCount + 1 };
  }

  return { kind: 'none' };
}

/**
 * 冪等な (副作用なし・args 同じなら結果同一) tool_call を検出する。
 * 主に exec / bash / shell 系の `command` / `script` / `code` 文字列を見て、
 * 計算・エンコード・ハッシュ系のコマンドを正規表現で判定。
 *
 * 副作用ありそうなパターン (リダイレクト / rm / curl / git 等) が含まれていれば
 * 冪等扱いしない。安全側に倒す。
 */
export function isIdempotentToolCall(name: string, args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  const argsRec = args as Record<string, unknown>;
  const commandStr = String(argsRec.command ?? argsRec.script ?? argsRec.code ?? '');
  if (!commandStr) return false;

  // 副作用ありそうなパターン: 冪等扱いしない (安全側)
  const SIDE_EFFECT_PATTERNS = [
    />>?\s*[^|&\s]/, // > or >> でファイル等に書き込み (パイプ/AND 連結は除く)
    /\b(rm|mv|cp|mkdir|touch|chmod|chown|ln)\b/,
    /\b(curl|wget|fetch|nc)\b/,
    /\b(git|npm|pip|uv|docker|systemctl|apt|yum|brew|pm2)\b/,
    /\b(kill|killall)\b/,
  ];
  for (const re of SIDE_EFFECT_PATTERNS) {
    if (re.test(commandStr)) return false;
  }

  // 冪等パターン: 計算・エンコード・ハッシュ系
  const IDEMPOTENT_PATTERNS = [
    /\bwc\b\s+-[clmw]/, // wc -c / -l / -m / -w (文字数測定)
    /\bbase64\b/, // base64 単発 (encode/decode)
    /\b(?:md5|sha1|sha224|sha256|sha384|sha512)sum\b/, // ハッシュ系
    /\bcksum\b/,
    /\burllib\.parse\.(?:quote|unquote)/, // Python URL encode/decode
    /\b(?:quote_plus|unquote_plus)\b/,
    /\bimport\s+hashlib\b/, // Python hashlib import
    /\bhashlib\.[a-z0-9]+\(/, // hashlib.md5(...) 等
    /\bprintf\b.*%[bs]/, // printf '%s' 整形 (限定的)
  ];
  for (const re of IDEMPOTENT_PATTERNS) {
    if (re.test(commandStr)) return true;
  }
  return false;
}

/** 冪等キャッシュから結果を取得 (HIT なら exec をスキップして即返却) */
export function getCachedIdempotentResult(session: Session, sig: string): string | undefined {
  return session.idempotentResultCache?.get(sig);
}

/**
 * 冪等 tool_call の結果をキャッシュに保存。
 * 上限 IDEMPOTENT_CACHE_LIMIT を超えたら最古エントリから削除 (FIFO)。
 */
export function cacheIdempotentResult(session: Session, sig: string, output: string): void {
  if (!session.idempotentResultCache) {
    session.idempotentResultCache = new Map();
  }
  if (session.idempotentResultCache.size >= IDEMPOTENT_CACHE_LIMIT) {
    const firstKey = session.idempotentResultCache.keys().next().value;
    if (firstKey !== undefined) session.idempotentResultCache.delete(firstKey);
  }
  session.idempotentResultCache.set(sig, output);
}

/** モード別の機能フラグ */
interface ModeFlags {
  tools: boolean;
  skills: boolean;
  xangiCommands: boolean;
  triggers: boolean;
}

/** モード別 defaults（agent/lite/chat） */
const MODE_DEFAULTS: Record<LocalLlmMode, ModeFlags> = {
  agent: { tools: true, skills: true, xangiCommands: true, triggers: false },
  chat: { tools: false, skills: false, xangiCommands: false, triggers: false },
  lite: { tools: true, skills: false, xangiCommands: true, triggers: true },
};

/** LLMエラーがセッション履歴に起因するかを判定 */
export function isSessionRelatedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('context length') ||
    msg.includes('too many tokens') ||
    msg.includes('max_tokens') ||
    msg.includes('context window') ||
    msg.includes('invalid message') ||
    msg.includes('malformed') ||
    msg.includes('400') ||
    msg.includes('422')
  );
}

/** ユーザー向けエラーメッセージを生成 */
/**
 * transcript-logger の jsonl からセッション履歴を LLMMessage[] に変換して復元する。
 *
 * プロセス再起動などで session.messages がメモリ上から失われたあと、xangi-borot が
 * Discord/Slack の同じチャンネル（= 同じ appSessionId）で再起動した直後の最初の
 * リクエストで「過去の会話履歴を覚えていない」と振る舞ってしまうのを防ぐ。
 *
 * 制約:
 * - role: 'user' | 'assistant' のみ採用（'error' は無視）
 * - assistant の content は logResponse で {result, sessionId} 形式に保存される → result を抽出
 * - tool 呼び出しの中間メッセージは jsonl に記録されないので復元できない
 * - 画像添付（images）も raw データが残っていないので復元しない
 */
export function loadMessagesFromTranscript(workdir: string, appSessionId: string): LLMMessage[] {
  let entries: TranscriptEntry[];
  try {
    entries = readSessionMessages(workdir, appSessionId);
  } catch (err) {
    console.warn(
      `[local-llm] Failed to read transcript for ${appSessionId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }

  const restored: LLMMessage[] = [];
  for (const e of entries) {
    if (e.role !== 'user' && e.role !== 'assistant') continue;
    let content = '';
    if (typeof e.content === 'string') {
      content = e.content;
    } else if (e.content && typeof e.content === 'object') {
      const rec = e.content as Record<string, unknown>;
      if (typeof rec.result === 'string') {
        content = rec.result;
      }
    }
    if (!content) continue;
    restored.push({ role: e.role, content });
  }
  return restored;
}

export function formatLlmError(err: unknown): string {
  if (!(err instanceof Error)) return 'LLMとの通信中に予期しないエラーが発生しました。';
  const msg = err.message;
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    return 'LLMサーバーに接続できませんでした。サーバーが起動しているか確認してください。';
  }
  if (msg.includes('timeout') || msg.includes('aborted')) {
    return 'LLMからの応答がタイムアウトしました。しばらくしてから再試行してください。';
  }
  if (msg.includes('401') || msg.includes('403')) {
    return 'LLMサーバーへの認証に失敗しました。APIキーを確認してください。';
  }
  if (msg.includes('429')) {
    return 'LLMサーバーのレートリミットに達しました。しばらくしてから再試行してください。';
  }
  if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
    return 'LLMサーバーで内部エラーが発生しました。しばらくしてから再試行してください。';
  }
  return `LLMエラー: ${msg}`;
}

export class LocalLlmRunner extends EventEmitter implements AgentRunner {
  private readonly llm: LLMClient;
  private readonly workdir: string;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionTtlMs = 60 * 60 * 1000; // 1時間
  private readonly activeAbortControllers = new Map<string, AbortController>();
  /** 個別機能フラグ */
  readonly enableTools: boolean;
  readonly enableSkills: boolean;
  readonly enableXangiCommands: boolean;
  readonly enableTriggers: boolean;
  /** トリガー定義 */
  private triggers: Trigger[];
  /** Context budget（env から動的計算） */
  readonly contextBudget: ContextBudget;
  /** 起動時に解決された LocalLlmMode（per-call override がなければこれを使う） */
  readonly startupMode: LocalLlmMode;
  /** 起動時 flags（per-call override がない時のフォールバック） */
  private readonly startupFlags!: ModeFlags;
  /** tool_search 機能の有効/無効 */
  readonly toolSearchEnabled: boolean;
  /** 起動時の常駐 tool 名（per-session active set 初期値） */
  private readonly defaultActiveToolNames: Set<string>;
  /** チャンネル別タイムアウト管理（UI の +5m / 残り表示 / 自動 abort 連動） */
  private readonly timeoutController: TimeoutController;
  /**
   * 単独運用プラットフォーム ('discord' / 'slack' / 'web' / 'line')。
   * undefined なら Discord + Slack 両方のコマンドを注入する従来挙動。
   * `buildXangiCommands(this.platform)` で system prompt を組み立てる際に使う。
   */
  private readonly platform?: ChatPlatform;

  constructor(config: AgentConfig & { platform?: ChatPlatform }) {
    super();
    this.platform = config.platform;
    const baseUrl = (process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    const model = config.model || process.env.LOCAL_LLM_MODEL || '';
    const apiKey = process.env.LOCAL_LLM_API_KEY || '';
    const thinking = process.env.LOCAL_LLM_THINKING === 'true';
    const maxTokens = process.env.LOCAL_LLM_MAX_TOKENS
      ? parseInt(process.env.LOCAL_LLM_MAX_TOKENS, 10)
      : 8192;
    const numCtx = process.env.LOCAL_LLM_NUM_CTX
      ? parseInt(process.env.LOCAL_LLM_NUM_CTX, 10)
      : undefined;
    const temperature =
      process.env.LOCAL_LLM_TEMPERATURE !== undefined
        ? parseFloat(process.env.LOCAL_LLM_TEMPERATURE)
        : undefined;

    // 個別フラグ（環境変数で制御、未設定時はLOCAL_LLM_MODEから推定）
    const modeEnv = (process.env.LOCAL_LLM_MODE || '').toLowerCase();
    const defaults = MODE_DEFAULTS[modeEnv as LocalLlmMode] || MODE_DEFAULTS.agent;
    this.startupMode =
      modeEnv === 'agent' || modeEnv === 'lite' || modeEnv === 'chat'
        ? (modeEnv as LocalLlmMode)
        : 'agent';

    this.enableTools =
      process.env.LOCAL_LLM_TOOLS !== undefined
        ? process.env.LOCAL_LLM_TOOLS !== 'false'
        : defaults.tools;
    this.enableSkills =
      process.env.LOCAL_LLM_SKILLS !== undefined
        ? process.env.LOCAL_LLM_SKILLS !== 'false'
        : defaults.skills;
    this.enableXangiCommands =
      process.env.LOCAL_LLM_XANGI_COMMANDS !== undefined
        ? process.env.LOCAL_LLM_XANGI_COMMANDS !== 'false'
        : defaults.xangiCommands;
    this.enableTriggers =
      process.env.LOCAL_LLM_TRIGGERS !== undefined
        ? process.env.LOCAL_LLM_TRIGGERS !== 'false'
        : defaults.triggers;

    this.llm = new LLMClient(baseUrl, model, apiKey, thinking, maxTokens, numCtx, temperature);
    this.workdir = config.workdir || process.cwd();

    // Context budget を env から計算（明示優先、未指定なら NUM_CTX から逆算）
    this.contextBudget = loadContextBudget(process.env);

    // tool_search 機能の制御
    this.toolSearchEnabled = process.env.LOCAL_LLM_TOOL_SEARCH_ENABLED !== 'false';
    if (this.toolSearchEnabled) {
      // 常駐 tool 名（env LOCAL_LLM_ALWAYS_LOADED_TOOLS、未指定なら builtin core + tool_search）
      this.defaultActiveToolNames = loadAlwaysLoadedToolNames(process.env);
    } else {
      // 無効時は全 tool を常駐扱い（従来挙動）
      this.defaultActiveToolNames = new Set(getAllTools().map((t) => t.name));
    }

    // トリガーを読み込み
    this.triggers = this.enableTriggers ? loadTriggers(this.workdir) : [];

    // ツールモードが有効ならトリガー＋xangiコマンドをツールとして登録
    if (this.enableTools) {
      const dynamicTools = [];

      if (this.triggers.length > 0) {
        const triggerTools = triggersToToolHandlers(this.triggers, this.workdir);
        dynamicTools.push(...triggerTools);
        console.log(
          `[local-llm] Triggers registered as tools: ${triggerTools.map((t) => t.name).join(', ')}`
        );
      }

      if (this.enableXangiCommands) {
        const xangiTools = getAllXangiTools();
        dynamicTools.push(...xangiTools);
        console.log(
          `[local-llm] Xangi commands registered as tools: ${xangiTools.map((t) => t.name).join(', ')}`
        );
      }

      if (dynamicTools.length > 0) {
        registerDynamicTools(dynamicTools);
      }
    }

    const features =
      [
        this.enableTools && 'tools',
        this.enableSkills && 'skills',
        this.enableXangiCommands && 'xangi-commands',
        this.enableTriggers && 'triggers',
      ]
        .filter(Boolean)
        .join(', ') || 'chat-only';
    console.log(
      `[local-llm] LLM: ${baseUrl} (model: ${model}, thinking: ${thinking}, features: ${features})`
    );

    // 起動時 flags を保存（per-call override が無い時に使う）
    this.startupFlags = {
      tools: this.enableTools,
      skills: this.enableSkills,
      xangiCommands: this.enableXangiCommands,
      triggers: this.enableTriggers,
    };

    // Context budget を起動時に表示
    const cb = this.contextBudget;
    if (cb.source === 'derived') {
      console.log(
        `[local-llm] Context budget (derived from NUM_CTX=${cb.numCtx}): contextMaxChars=${cb.contextMaxChars} ` +
          `(historyTokens=${cb.numCtx! - cb.systemPromptBudgetTokens! - cb.outputBudgetTokens! - cb.safetyMarginTokens!}, ` +
          `system=${cb.systemPromptBudgetTokens}, output=${cb.outputBudgetTokens}, safety=${cb.safetyMarginTokens}), ` +
          `keepLast=${cb.contextKeepLast}, toolResultMax=${cb.toolResultMaxChars}, maxMsgs=${cb.maxSessionMessages}`
      );
    } else {
      console.log(
        `[local-llm] Context budget (explicit): contextMaxChars=${cb.contextMaxChars}, ` +
          `keepLast=${cb.contextKeepLast}, toolResultMax=${cb.toolResultMaxChars}, maxMsgs=${cb.maxSessionMessages}`
      );
    }

    // タイムアウト管理: web-chat / xangi-pets が SSE 経由で残り時間表示・延長を行うため、
    // TimeoutController の timeout-* イベントを自身の emit に bubble する。
    this.timeoutController = new TimeoutController();
    for (const evt of ['timeout-started', 'timeout-extended', 'timeout-cleared'] as const) {
      this.timeoutController.on(evt, (payload) => this.emit(evt, payload));
    }
  }

  /**
   * per-call mode override を解決する
   * - callMode 指定時: MODE_DEFAULTS[mode] を直接適用（起動時の個別 env 上書きは無視）
   * - 未指定時: 起動時の flags を使う
   */
  private resolveCallModeFlags(callMode?: LocalLlmMode): ModeFlags {
    if (callMode && (callMode === 'agent' || callMode === 'lite' || callMode === 'chat')) {
      return { ...MODE_DEFAULTS[callMode] };
    }
    return { ...this.startupFlags };
  }

  async run(rawPrompt: string, options?: RunOptions): Promise<RunResult> {
    const sessionId = options?.sessionId || crypto.randomUUID();
    this.cleanupSessions();

    // appSessionId を先に解決して getOrCreateSession に渡す
    // （プロセス再起動時に jsonl から履歴復元するため）
    const channelId = options?.channelId || sessionId;
    const appSid = options?.appSessionId || channelId;

    const session = this.getOrCreateSession(sessionId, appSid);
    const callFlags = this.resolveCallModeFlags(options?.localLlmMode);
    const systemPrompt = this.buildSystemPrompt(callFlags);
    const tools = callFlags.tools ? getAllTools() : [];
    const llmTools = callFlags.tools ? toLLMTools(tools) : [];

    // runtime context (cwd/repo/container) を毎ターン user prompt 先頭に prepend
    const prompt = prependRuntimeContext(rawPrompt);

    // ユーザーメッセージ追加（画像添付があればマルチモーダルメッセージにする）
    const userMsg = this.buildUserMessage(prompt);
    session.messages.push(userMsg);

    // トランスクリプトにプロンプトを記録
    logPrompt(this.workdir, appSid, prompt);

    // AbortControllerをprocessManager相当として登録
    const abortController = new AbortController();
    this.activeAbortControllers.set(channelId, abortController);
    // タイムアウト発火時は activeAbortControllers から「現在の」controller を取って abort。
    // リトライで AbortController が差し替わっても適切に kick できる。
    this.timeoutController.start(channelId, () => {
      const ac = this.activeAbortControllers.get(channelId);
      if (ac) ac.abort();
    });

    try {
      const result = await this.executeAgentLoop(
        session,
        systemPrompt,
        llmTools,
        channelId,
        sessionId,
        abortController,
        options,
        appSid
      );

      this.trimSession(session);
      session.updatedAt = Date.now();

      // トランスクリプトにレスポンスを記録
      logResponse(this.workdir, appSid, { result, sessionId });

      this.timeoutController.clear(channelId, 'completed');
      return { result, sessionId };
    } catch (err) {
      // セッション履歴に起因するエラーの場合、セッションをクリアしてリトライ
      if (session.messages.length > 1 && isSessionRelatedError(err)) {
        console.warn(
          `[local-llm] Session-related error, retrying with fresh session: ${err instanceof Error ? err.message : String(err)}`
        );
        logError(
          this.workdir,
          appSid,
          `Session resume failed, retrying: ${err instanceof Error ? err.message : String(err)}`
        );

        // セッションをクリアして最後のユーザーメッセージだけ残す
        session.messages = [userMsg];

        try {
          const retryAbortController = new AbortController();
          this.activeAbortControllers.set(channelId, retryAbortController);

          const result = await this.executeAgentLoop(
            session,
            systemPrompt,
            llmTools,
            channelId,
            sessionId,
            retryAbortController,
            options,
            appSid
          );

          this.trimSession(session);
          session.updatedAt = Date.now();
          logResponse(this.workdir, appSid, { result, sessionId });

          this.timeoutController.clear(channelId, 'completed');
          return { result, sessionId };
        } catch (retryErr) {
          const errorMsg = formatLlmError(retryErr);
          logError(
            this.workdir,
            appSid,
            `LLM chat retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
          return { result: errorMsg, sessionId };
        }
      }

      const errorMsg = formatLlmError(err);
      logError(
        this.workdir,
        appSid,
        `LLM chat error: ${err instanceof Error ? err.message : String(err)}`
      );
      return { result: errorMsg, sessionId };
    } finally {
      this.activeAbortControllers.delete(channelId);
      // 'completed' 経路で既に clear 済みなら no-op。エラー or タイムアウトで未 clear なら 'error'。
      this.timeoutController.clear(channelId, 'error');
    }
  }

  async runStream(
    rawPrompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const sessionId = options?.sessionId || crypto.randomUUID();
    this.cleanupSessions();

    // appSessionId を先に解決して getOrCreateSession に渡す
    // （プロセス再起動時に jsonl から履歴復元するため）
    const channelId = options?.channelId || sessionId;
    const appSid = options?.appSessionId || channelId;

    const session = this.getOrCreateSession(sessionId, appSid);
    const callFlags = this.resolveCallModeFlags(options?.localLlmMode);
    const systemPrompt = this.buildSystemPrompt(callFlags);
    const tools = callFlags.tools ? getAllTools() : [];
    const llmTools = callFlags.tools ? toLLMTools(tools) : [];

    // runtime context (cwd/repo/container) を毎ターン user prompt 先頭に prepend
    const prompt = prependRuntimeContext(rawPrompt);

    const userMsg = this.buildUserMessage(prompt);
    session.messages.push(userMsg);

    // トランスクリプトにプロンプトを記録
    logPrompt(this.workdir, appSid, prompt);
    const abortController = new AbortController();
    this.activeAbortControllers.set(channelId, abortController);
    this.timeoutController.start(channelId, () => {
      const ac = this.activeAbortControllers.get(channelId);
      if (ac) ac.abort();
    });

    try {
      const fullText = await this.executeStreamLoop(
        session,
        systemPrompt,
        llmTools,
        channelId,
        sessionId,
        abortController,
        callbacks,
        options,
        appSid
      );

      session.messages.push({ role: 'assistant', content: fullText });

      this.trimSession(session);
      session.updatedAt = Date.now();

      // トランスクリプトにレスポンスを記録
      logResponse(this.workdir, appSid, { result: fullText, sessionId });

      this.timeoutController.clear(channelId, 'completed');
      const result: RunResult = { result: fullText, sessionId };
      callbacks.onComplete?.(result);
      return result;
    } catch (err) {
      // セッション履歴に起因するエラーの場合、セッションをクリアしてリトライ
      if (session.messages.length > 1 && isSessionRelatedError(err)) {
        console.warn(
          `[local-llm] Session-related stream error, retrying with fresh session: ${err instanceof Error ? err.message : String(err)}`
        );
        logError(
          this.workdir,
          appSid,
          `Session resume failed (stream), retrying: ${err instanceof Error ? err.message : String(err)}`
        );

        // セッションをクリアして最後のユーザーメッセージだけ残す
        session.messages = [userMsg];

        try {
          const retryAbortController = new AbortController();
          this.activeAbortControllers.set(channelId, retryAbortController);

          const fullText = await this.executeStreamLoop(
            session,
            systemPrompt,
            llmTools,
            channelId,
            sessionId,
            retryAbortController,
            callbacks,
            options,
            appSid
          );

          session.messages.push({ role: 'assistant', content: fullText });
          this.trimSession(session);
          session.updatedAt = Date.now();
          logResponse(this.workdir, appSid, { result: fullText, sessionId });

          this.timeoutController.clear(channelId, 'completed');
          const result: RunResult = { result: fullText, sessionId };
          callbacks.onComplete?.(result);
          return result;
        } catch (retryErr) {
          const error = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          const errorMsg = formatLlmError(retryErr);
          logError(this.workdir, appSid, `LLM stream retry failed: ${error.message}`);
          callbacks.onError?.(error);
          return { result: errorMsg, sessionId };
        }
      }

      const error = err instanceof Error ? err : new Error(String(err));
      const errorMsg = formatLlmError(err);
      logError(this.workdir, appSid, `LLM stream error: ${error.message}`);
      callbacks.onError?.(error);
      return { result: errorMsg, sessionId };
    } finally {
      this.activeAbortControllers.delete(channelId);
      this.timeoutController.clear(channelId, 'error');
    }
  }

  cancel(channelId?: string): boolean {
    if (channelId) {
      const controller = this.activeAbortControllers.get(channelId);
      if (controller) {
        controller.abort();
        this.activeAbortControllers.delete(channelId);
        this.timeoutController.clear(channelId, 'error');
        return true;
      }
    }
    // channelId不明の場合は全部止める
    if (this.activeAbortControllers.size > 0) {
      for (const [id, controller] of this.activeAbortControllers) {
        controller.abort();
        this.activeAbortControllers.delete(id);
        this.timeoutController.clear(id, 'error');
      }
      return true;
    }
    return false;
  }

  destroy(channelId: string): boolean {
    // channelId をセッションIDとして使ってるなら削除
    this.sessions.delete(channelId);
    return true;
  }

  /**
   * Local LLM はリクエストレベルのタイムアウトを持たないため (HTTP fetch のみ)、
   * 動的延長機能は未サポート。AgentRunner interface の整合のためスタブを提供する。
   * フロント側は reason='unsupported' を見て +5m ボタンを隠す or disabled にできる。
   */
  getTimeoutState(channelId?: string): import('../agent-runner.js').TimeoutState {
    if (!channelId) return { active: false };
    return this.timeoutController.getState(channelId);
  }

  extendTimeout(
    channelId: string | undefined,
    additionalMs?: number
  ): import('../agent-runner.js').ExtendTimeoutResult {
    if (!channelId) return { ok: false, reason: 'no_active_request' };
    return this.timeoutController.extend(channelId, additionalMs);
  }

  hasRunner(channelId: string): boolean {
    return this.activeAbortControllers.has(channelId);
  }

  /**
   * エージェントループ（run用）: ツール呼び出しを含む非ストリーミング実行
   * liteモードではツールなしの1回呼び出しで完了する。
   */
  private async executeAgentLoop(
    session: Session,
    systemPrompt: string,
    llmTools: ReturnType<typeof toLLMTools>,
    channelId: string,
    sessionId: string,
    abortController: AbortController,
    options?: RunOptions,
    appSessionId?: string
  ): Promise<string> {
    const logId = appSessionId || channelId;
    // ツール無効: 1回のLLM呼び出しで完了 + トリガー検出
    if (!this.enableTools) {
      let response;
      try {
        response = await this.llm.chat(session.messages, {
          systemPrompt,
          signal: abortController.signal,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[local-llm] LLM chat call failed: ${errorMsg}`);
        logError(this.workdir, logId, `LLM chat call failed: ${errorMsg}`);
        throw err;
      }
      session.messages.push({ role: 'assistant', content: response.content });

      return response.content;
    }

    let toolRounds = 0;
    let finalContent = '';
    const pendingMediaPaths: string[] = [];

    while (toolRounds <= MAX_TOOL_ROUNDS) {
      // 各 iteration の頭で active tools を再計算（tool_search で拡張された分を反映）
      const iterTools = this.toolSearchEnabled
        ? toLLMTools(getActiveTools(session.activeToolNames))
        : llmTools;

      let response;
      try {
        response = await this.llm.chat(session.messages, {
          systemPrompt,
          tools: iterTools.length > 0 ? iterTools : undefined,
          signal: abortController.signal,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[local-llm] LLM chat call failed: ${errorMsg}`);
        logError(this.workdir, logId, `LLM chat call failed: ${errorMsg}`);
        throw err;
      }

      if (
        response.finishReason === 'stop' ||
        !response.toolCalls ||
        response.toolCalls.length === 0
      ) {
        finalContent = response.content;
        session.messages.push({ role: 'assistant', content: response.content });
        break;
      }

      // ツール呼び出し
      session.messages.push({
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: response.toolCalls,
      });

      // tool_search からセッションの active set を拡張するための callback
      const toolContext = {
        workspace: this.workdir,
        channelId: options?.channelId,
        activateTools: (names: string[]) => {
          for (const n of names) session.activeToolNames.add(n);
          console.log(
            `[local-llm] tool_search activated: ${names.join(', ')} (active: ${session.activeToolNames.size})`
          );
        },
      };

      for (const toolCall of response.toolCalls) {
        console.log(
          `[local-llm] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`
        );

        // 危険コマンド承認チェック（承認サーバー経由、Claude Codeと同じ仕組み）
        const approvalResult = await checkApprovalServer(toolCall.name, toolCall.arguments);
        if (approvalResult === 'deny') {
          console.log(`[local-llm] Tool denied by approval server: ${toolCall.name}`);
          session.messages.push({
            role: 'tool',
            content: 'Tool execution denied by user.',
          });
          continue;
        }

        // 同一 / 類似 tool_call ループ検出 + 冪等キャッシュ短絡
        const sig = toolCallSignature(toolCall.name, toolCall.arguments);
        const loopResult = recordToolCallAndDetectLoop(session, sig);
        let result;
        if (loopResult.kind !== 'none') {
          const repeats = loopResult.repeats ?? REPEATED_TOOL_CALL_THRESHOLD;
          const errorMsg =
            loopResult.kind === 'exact'
              ? repeatedToolCallErrorMessage(toolCall.name, repeats)
              : similarToolCallErrorMessage(toolCall.name, repeats);
          console.warn(
            `[local-llm] Tool call loop detected (${loopResult.kind}, ${repeats}x): ${sig.slice(0, 200)}`
          );
          result = {
            success: false,
            output: '',
            error: errorMsg,
          };
        } else {
          // 冪等キャッシュ HIT 判定: 計算/エンコード/ハッシュ系で同 signature を
          // 2 回目以降叩こうとしたら 1 回目の結果を即返却 (exec スキップ)
          const cached = getCachedIdempotentResult(session, sig);
          if (cached !== undefined) {
            console.log(`[local-llm] Idempotent cache hit (skip exec): ${sig.slice(0, 200)}`);
            result = { success: true, output: cached };
          } else {
            result = await executeTool(toolCall.name, toolCall.arguments, toolContext);
            // 冪等パターンなら結果をキャッシュ (次回以降 HIT させる)
            if (result.success && isIdempotentToolCall(toolCall.name, toolCall.arguments)) {
              cacheIdempotentResult(session, sig, result.output);
            }
          }
        }
        const rawOutput = result.success
          ? result.output
          : `Error: ${result.error ?? 'Unknown error'}${result.output ? `\nOutput: ${result.output}` : ''}`;
        const toolResultContent = trimToolResult(rawOutput);

        if (!result.success) {
          logError(this.workdir, logId, `Tool ${toolCall.name} failed: ${rawOutput}`);
        }

        console.log(
          `[local-llm] Tool result: ${result.success ? 'OK' : 'FAIL'} (${toolResultContent.length} chars)`
        );
        session.messages.push({
          role: 'tool',
          content: toolResultContent,
          toolCallId: toolCall.id,
        });

        // ツール結果からMEDIA:パスを収集
        const mediaPattern = /^MEDIA:(.+)$/gm;
        for (const mediaMatch of rawOutput.matchAll(mediaPattern)) {
          const mediaPath = mediaMatch[1].trim();
          if (!pendingMediaPaths.includes(mediaPath)) {
            pendingMediaPaths.push(mediaPath);
            console.log(`[local-llm] Media path detected from tool result: ${mediaPath}`);
          }
        }
      }

      toolRounds++;
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        finalContent = 'Maximum tool rounds reached.';
        break;
      }
    }

    // ツール結果から検出したMEDIA:パスを最終応答に追記
    if (pendingMediaPaths.length > 0) {
      finalContent += '\n' + pendingMediaPaths.map((p) => `MEDIA:${p}`).join('\n');
    }

    return finalContent;
  }

  /**
   * ストリーミングループ: ツール呼び出し + 最終応答ストリーミング
   * liteモードではツールループをスキップし、直接ストリーミングで応答する。
   */
  private async executeStreamLoop(
    session: Session,
    systemPrompt: string,
    llmTools: ReturnType<typeof toLLMTools>,
    channelId: string,
    sessionId: string,
    abortController: AbortController,
    callbacks: StreamCallbacks,
    options?: RunOptions,
    appSessionId?: string
  ): Promise<string> {
    const logId = appSessionId || channelId;
    const pendingMediaPaths: string[] = [];

    // 最終応答 chatStream に渡すため、最後の iteration の active tools を保持
    let finalIterTools: ReturnType<typeof toLLMTools> = llmTools;

    // ツール有効時のみツールループ実行
    if (this.enableTools) {
      // ツールループ: non-streaming の chat() でツール呼び出しを処理
      let toolRounds = 0;
      while (toolRounds < MAX_TOOL_ROUNDS) {
        // 各 iteration の頭で active tools を再計算（tool_search で拡張された分を反映）
        const iterTools = this.toolSearchEnabled
          ? toLLMTools(getActiveTools(session.activeToolNames))
          : llmTools;
        finalIterTools = iterTools;

        let response;
        try {
          response = await this.llm.chat(session.messages, {
            systemPrompt,
            tools: iterTools.length > 0 ? iterTools : undefined,
            signal: abortController.signal,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`[local-llm] LLM chat call failed (stream tool loop): ${errorMsg}`);
          logError(this.workdir, logId, `LLM chat call failed (stream tool loop): ${errorMsg}`);
          throw err;
        }

        if (!response.toolCalls || response.toolCalls.length === 0) {
          break;
        }

        // ツール呼び出し処理
        session.messages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
        });

        const toolContext = {
          workspace: this.workdir,
          channelId: options?.channelId,
          activateTools: (names: string[]) => {
            for (const n of names) session.activeToolNames.add(n);
            console.log(
              `[local-llm] tool_search activated: ${names.join(', ')} (active: ${session.activeToolNames.size})`
            );
          },
        };
        for (const toolCall of response.toolCalls) {
          console.log(
            `[local-llm] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`
          );

          // Discordにツール実行中を通知
          callbacks.onToolUse?.(toolCall.name, toolCall.arguments as Record<string, unknown>);

          // 危険コマンド承認チェック（承認サーバー経由、Claude Codeと同じ仕組み）
          const approvalResult2 = await checkApprovalServer(toolCall.name, toolCall.arguments);
          if (approvalResult2 === 'deny') {
            console.log(`[local-llm] Tool denied by approval server: ${toolCall.name}`);
            session.messages.push({
              role: 'tool',
              content: 'Tool execution denied by user.',
            });
            continue;
          }

          // 同一 / 類似 tool_call ループ検出 + 冪等キャッシュ短絡
          const sig = toolCallSignature(toolCall.name, toolCall.arguments);
          const loopResult = recordToolCallAndDetectLoop(session, sig);
          let result;
          if (loopResult.kind !== 'none') {
            const repeats = loopResult.repeats ?? REPEATED_TOOL_CALL_THRESHOLD;
            const errorMsg =
              loopResult.kind === 'exact'
                ? repeatedToolCallErrorMessage(toolCall.name, repeats)
                : similarToolCallErrorMessage(toolCall.name, repeats);
            console.warn(
              `[local-llm] Tool call loop detected (${loopResult.kind}, ${repeats}x): ${sig.slice(0, 200)}`
            );
            result = {
              success: false,
              output: '',
              error: errorMsg,
            };
          } else {
            // 冪等キャッシュ HIT 判定: 計算/エンコード/ハッシュ系で同 signature を
            // 2 回目以降叩こうとしたら 1 回目の結果を即返却 (exec スキップ)
            const cached = getCachedIdempotentResult(session, sig);
            if (cached !== undefined) {
              console.log(`[local-llm] Idempotent cache hit (skip exec): ${sig.slice(0, 200)}`);
              result = { success: true, output: cached };
            } else {
              result = await executeTool(toolCall.name, toolCall.arguments, toolContext);
              // 冪等パターンなら結果をキャッシュ (次回以降 HIT させる)
              if (result.success && isIdempotentToolCall(toolCall.name, toolCall.arguments)) {
                cacheIdempotentResult(session, sig, result.output);
              }
            }
          }
          const rawToolOutput = result.success
            ? result.output
            : `Error: ${result.error ?? 'Unknown error'}${result.output ? `\nOutput: ${result.output}` : ''}`;
          const toolResultContent = trimToolResult(rawToolOutput);
          if (!result.success) {
            logError(this.workdir, logId, `Tool ${toolCall.name} failed: ${rawToolOutput}`);
          }
          console.log(
            `[local-llm] Tool result: ${result.success ? 'OK' : 'FAIL'} (${toolResultContent.length} chars)`
          );
          session.messages.push({
            role: 'tool',
            content: toolResultContent,
            toolCallId: toolCall.id,
          });

          // ツール結果からMEDIA:パスを収集
          const mediaPattern = /^MEDIA:(.+)$/gm;
          for (const mediaMatch of rawToolOutput.matchAll(mediaPattern)) {
            const mediaPath = mediaMatch[1].trim();
            if (!pendingMediaPaths.includes(mediaPath)) {
              pendingMediaPaths.push(mediaPath);
              console.log(`[local-llm] Media path detected from tool result: ${mediaPath}`);
            }
          }
        }
        toolRounds++;
      }
    }

    // 最終応答をストリーミングで取得
    // tools + tool_choice='none' を明示することで、LLM が「tool 呼び出し必要」と
    // 判断しても擬似 tool_call 文字列を text で吐く format drift を防ぐ。
    // (chatStream が tools を渡さないと一部の OpenAI 互換 LLM で
    //  `<|tool_call>call:...<tool_call|>` 形式が text として漏れることがある。
    //  Chat Completions のまま tool_choice='none' で text 応答を強制する)
    //
    // Step C: chatStream 完了後に drift 検出。検知時は LLM に feedback して 1 回だけ retry する。
    //   - assistant に raw drift を積む (LLM が「自分が何を吐いたか」を見られるように)
    //   - system に FEEDBACK_PROMPT を積む (どう修正すべきかを LLM に伝える)
    //   - chatStream を 1 回だけ再実行
    // Step D: retry でも drift しか出なければ親切な fallback メッセージに差し替える。
    const finalChatStreamOnce = async (): Promise<string> => {
      let acc = '';
      // hold buffer: streaming 中の擬似 tool_call drift を Discord に流す前に検出 + 抑止。
      // 最終 drift 検証 (Step C/D) は flush 後の fullText に対して既存通り走る。
      const driftBuffer = new StreamingDriftBuffer();
      let totalDroppedDuringStream = false;
      try {
        for await (const chunk of this.llm.chatStream(session.messages, {
          systemPrompt,
          tools: finalIterTools.length > 0 ? finalIterTools : undefined,
          toolChoice: 'none',
          signal: abortController.signal,
        })) {
          const { release, dropped } = driftBuffer.feed(chunk);
          if (dropped) totalDroppedDuringStream = true;
          if (release.length > 0) {
            acc += release;
            callbacks.onText?.(release, acc);
          }
          // release が空でも続行 (次の chunk で確定するまで hold)
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[local-llm] LLM chatStream failed: ${errorMsg}`);
        logError(this.workdir, logId, `LLM chatStream failed: ${errorMsg}`);
        throw err;
      }
      // stream 終了: 残った hold を最終応答にマージ (Step C/D の最終 drift 検証に通す)
      const { release: tail, droppedAny } = driftBuffer.flush();
      if (tail.length > 0) {
        acc += tail;
        callbacks.onText?.(tail, acc);
      }
      if (totalDroppedDuringStream || droppedAny) {
        console.warn(
          `[local-llm] StreamingDriftBuffer dropped partial drift patterns during streaming`
        );
      }
      return acc;
    };

    let fullText = await finalChatStreamOnce();

    // Step C: strict drift 検出 → parse-and-execute rescue または
    // structured feedback で bounded retry (Kmax=2)
    //
    // 旧実装は generic prompt で 1 回 retry → strip して短い fallback で出力意図を
    // 捨てていた。今回 parse 試行 → 安全なら rescue 実行、危険なら構造化エラーで
    // self-correct を促す方式に変更。
    const MAX_DRIFT_RESCUE_RETRIES = 2;
    const rescueToolContext = {
      workspace: this.workdir,
      channelId: options?.channelId,
      activateTools: (names: string[]) => {
        for (const n of names) session.activeToolNames.add(n);
      },
    };
    let driftRetryCount = 0;

    while (containsPseudoToolCall(fullText) && driftRetryCount < MAX_DRIFT_RESCUE_RETRIES) {
      console.warn(
        `[local-llm] Pseudo tool_call drift detected (retry ${driftRetryCount + 1}/${MAX_DRIFT_RESCUE_RETRIES}). Raw head: ${fullText.slice(0, 200)}`
      );

      const parsed = parsePseudoToolCall(fullText);

      // assistant に raw drift を必ず積む (LLM が「自分が何を吐いたか」を見られるように)
      session.messages.push({ role: 'assistant', content: fullText });

      if (parsed) {
        const safety = isSafeForRescue(parsed.name, parsed.args);
        const sig = toolCallSignature(parsed.name, parsed.args);

        // 同一 pseudo call が既に実行済み (冪等キャッシュ HIT) なら再実行禁止、
        // already_executed feedback で回答生成へ寄せる
        const cachedResult = getCachedIdempotentResult(session, sig);
        if (cachedResult !== undefined) {
          console.log(
            `[local-llm] Pseudo tool_call already_executed: ${parsed.name} (sig matches cache)`
          );
          session.messages.push({
            role: 'system',
            content: buildStructuredFeedback({
              kind: 'already_executed',
              attempted_tool: parsed.name,
              attempted_args: parsed.args,
              reason:
                'This tool call was already executed earlier in this turn. Result is in the conversation history.',
              hint: 'Do not re-execute. Read the prior tool result and respond to the user based on it.',
              allowed_actions: [
                'Respond to the user using the prior tool result',
                'Call a different tool if you need new information',
              ],
            }),
          });
        } else if (safety.safe) {
          // read-only safe → 救済実行
          // loop counter にも積む (rescue が無限ループに化けるのを防ぐ)
          const loopResult = recordToolCallAndDetectLoop(session, sig);
          if (loopResult.kind !== 'none') {
            console.warn(
              `[local-llm] Pseudo tool_call rescue blocked by loop detection (${loopResult.kind}): ${sig.slice(0, 200)}`
            );
            session.messages.push({
              role: 'system',
              content: buildStructuredFeedback({
                kind: 'already_executed',
                attempted_tool: parsed.name,
                attempted_args: parsed.args,
                reason: `Loop detected: this tool/args pattern has been called ${loopResult.repeats ?? REPEATED_TOOL_CALL_THRESHOLD} times.`,
                hint: 'Try a different approach. Either use different args, call a different tool, or respond to the user with what you have.',
                allowed_actions: [
                  'Call a different tool with proper function_calling structure',
                  'Respond in plain text describing what you tried',
                ],
              }),
            });
          } else {
            console.log(
              `[local-llm] Pseudo tool_call rescued: ${parsed.name}(${JSON.stringify(parsed.args).slice(0, 100)})`
            );
            const result = await executeTool(parsed.name, parsed.args, rescueToolContext);
            const rawOutput = result.success
              ? result.output
              : `Tool ${parsed.name} failed: ${result.error}`;
            if (result.success && isIdempotentToolCall(parsed.name, parsed.args)) {
              cacheIdempotentResult(session, sig, result.output);
            }
            // rescue 経路では tool_call_id が無いので、system message として tool 結果を注入
            // (function_calling 経路の tool role と混ぜると schema が崩れるため)
            session.messages.push({
              role: 'system',
              content: `[RESCUED TOOL RESULT]\nTool: ${parsed.name}\nArgs: ${JSON.stringify(parsed.args)}\nResult:\n${rawOutput}\n[END RESCUED TOOL RESULT]\n\nUse this result to compose your final reply to the user. Do NOT call the same tool again in pseudo format.`,
            });
          }
        } else {
          // 副作用ありの可能性 → 構造化 rejection
          console.warn(
            `[local-llm] Pseudo tool_call rejected (unsafe): ${parsed.name} — ${safety.reason}`
          );
          session.messages.push({
            role: 'system',
            content: buildStructuredFeedback({
              kind: 'unsafe_tool_in_pseudo_format',
              attempted_tool: parsed.name,
              attempted_args: parsed.args,
              reason: safety.reason ?? 'Tool is not in the safe rescue allowlist.',
              hint: 'If you really need this tool, use the proper function_calling structure (not pseudo text). For read-only context gathering, prefer tools like `discord_history`, `read`, `glob`, `grep`, or `tool_search`.',
              allowed_actions: [
                'Call the tool using proper function_calling structure',
                'Choose a different read-only tool to gather context',
                'Respond in plain text without tool use',
              ],
            }),
          });
        }
      } else {
        // parse 失敗 (anchored grammar にマッチしない形式 or args parse 失敗)
        console.warn(`[local-llm] Pseudo tool_call drift could not be parsed`);
        session.messages.push({
          role: 'system',
          content: buildStructuredFeedback({
            kind: 'unparseable_pseudo_call',
            reason:
              'Pseudo tool_call text detected but could not be parsed (malformed args or unknown format).',
            hint: 'Use proper function_calling structure for tool invocation. Do not write `call:fn{args}` as text.',
            allowed_actions: [
              'Call a tool using proper function_calling structure',
              'Respond to the user in plain text without tool_call-like syntax',
            ],
          }),
        });
      }

      driftRetryCount++;
      fullText = await finalChatStreamOnce();
    }

    // 最終 fallback: bounded retry 上限を超えても drift が残る → strip + 親切な fallback
    if (containsPseudoToolCall(fullText)) {
      const cleaned = stripPseudoToolCalls(fullText);
      console.warn(
        `[local-llm] Drift persisted after ${MAX_DRIFT_RESCUE_RETRIES} rescue retries. Raw head: ${fullText.slice(0, 200)}, cleaned: "${cleaned.slice(0, 100)}"`
      );
      fullText = cleaned || FRIENDLY_FALLBACK_MESSAGE;
    } else {
      // strict drift は無いが cosmetic leak (先頭/末尾の bare `thought\n` 等) は除去する。
      // stripPseudoToolCalls は strict + cosmetic 両方除去する idempotent な関数。
      fullText = stripPseudoToolCalls(fullText);
    }

    // ツール結果から検出したMEDIA:パスを最終応答に追記
    if (pendingMediaPaths.length > 0) {
      fullText += '\n' + pendingMediaPaths.map((p) => `MEDIA:${p}`).join('\n');
    }

    return fullText;
  }

  /**
   * プロンプトからユーザーメッセージを構築する。
   * 添付ファイルに画像が含まれている場合はマルチモーダルメッセージにする。
   */
  private buildUserMessage(prompt: string): LLMMessage {
    const { imagePaths, otherPaths, cleanPrompt } = extractAttachmentPaths(prompt);

    // 画像をbase64エンコード
    const images: LLMImageContent[] = [];
    for (const imagePath of imagePaths) {
      const base64 = encodeImageToBase64(imagePath);
      if (base64) {
        const mimeType = getMimeType(imagePath);
        images.push({ base64, mimeType });
        console.log(`[local-llm] Image attached: ${imagePath} (${mimeType})`);
      }
    }

    // 非画像ファイルがある場合はテキストに添付情報を残す
    let content = cleanPrompt;
    if (otherPaths.length > 0) {
      const fileList = otherPaths.map((p) => `  - ${p}`).join('\n');
      content = `${cleanPrompt}\n\n[添付ファイル]\n${fileList}`;
    }

    const msg: LLMMessage = { role: 'user', content };
    if (images.length > 0) {
      msg.images = images;
    }
    return msg;
  }

  /**
   * システムプロンプトを構築する
   * @param flags per-call mode override 由来の機能フラグ。未指定時は起動時 flags
   */
  private buildSystemPrompt(flags?: ModeFlags): string {
    const f = flags ?? this.startupFlags;
    const parts: string[] = [];

    // XANGI_COMMANDS注入 (platform 別に Markdown 抑制等のルールが切り替わる)
    if (f.xangiCommands) {
      const commands = buildXangiCommands(this.platform);
      parts.push(CHAT_SYSTEM_PROMPT_PERSISTENT + '\n\n## XANGI_COMMANDS.md\n\n' + commands);
    }

    // ワークスペースコンテキスト（CLAUDE.md, AGENTS.md, MEMORY.md）— 常に注入
    const context = loadWorkspaceContext(this.workdir);
    if (context) parts.push(context);

    // トリガー（毎回リロード）
    if (f.triggers) {
      this.triggers = loadTriggers(this.workdir);
      if (this.triggers.length > 0) {
        if (f.tools) {
          // ツールモード: トリガーをツールとして登録 + 使い方をプロンプトに追加
          const triggerTools = triggersToToolHandlers(this.triggers, this.workdir);
          registerDynamicTools(triggerTools);
          const toolLines = this.triggers.map((t) => `- **${t.name}**(args): ${t.description}`);
          parts.push(
            [
              '## カスタムツール',
              '',
              '以下のツールが利用可能です。該当するリクエストには**必ずツールを呼び出して**ください。自分の知識で回答しないでください。',
              '',
              ...toolLines,
            ].join('\n')
          );
        }
      }
    }

    // スキル一覧
    if (f.skills) {
      const skills = loadSkills(this.workdir);
      if (skills.length > 0) {
        const skillLines = skills
          .map((s) => `  - **${s.name}**: ${s.description}\n    SKILL.md: ${s.path}`)
          .join('\n');
        parts.push(
          `## Available Skills\n\nUse the read tool to load SKILL.md before using a skill. NEVER guess commands — always read SKILL.md first.\n${skillLines}`
        );
      }
    }

    // ツール有効時にツール使い方プロンプトを注入
    if (f.tools) {
      parts.push(TOOLS_USAGE_PROMPT);

      // tool_search 有効時: deferred tool catalog を表示
      // (アクティブセットに含まれない tool は名前+説明だけ見せる、schema は持たせない)
      if (this.toolSearchEnabled) {
        const deferred = getDeferredToolCatalog(this.defaultActiveToolNames);
        if (deferred.length > 0) {
          const lines = deferred.map((t) => `- ${t.name}: ${t.description.slice(0, 200)}`);
          parts.push(
            [
              '## Deferred Tools (load on demand via tool_search)',
              '',
              `以下の ${deferred.length} 個のツールは schema が未ロードです。使うには:`,
              '1. `tool_search({query: "..."})` を呼んで関連ツールをアクティブ化',
              '2. 次のターンで対象ツールが呼べるようになる',
              '',
              '常駐ツール（即時呼び出し可）: ' + Array.from(this.defaultActiveToolNames).join(', '),
              '',
              '### Catalog',
              ...lines,
            ].join('\n')
          );
        }
      }
    }

    return parts.join('\n\n');
  }

  private getOrCreateSession(sessionId: string, appSessionId?: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        messages: [],
        updatedAt: Date.now(),
        // 起動時の常駐 tool 名で初期化（per-session 拡張可）
        activeToolNames: new Set(this.defaultActiveToolNames),
        recentToolCallSigs: [],
        recentNormSigs: [],
        idempotentResultCache: new Map(),
      };
      this.sessions.set(sessionId, session);

      // jsonl から user/assistant の履歴を復元（プロセス再起動後の文脈喪失対策）
      // tool_call の中間状態は記録対象外なので復元できない（割り切り）
      if (appSessionId) {
        const restored = loadMessagesFromTranscript(this.workdir, appSessionId);
        if (restored.length > 0) {
          session.messages = restored;
          this.trimSession(session);
          console.log(
            `[local-llm] Restored ${session.messages.length} message(s) from transcript ${appSessionId}`
          );
        }
      }
    }
    return session;
  }

  /**
   * コンテキスト刈り込み（karaagebot準拠）
   * 0. 古い tool 結果を 1 行サマリに圧縮 (Prune、直近 contextKeepLast 件は保護)
   * 1. ツール結果を contextBudget.toolResultMaxChars に切り詰め (head/tail 方式)
   * 2. 直近 contextBudget.contextKeepLast 件を保護
   * 3. 合計文字数が contextBudget.contextMaxChars を超えたら古いメッセージから削除
   * 4. メッセージ数が contextBudget.maxSessionMessages を超えたら古いものを削除
   */
  private trimSession(session: Session): void {
    const { contextMaxChars, contextKeepLast, toolResultMaxChars, maxSessionMessages } =
      this.contextBudget;

    // (0) 古い tool 結果を 1 行サマリに圧縮 (Prune)
    // 直近 contextKeepLast 件は保護、それより古い tool 結果は本文を削除して
    // 「[<tool>] (M chars, pruned from old turn)」形式に置換。同一 file の read
    // 重複は最新のみ残す。
    const pruned = compactOldToolResults(session, contextKeepLast);
    if (pruned.compactedCount > 0) {
      console.log(
        `[local-llm] Pruned ${pruned.compactedCount} old tool result(s), reclaimed ${pruned.bytesReclaimed} bytes`
      );
    }

    // (1) ツール結果を head/tail 切り詰め（直近 contextKeepLast 件はここで切り詰められる、古いものは (0) で既に短い）
    for (const msg of session.messages) {
      if (msg.role === 'tool' && msg.content.length > toolResultMaxChars) {
        const head = Math.floor(toolResultMaxChars * 0.4);
        const tail = Math.floor(toolResultMaxChars * 0.4);
        msg.content =
          msg.content.slice(0, head) +
          `\n\n... [${msg.content.length - head - tail} chars trimmed for context] ...\n\n` +
          msg.content.slice(-tail);
      }
    }

    // メッセージ数制限
    if (session.messages.length > maxSessionMessages) {
      session.messages = session.messages.slice(-maxSessionMessages);
    }

    // 合計文字数制限（直近 contextKeepLast 件を保護）
    let totalChars = session.messages.reduce((sum, m) => sum + m.content.length, 0);
    while (totalChars > contextMaxChars && session.messages.length > contextKeepLast) {
      const removed = session.messages.shift();
      if (removed) totalChars -= removed.content.length;
    }
  }

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.updatedAt > this.sessionTtlMs) {
        this.sessions.delete(id);
      }
    }
  }
}
