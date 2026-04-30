/**
 * Claude Code CLI (`claude -p`) を LLM バックエンドとして使うクライアント。
 *
 * 既存 LLMClient と同シグネチャで chat / chatStream を提供する。
 * 内部では child_process.spawn で `claude -p --output-format json` を起動し、
 * stdout の JSON から `result` と `session_id` を取得する。
 *
 * channel 別 session 継続は ClaudeSessionStore + `--resume <id>` で実現。
 *
 * モード:
 *   - default (Phase 1): allowedTools 未指定 → built-in tools 不可、副作用は ACTION マーカー
 *   - claude_dev (Phase 2): allowedTools 指定 → Read/Write/Bash 等を claude 側に許可
 *
 * Phase 1 の制約:
 *   - LLMTool[] (xangi の dynamic tools) は無視する (warn のみ)。
 *   - chatStream は一括取得 → 1 chunk yield (生成器互換のため)。本物の stream は将来。
 */
import { spawn } from 'child_process';
import type { LLMMessage, LLMChatOptions, LLMChatResponse } from './types.js';
import { ClaudeSessionStore } from './claude-session-store.js';

interface ClaudeCliOptions {
  /** claude -p の cwd。izuna-workspace を指すと CLAUDE.md auto-load が効く */
  cwd: string;
  /** subprocess timeout (ms) */
  timeoutMs?: number;
  /** session 永続化ストア */
  sessionStore?: ClaudeSessionStore;
  /** stderr / debug 行のロガー */
  logger?: (line: string) => void;
  /** claude バイナリのパス。空なら PATH 検索 */
  binPath?: string;
  /** --dangerously-skip-permissions を付けるか (default: true) */
  skipPermissions?: boolean;
  /** モデル指定 (例: claude-sonnet-4-6)。空なら claude 側 default */
  model?: string;
  /**
   * 許可する built-in tools のリスト (例: ["Read","Write","Edit","Bash","Glob","Grep"])。
   * 未指定なら `--allowed-tools` を付けず、claude 側の default 挙動に任せる。
   * Phase 2 (`LLM_BACKEND=claude_dev`) で self-mod を解禁する用途。
   */
  allowedTools?: string[];
  /** Permission mode for Claude Code (e.g. auto, acceptEdits, default). */
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan' | 'auto';
  /** Additional directories passed to --add-dir. */
  addDirs?: string[];
}

interface ClaudeJsonOutput {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  [k: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

function lastUserContent(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.length > 0) {
      return m.content;
    }
  }
  // フォールバック: 最後のメッセージの content
  const last = messages[messages.length - 1];
  return typeof last?.content === 'string' ? last.content : '';
}

function looksLikeSessionMissing(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes('session not found') ||
    s.includes('no such session') ||
    s.includes('invalid session') ||
    s.includes('session expired')
  );
}

export class ClaudeCliClient {
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly sessionStore: ClaudeSessionStore;
  private readonly logger: (line: string) => void;
  private readonly binPath: string;
  private readonly skipPermissions: boolean;
  private readonly model?: string;
  private readonly allowedTools?: string[];
  private readonly permissionMode?: string;
  private readonly addDirs: string[];
  private readonly activeChildren = new Set<ReturnType<typeof spawn>>();

  constructor(opts: ClaudeCliOptions) {
    this.cwd = opts.cwd;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sessionStore = opts.sessionStore ?? new ClaudeSessionStore();
    this.logger = opts.logger ?? ((l) => console.log('[claude-cli]', l));
    this.binPath = opts.binPath || process.env.CLAUDE_BIN || 'claude';
    this.skipPermissions = opts.skipPermissions ?? true;
    this.model = opts.model || process.env.CLAUDE_MODEL || undefined;
    this.allowedTools =
      opts.allowedTools && opts.allowedTools.length > 0 ? opts.allowedTools : undefined;
    this.permissionMode = opts.permissionMode;
    this.addDirs = opts.addDirs?.filter(Boolean) ?? [];

    // プロセス終了時に活動中の subprocess を巻き込んで kill
    const killAll = () => {
      for (const child of this.activeChildren) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    };
    process.once('exit', killAll);
    process.once('SIGINT', killAll);
    process.once('SIGTERM', killAll);
  }

  private buildArgs(prompt: string, sessionId: string | null, systemPrompt?: string): string[] {
    const args: string[] = ['-p', '--output-format', 'json'];
    if (this.skipPermissions) args.push('--dangerously-skip-permissions');
    if (this.permissionMode) args.push('--permission-mode', this.permissionMode);
    if (this.addDirs.length > 0) args.push('--add-dir', ...this.addDirs);
    if (this.model) args.push('--model', this.model);
    if (this.allowedTools && this.allowedTools.length > 0) {
      args.push('--allowed-tools', this.allowedTools.join(','));
    }
    if (sessionId) args.push('--resume', sessionId);
    if (systemPrompt && systemPrompt.length > 0) {
      args.push('--append-system-prompt', systemPrompt);
    }
    args.push(prompt);
    return args;
  }

  private runOnce(
    prompt: string,
    sessionId: string | null,
    options?: LLMChatOptions
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const args = this.buildArgs(prompt, sessionId, options?.systemPrompt);
    return new Promise((resolve, reject) => {
      const child = spawn(this.binPath, args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.activeChildren.add(child);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const onAbort = () => {
        if (settled) return;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 5000).unref();
      };

      if (options?.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }

      const timeout = setTimeout(() => {
        if (settled) return;
        this.logger(`timeout (${this.timeoutMs}ms) — killing child`);
        onAbort();
      }, this.timeoutMs);
      timeout.unref();

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderr += text;
        for (const line of text.split('\n')) {
          if (line.trim()) this.logger(`stderr: ${line}`);
        }
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.activeChildren.delete(child);
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.activeChildren.delete(child);
        resolve({ stdout, stderr, code });
      });
    });
  }

  private parseOutput(stdout: string): ClaudeJsonOutput {
    const trimmed = stdout.trim();
    if (!trimmed) throw new Error('claude -p produced empty stdout');
    // --output-format json は単一 JSON オブジェクトを返す。
    // 念のため最終 `{...}` を抽出する fallback を持つ。
    try {
      return JSON.parse(trimmed) as ClaudeJsonOutput;
    } catch {
      const lastBrace = trimmed.lastIndexOf('}');
      const firstBrace = trimmed.indexOf('{');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const slice = trimmed.slice(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(slice) as ClaudeJsonOutput;
        } catch {
          /* fall through */
        }
      }
      throw new Error(`claude -p stdout is not valid JSON: ${trimmed.slice(0, 200)}`);
    }
  }

  async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMChatResponse> {
    if (options?.tools && options.tools.length > 0) {
      this.logger(`tools=${options.tools.length} ignored in Phase 1`);
    }

    const channelId = options?.channelId;
    const prompt = lastUserContent(messages);
    if (!prompt) {
      throw new Error('No user message to send to claude -p');
    }

    let sessionId = channelId ? await this.sessionStore.get(channelId) : null;

    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < 2) {
      attempt++;
      try {
        const { stdout, stderr, code } = await this.runOnce(prompt, sessionId, options);
        if (code !== 0) {
          // session 不正の典型エラーなら resume を捨てて 1 回だけ素 session で再試行
          if (sessionId && looksLikeSessionMissing(stderr) && attempt === 1) {
            this.logger(`session ${sessionId} missing/expired — clearing & retrying fresh`);
            if (channelId) await this.sessionStore.clear(channelId);
            sessionId = null;
            continue;
          }
          throw new Error(`claude -p exited ${code}: ${stderr.slice(-500)}`);
        }
        const out = this.parseOutput(stdout);
        if (out.is_error) {
          if (
            sessionId &&
            attempt === 1 &&
            looksLikeSessionMissing(stderr + ' ' + (out.result || ''))
          ) {
            if (channelId) await this.sessionStore.clear(channelId);
            sessionId = null;
            continue;
          }
          throw new Error(`claude -p reported is_error: ${out.result || stderr.slice(-300)}`);
        }
        const content = typeof out.result === 'string' ? out.result : '';
        if (channelId && typeof out.session_id === 'string' && out.session_id.length > 0) {
          await this.sessionStore.set(channelId, out.session_id);
        }
        return {
          content,
          finishReason: 'stop',
        };
      } catch (err) {
        lastErr = err;
        // session 関連でない error は即 break
        if (!sessionId || attempt >= 2) break;
        sessionId = null; // 1 度だけ素 session で retry
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async *chatStream(messages: LLMMessage[], options?: LLMChatOptions): AsyncGenerator<string> {
    // Phase 1: 一括取得して 1 chunk として yield する。
    // streaming UX が必要になったら --output-format stream-json に対応する。
    const result = await this.chat(messages, options);
    if (result.content) yield result.content;
  }
}
