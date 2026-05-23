import type { AgentBackend, AgentConfig, EffortLevel } from './config.js';
import type { LocalLlmMode } from './backend-resolver.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { CodexRunner } from './codex-cli.js';
import { GeminiRunner } from './gemini-cli.js';
import { LocalLlmRunner } from './local-llm/runner.js';
import { RunnerManager } from './runner-manager.js';
export { prependRuntimeContext, buildRuntimeContextBlock } from './runtime-context.js';

export interface RunOptions {
  skipPermissions?: boolean;
  sessionId?: string;
  channelId?: string; // プロセス管理用
  appSessionId?: string; // xangi側セッションID（ログ用）
  effort?: EffortLevel; // Claude Code の --effort オプション
  /** Local LLM の動作モード override（per-channel override 由来）。Local LLM 以外では無視される */
  localLlmMode?: LocalLlmMode;
}

export interface RunResult {
  result: string;
  sessionId: string;
}

/** 現在処理中リクエストのタイムアウト状態 */
export interface TimeoutState {
  /** 現在進行中のリクエストがあるか */
  active: boolean;
  /** タイムアウト発火予定 (epoch ms)。active=true のときのみ意味あり */
  timeoutAt?: number;
  /** これ以上は延長できない上限 (epoch ms、リクエスト開始時刻 + MAX_TIMEOUT_MS) */
  maxTimeoutAt?: number;
  /** timeoutAt - Date.now() (UI 表示の参考用) */
  remainingMs?: number;
  /** 現在のタイムアウト幅 (初期 = DEFAULT_TIMEOUT_MS、延長で増える) */
  timeoutMs?: number;
}

export interface ExtendTimeoutResult {
  ok: boolean;
  /** ok=true 時: 新しい timeoutAt */
  timeoutAt?: number;
  /** ok=true 時: 新しい remainingMs */
  remainingMs?: number;
  /** ok=true 時: 新しい timeoutMs (積算) */
  timeoutMs?: number;
  /** ok=true / ok=false (max_timeout_exceeded) どちらでも返る absolute 上限 (epoch ms) */
  maxTimeoutAt?: number;
  /** ok=false 時: 失敗理由 */
  reason?: 'no_active_request' | 'max_timeout_exceeded' | 'unsupported';
}

export interface StreamCallbacks {
  onText?: (text: string, fullText: string) => void;
  onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void;
  onComplete?: (result: RunResult) => void;
  onError?: (error: Error) => void;
}

/**
 * AIエージェントランナーの統一インターフェース
 */
export interface AgentRunner {
  run(prompt: string, options?: RunOptions): Promise<RunResult>;
  runStream(prompt: string, callbacks: StreamCallbacks, options?: RunOptions): Promise<RunResult>;
  /** 現在処理中のリクエストをキャンセル */
  cancel?(channelId?: string): boolean;
  /** 指定チャンネルのランナーを完全に破棄（/new用） */
  destroy?(channelId: string): boolean;
  /** 指定チャンネルのランナーがプール上に存在するか */
  hasRunner?(channelId: string): boolean;
  /**
   * 指定チャンネルの現在のタイムアウト状態を取得。
   * Web UI のサイドバーに「残り時間」を表示するために使う。
   */
  getTimeoutState?(channelId: string): TimeoutState;
  /**
   * 指定チャンネルの現在のリクエストのタイムアウトを延長する。
   * - `additionalMs` 省略時は現在の残り時間を加算 (= 残り時間を 2 倍にする)
   * - 進行中リクエストが無いとき: { ok: false, reason: 'no_active_request' }
   * - 上限超過: { ok: false, reason: 'max_timeout_exceeded', maxTimeoutAt }
   * - サポート外 (TIMEOUT_EXTEND_ENABLED=false など): { ok: false, reason: 'unsupported' }
   * - 成功: { ok: true, timeoutAt, remainingMs, timeoutMs }
   */
  extendTimeout?(channelId: string, additionalMs?: number): ExtendTimeoutResult;
}

/**
 * 設定に基づいてAgentRunnerを作成
 */
export function createAgentRunner(
  backend: AgentBackend,
  config: AgentConfig,
  options?: { platform?: import('./prompts/index.js').ChatPlatform }
): AgentRunner {
  switch (backend) {
    case 'claude-code':
      // persistent モードなら RunnerManager を使用（複数チャンネル同時処理）
      if (config.persistent) {
        console.log('[agent-runner] Using RunnerManager (multi-channel high-speed mode)');
        return new RunnerManager(config, {
          maxProcesses: config.maxProcesses,
          idleTimeoutMs: config.idleTimeoutMs,
          platform: options?.platform,
        });
      }
      return new ClaudeCodeRunner({ ...config, platform: options?.platform });
    case 'codex':
      return new CodexRunner(config);
    case 'gemini':
      return new GeminiRunner(config);
    case 'local-llm':
      return new LocalLlmRunner({ ...config, platform: options?.platform });
    default:
      throw new Error(`Unknown agent backend: ${backend}`);
  }
}

/**
 * ストリーミング中に累積したテキストと、最終 result テキストをマージする。
 *
 * Claude Code CLI はツール呼び出しの合間にテキストを出力するが、
 * 最終的な result フィールドには最後のテキストブロックしか含まれない。
 * この関数は累積テキスト（streamed）を基本とし、result にしかないテキストがあれば追加する。
 */
export function mergeTexts(streamed: string, result: string): string {
  if (!result) return streamed;
  if (!streamed) return result;

  // result が streamed の末尾に含まれていれば重複 → streamed をそのまま返す
  if (streamed.endsWith(result)) return streamed;

  // streamed が result に完全に含まれているなら result を優先
  if (result.endsWith(streamed)) return result;

  // どちらにも含まれない → 区切って結合
  return `${streamed}\n${result}`;
}

/** 不正なサロゲートペア（片方だけの孤立サロゲート）を除去する */
export function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ''
  );
}

/**
 * バックエンド名を表示用に変換
 */
export function getBackendDisplayName(backend: AgentBackend): string {
  switch (backend) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'local-llm':
      return 'Local LLM';
    default:
      return backend;
  }
}
