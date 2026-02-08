import type { AgentBackend, AgentConfig } from './config.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { CodexRunner } from './codex-cli.js';
import { RunnerManager } from './runner-manager.js';

export interface RunOptions {
  skipPermissions?: boolean;
  sessionId?: string;
  channelId?: string; // プロセス管理用
}

export interface RunResult {
  result: string;
  sessionId: string;
}

export interface StreamCallbacks {
  onText?: (text: string, fullText: string) => void;
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
}

/**
 * 設定に基づいてAgentRunnerを作成
 */
export function createAgentRunner(backend: AgentBackend, config: AgentConfig): AgentRunner {
  switch (backend) {
    case 'claude-code':
      // persistent モードなら RunnerManager を使用（複数チャンネル同時処理）
      if (config.persistent) {
        console.log('[agent-runner] Using RunnerManager (multi-channel high-speed mode)');
        return new RunnerManager(config, {
          maxProcesses: config.maxProcesses,
          idleTimeoutMs: config.idleTimeoutMs,
        });
      }
      return new ClaudeCodeRunner(config);
    case 'codex':
      return new CodexRunner(config);
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

/**
 * バックエンド名を表示用に変換
 */
export function getBackendDisplayName(backend: AgentBackend): string {
  switch (backend) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    default:
      return backend;
  }
}
