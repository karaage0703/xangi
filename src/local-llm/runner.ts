/**
 * ローカルLLMバックエンド — xangi本体に統合
 *
 * Ollama等のOpenAI互換APIを直接叩いてエージェントループを実行する。
 * 外部HTTPサーバー不要。
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../agent-runner.js';
import type { AgentConfig } from '../config.js';
import type { LLMMessage, LLMImageContent } from './types.js';
import { LLMClient, type ILLMClient } from './llm-client.js';
import { ClaudeCliClient } from './claude-client.js';
import { ClaudeSessionStore } from './claude-session-store.js';
import { extractAttachmentPaths, encodeImageToBase64, getMimeType } from './image-utils.js';
import { loadWorkspaceContext } from './context.js';
import { getIzunaContext, getRecentConversation } from './context-injector.js';
import { getAllTools, toLLMTools, executeTool, registerDynamicTools } from './tools.js';
import { loadSkills } from '../skills.js';
import { CHAT_SYSTEM_PROMPT_PERSISTENT, XANGI_COMMANDS } from '../base-runner.js';
import { TOOLS_USAGE_PROMPT } from '../prompts/index.js';
import { checkApprovalServer } from '../approval-server.js';
import { logPrompt, logResponse, logError } from '../transcript-logger.js';
import { loadTriggers, triggersToToolHandlers, type Trigger } from './triggers.js';
import { getAllXangiTools } from './xangi-tools.js';

const MAX_TOOL_ROUNDS = 10;
const MAX_SESSION_MESSAGES = 50;
const MAX_TOOL_OUTPUT_CHARS = 8000;

// コンテキスト刈り込み設定（karaagebot準拠）
const CONTEXT_MAX_CHARS = 120000; // 約48000トークン相当（1トークン≈2.5文字）
const CONTEXT_KEEP_LAST = 10; // 直近10件は保護
const TOOL_RESULT_MAX_CHARS_IN_CONTEXT = 4000; // コンテキスト内のツール結果上限
const DEFAULT_DEV_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git log:*)',
  'Bash(npm run build)',
  'Bash(npm test:*)',
  'Bash(npx prettier:*)',
  'Bash(rg:*)',
  'Bash(sed:*)',
  'Bash(tail:*)',
  'Bash(/Users/suguru/venvs/izuna/bin/python3:*)',
  'Bash(launchctl kickstart:*)',
].join(',');

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

function parseCsvEnv(value: string | undefined, fallback = ''): string[] {
  return (value || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** セッション（会話履歴） */
interface Session {
  messages: LLMMessage[];
  updatedAt: number;
}

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

// buildTriggerFeedbackMessage: trigger feedback 機構が upstream で tool 化されて削除されたため、
// この helper も同時に未使用化。将来 trigger 機能を tool 経由で復活させた時に再利用予定で残置せず削除。

export class LocalLlmRunner implements AgentRunner {
  private readonly llm: ILLMClient;
  /**
   * channel-specific dev client (built-in tools 解禁) — `CLAUDE_DEV_CHANNEL_IDS` env で
   * 指定された channelId からの request のみこちらにルーティングする。null = dev mode 無効。
   */
  private readonly llmDev: ILLMClient | null;
  /** dev client にルーティングする channelId 集合 */
  private readonly devChannelIds: Set<string>;
  /**
   * - 'claude' (default): claude -p 司令塔。built-in tools 不可、ACTION マーカーで委譲
   * - 'claude_dev': claude -p + built-in tools (Read/Write/Bash) 許可。Phase 2 self-mod 用
   * - 'hayabusa': Gemma4 26B Q4 (旧経路、fallback)
   */
  readonly backend: 'claude' | 'claude_dev' | 'hayabusa';
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
  /** claude バックエンド時の channel別 session_id store (諦めモード reset 用に直アクセス) */
  private readonly claudeSessionStore: ClaudeSessionStore | null;

  constructor(config: AgentConfig) {
    const baseUrl = (process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    const model = config.model || process.env.LOCAL_LLM_MODEL || '';
    const apiKey = process.env.LOCAL_LLM_API_KEY || '';
    const thinking = process.env.LOCAL_LLM_THINKING !== 'false';
    const maxTokens = process.env.LOCAL_LLM_MAX_TOKENS
      ? parseInt(process.env.LOCAL_LLM_MAX_TOKENS, 10)
      : 8192;
    const numCtx = process.env.LOCAL_LLM_NUM_CTX
      ? parseInt(process.env.LOCAL_LLM_NUM_CTX, 10)
      : undefined;

    // 個別フラグ（環境変数で制御、未設定時はLOCAL_LLM_MODEから推定）
    const modeEnv = (process.env.LOCAL_LLM_MODE || '').toLowerCase();
    const modeDefaults = {
      agent: { tools: true, skills: true, xangiCommands: true, triggers: false },
      chat: { tools: false, skills: false, xangiCommands: false, triggers: false },
      lite: { tools: true, skills: false, xangiCommands: false, triggers: true },
    };
    const defaults = modeDefaults[modeEnv as keyof typeof modeDefaults] || modeDefaults.agent;

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

    // LLM_BACKEND: "claude" (default) | "claude_dev" | "hayabusa"
    const backendEnv = (process.env.LLM_BACKEND || 'claude').toLowerCase();
    this.backend =
      backendEnv === 'hayabusa'
        ? 'hayabusa'
        : backendEnv === 'claude_dev'
          ? 'claude_dev'
          : 'claude';

    this.workdir = config.workdir || process.cwd();

    if (this.backend === 'claude' || this.backend === 'claude_dev') {
      const claudeCwd =
        process.env.CLAUDE_CWD || path.join(os.homedir(), 'projects', 'izuna-workspace');
      const timeoutMs = process.env.CLAUDE_TIMEOUT_MS
        ? parseInt(process.env.CLAUDE_TIMEOUT_MS, 10)
        : undefined;
      this.claudeSessionStore = new ClaudeSessionStore();
      // claude_dev: built-in tools 解禁。env CLAUDE_ALLOWED_TOOLS で上書き可能。
      // 例: CLAUDE_ALLOWED_TOOLS="Read,Edit,Bash,Glob,Grep"
      const allowedTools =
        this.backend === 'claude_dev'
          ? parseCsvEnv(process.env.CLAUDE_ALLOWED_TOOLS, DEFAULT_DEV_ALLOWED_TOOLS)
          : undefined;
      const devAddDirs = parseCsvEnv(
        process.env.CLAUDE_DEV_ADD_DIRS,
        [
          claudeCwd,
          path.join(os.homedir(), 'projects', 'xangi-izuna-discord'),
          path.join(os.homedir(), 'Library', 'LaunchAgents'),
        ].join(',')
      );
      const devPermissionMode = (process.env.CLAUDE_DEV_PERMISSION_MODE || 'auto') as
        | 'acceptEdits'
        | 'bypassPermissions'
        | 'default'
        | 'dontAsk'
        | 'plan'
        | 'auto';
      this.llm = new ClaudeCliClient({
        cwd: claudeCwd,
        timeoutMs,
        sessionStore: this.claudeSessionStore,
        logger: (l) => console.log('[claude-cli]', l),
        allowedTools,
        skipPermissions: this.backend === 'claude_dev' ? false : undefined,
        permissionMode: this.backend === 'claude_dev' ? devPermissionMode : undefined,
        addDirs: this.backend === 'claude_dev' ? devAddDirs : undefined,
      });
      console.log(
        `[local-llm] LLM: claude -p (backend: ${this.backend}, cwd: ${claudeCwd}, model: ${process.env.CLAUDE_MODEL || 'default'}${allowedTools ? `, allowedTools: ${allowedTools.join(',')}` : ''})`
      );
      // CLAUDE_DEV_CHANNEL_IDS が指定されており、default が claude (非 dev) なら、
      // 該当 channel 専用の dev クライアントを別建てで用意する。
      // (default が claude_dev なら全 channel が既に dev なので不要)
      const devIdsEnv = (process.env.CLAUDE_DEV_CHANNEL_IDS || '').trim();
      this.devChannelIds = devIdsEnv
        ? new Set(
            devIdsEnv
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          )
        : new Set();
      if (this.backend === 'claude' && this.devChannelIds.size > 0) {
        const devTools = parseCsvEnv(process.env.CLAUDE_ALLOWED_TOOLS, DEFAULT_DEV_ALLOWED_TOOLS);
        this.llmDev = new ClaudeCliClient({
          cwd: claudeCwd,
          timeoutMs,
          sessionStore: this.claudeSessionStore,
          logger: (l) => console.log('[claude-cli/dev]', l),
          allowedTools: devTools,
          skipPermissions: false,
          permissionMode: devPermissionMode,
          addDirs: devAddDirs,
        });
        console.log(
          `[local-llm] dev client armed for channels: ${[...this.devChannelIds].join(',')} (permissionMode: ${devPermissionMode}, addDirs: ${devAddDirs.join(',')}, allowedTools: ${devTools.join(',')})`
        );
      } else {
        this.llmDev = null;
      }
    } else {
      this.claudeSessionStore = null;
      this.llm = new LLMClient(baseUrl, model, apiKey, thinking, maxTokens, numCtx);
      this.llmDev = null;
      this.devChannelIds = new Set();
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

    console.log(`[local-llm] backend: ${this.backend}`);

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
  }

  /**
   * channelId に応じて default または dev client を返す。
   * dev set にない channel は default (built-in tools 不可)。
   */
  private pickLlm(channelId?: string): ILLMClient {
    if (this.llmDev && channelId && this.devChannelIds.has(channelId)) {
      return this.llmDev;
    }
    return this.llm;
  }

  private isDevModeChannel(channelId?: string): boolean {
    return (
      this.backend === 'claude_dev' ||
      Boolean(this.llmDev && channelId && this.devChannelIds.has(channelId))
    );
  }

  private loadClaudeDevPrompt(): string | null {
    const configured = (process.env.CLAUDE_DEV_PROMPT_PATH || '').trim();
    const promptPath =
      configured ||
      path.join(
        process.env.CLAUDE_CWD || path.join(os.homedir(), 'projects', 'izuna-workspace'),
        'CLAUDE_dev.md'
      );
    try {
      if (!fs.existsSync(promptPath)) return null;
      return fs.readFileSync(promptPath, 'utf8');
    } catch {
      return null;
    }
  }

  private auditDevEvent(event: Record<string, unknown>): void {
    try {
      const auditPath =
        process.env.CLAUDE_DEV_AUDIT_PATH ||
        path.join(os.homedir(), 'projects', 'izuna-workspace', 'audit', 'claude_dev_xangi.jsonl');
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.appendFileSync(
        auditPath,
        JSON.stringify(
          {
            ts: new Date().toISOString(),
            ...event,
          },
          null,
          0
        ) + '\n'
      );
    } catch {
      /* audit must not break user flow */
    }
  }

  private devRepoStatus(): Record<string, string> {
    const repos = {
      izuna_workspace: path.join(os.homedir(), 'projects', 'izuna-workspace'),
      xangi_discord: path.join(os.homedir(), 'projects', 'xangi-izuna-discord'),
    };
    const out: Record<string, string> = {};
    for (const [name, cwd] of Object.entries(repos)) {
      try {
        out[name] = execFileSync('git', ['status', '--short'], {
          cwd,
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
      } catch (err) {
        out[name] = `status_error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return out;
  }

  /**
   * claude session の channel エントリを消す (諦めモード対策)。
   * 次の同 channel メッセージは新規 session で開始される。
   * hayabusa バックエンドでは no-op。
   */
  async clearChannelSession(channelId: string): Promise<void> {
    if (!this.claudeSessionStore || !channelId) return;
    await this.claudeSessionStore.clear(channelId);
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const sessionId = options?.sessionId || crypto.randomUUID();
    this.cleanupSessions();

    const session = this.getOrCreateSession(sessionId);
    const systemPrompt = await this.buildSystemPrompt(options?.channelAgent, options?.channelId);
    const tools = this.enableTools ? getAllTools() : [];
    const llmTools = this.enableTools ? toLLMTools(tools) : [];

    // ユーザーメッセージ追加（画像添付があればマルチモーダルメッセージにする）
    const userMsg = this.buildUserMessage(prompt);
    session.messages.push(userMsg);

    // トランスクリプトにプロンプトを記録
    const channelId = options?.channelId || sessionId;
    const appSid = options?.appSessionId || channelId;
    const isDevMode = this.isDevModeChannel(channelId);
    if (isDevMode) {
      this.auditDevEvent({
        event: 'run_start',
        channelId,
        appSessionId: appSid,
        sessionId,
        prompt: prompt.slice(0, 2000),
        repoStatusBefore: this.devRepoStatus(),
      });
    }
    logPrompt(this.workdir, appSid, prompt);

    // AbortControllerをprocessManager相当として登録
    const abortController = new AbortController();
    this.activeAbortControllers.set(channelId, abortController);

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
      if (isDevMode) {
        this.auditDevEvent({
          event: 'run_complete',
          channelId,
          appSessionId: appSid,
          sessionId,
          resultChars: result.length,
          resultPreview: result.slice(0, 2000),
          repoStatusAfter: this.devRepoStatus(),
        });
      }

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
          if (isDevMode) {
            this.auditDevEvent({
              event: 'run_retry_complete',
              channelId,
              appSessionId: appSid,
              sessionId,
              resultChars: result.length,
              resultPreview: result.slice(0, 2000),
              repoStatusAfter: this.devRepoStatus(),
            });
          }

          return { result, sessionId };
        } catch (retryErr) {
          const errorMsg = formatLlmError(retryErr);
          logError(
            this.workdir,
            appSid,
            `LLM chat retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
          if (isDevMode) {
            this.auditDevEvent({
              event: 'run_retry_error',
              channelId,
              appSessionId: appSid,
              sessionId,
              error: retryErr instanceof Error ? retryErr.message : String(retryErr),
              repoStatusAfter: this.devRepoStatus(),
            });
          }
          return { result: errorMsg, sessionId };
        }
      }

      const errorMsg = formatLlmError(err);
      logError(
        this.workdir,
        appSid,
        `LLM chat error: ${err instanceof Error ? err.message : String(err)}`
      );
      if (isDevMode) {
        this.auditDevEvent({
          event: 'run_error',
          channelId,
          appSessionId: appSid,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
          repoStatusAfter: this.devRepoStatus(),
        });
      }
      return { result: errorMsg, sessionId };
    } finally {
      this.activeAbortControllers.delete(channelId);
    }
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const sessionId = options?.sessionId || crypto.randomUUID();
    this.cleanupSessions();

    const session = this.getOrCreateSession(sessionId);
    const systemPrompt = await this.buildSystemPrompt(options?.channelAgent, options?.channelId);
    const tools = this.enableTools ? getAllTools() : [];
    const llmTools = this.enableTools ? toLLMTools(tools) : [];

    const userMsg = this.buildUserMessage(prompt);
    session.messages.push(userMsg);

    const channelId = options?.channelId || sessionId;
    const appSid = options?.appSessionId || channelId;
    const isDevMode = this.isDevModeChannel(channelId);

    // トランスクリプトにプロンプトを記録
    if (isDevMode) {
      this.auditDevEvent({
        event: 'stream_start',
        channelId,
        appSessionId: appSid,
        sessionId,
        prompt: prompt.slice(0, 2000),
        repoStatusBefore: this.devRepoStatus(),
      });
    }
    logPrompt(this.workdir, appSid, prompt);
    const abortController = new AbortController();
    this.activeAbortControllers.set(channelId, abortController);

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

      // 注: trigger feedback は upstream への merge で削除済み (tool化された)
      this.trimSession(session);
      session.updatedAt = Date.now();

      // トランスクリプトにレスポンスを記録
      logResponse(this.workdir, appSid, { result: fullText, sessionId });
      if (isDevMode) {
        this.auditDevEvent({
          event: 'stream_complete',
          channelId,
          appSessionId: appSid,
          sessionId,
          resultChars: fullText.length,
          resultPreview: fullText.slice(0, 2000),
          repoStatusAfter: this.devRepoStatus(),
        });
      }

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
          if (isDevMode) {
            this.auditDevEvent({
              event: 'stream_retry_complete',
              channelId,
              appSessionId: appSid,
              sessionId,
              resultChars: fullText.length,
              resultPreview: fullText.slice(0, 2000),
              repoStatusAfter: this.devRepoStatus(),
            });
          }

          const result: RunResult = { result: fullText, sessionId };
          callbacks.onComplete?.(result);
          return result;
        } catch (retryErr) {
          const error = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          const errorMsg = formatLlmError(retryErr);
          logError(this.workdir, appSid, `LLM stream retry failed: ${error.message}`);
          if (isDevMode) {
            this.auditDevEvent({
              event: 'stream_retry_error',
              channelId,
              appSessionId: appSid,
              sessionId,
              error: error.message,
              repoStatusAfter: this.devRepoStatus(),
            });
          }
          callbacks.onError?.(error);
          return { result: errorMsg, sessionId };
        }
      }

      const error = err instanceof Error ? err : new Error(String(err));
      const errorMsg = formatLlmError(err);
      logError(this.workdir, appSid, `LLM stream error: ${error.message}`);
      if (isDevMode) {
        this.auditDevEvent({
          event: 'stream_error',
          channelId,
          appSessionId: appSid,
          sessionId,
          error: error.message,
          repoStatusAfter: this.devRepoStatus(),
        });
      }
      callbacks.onError?.(error);
      return { result: errorMsg, sessionId };
    } finally {
      this.activeAbortControllers.delete(channelId);
    }
  }

  cancel(channelId?: string): boolean {
    if (channelId) {
      const controller = this.activeAbortControllers.get(channelId);
      if (controller) {
        controller.abort();
        this.activeAbortControllers.delete(channelId);
        return true;
      }
    }
    // channelId不明の場合は全部止める
    if (this.activeAbortControllers.size > 0) {
      for (const [id, controller] of this.activeAbortControllers) {
        controller.abort();
        this.activeAbortControllers.delete(id);
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
        response = await this.pickLlm(channelId).chat(session.messages, {
          systemPrompt,
          signal: abortController.signal,
          channelId,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[local-llm] LLM chat call failed: ${errorMsg}`);
        logError(this.workdir, logId, `LLM chat call failed: ${errorMsg}`);
        throw err;
      }
      session.messages.push({ role: 'assistant', content: response.content });
      // 注: trigger feedback は upstream への merge で削除済み (tool化された)
      return response.content;
    }

    let toolRounds = 0;
    let finalContent = '';
    const pendingMediaPaths: string[] = [];

    while (toolRounds <= MAX_TOOL_ROUNDS) {
      let response;
      try {
        response = await this.pickLlm(channelId).chat(session.messages, {
          systemPrompt,
          tools: llmTools.length > 0 ? llmTools : undefined,
          signal: abortController.signal,
          channelId,
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

      const toolContext = { workspace: this.workdir, channelId: options?.channelId };

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

        const result = await executeTool(toolCall.name, toolCall.arguments, toolContext);
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

    // ツール有効時のみツールループ実行
    if (this.enableTools) {
      // ツールループ: non-streaming の chat() でツール呼び出しを処理
      let toolRounds = 0;
      while (toolRounds < MAX_TOOL_ROUNDS) {
        let response;
        try {
          response = await this.pickLlm(channelId).chat(session.messages, {
            systemPrompt,
            tools: llmTools.length > 0 ? llmTools : undefined,
            signal: abortController.signal,
            channelId,
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

        const toolContext = { workspace: this.workdir, channelId: options?.channelId };
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

          const result = await executeTool(toolCall.name, toolCall.arguments, toolContext);
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
    let fullText = '';
    try {
      for await (const chunk of this.pickLlm(channelId).chatStream(session.messages, {
        systemPrompt,
        signal: abortController.signal,
        channelId,
      })) {
        fullText += chunk;
        callbacks.onText?.(chunk, fullText);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[local-llm] LLM chatStream failed: ${errorMsg}`);
      logError(this.workdir, logId, `LLM chatStream failed: ${errorMsg}`);
      throw err;
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

  private async buildSystemPrompt(channelAgent?: string, channelId?: string): Promise<string> {
    const parts: string[] = [];

    if (this.isDevModeChannel(channelId)) {
      const devPrompt = this.loadClaudeDevPrompt();
      parts.push(
        [
          '## 🔧 Izuna Dev Mode (最優先)',
          'この channel は Discord 方針変更から Izuna 自身のプログラム/プロンプト/設定を更新する self-mod ランタイムです。',
          '目標は「秘書官LLM → 必要なプログラム変更 + ユーザ記憶 → 秘書官LLM」の閉ループを成立させることです。',
          '通常応答用の CLAUDE.md より、この dev mode 指針を優先してください。',
          devPrompt
            ? `\n${devPrompt}`
            : '\nCLAUDE_dev.md が見つかりません。変更は最小限にし、必ずユーザに報告してください。',
        ].join('\n')
      );
    }

    // 🔒 Channel Lock: このチャンネルは指定 agent の作業場 → その専門業務は全部このチャンネルで実行する。
    //    他 agent 領域の依頼 (明らかに別カテゴリ) だけ #一般 へ誘導する。
    if (channelAgent) {
      const domainHints: Record<string, string> = {
        'script-writer-agent':
          '漫画・小説・台本・プロット・キャラ設定・シーン執筆・ストーリー壁打ち',
        'mail-agent': 'メール返信・下書き・メール本文の精査',
        'calendar-agent': '予定登録・空き時間確認・スケジュール調整',
        'social-agent': 'X/note/SNS 投稿原稿の作成・公開',
        'notion-manager': 'Notion 保存・タスク記録',
        'dmat-keychain-agent': 'DMAT-Keychain リポジトリの開発',
      };
      const domain = domainHints[channelAgent] || `${channelAgent} の専門業務`;
      parts.push(
        [
          '## 🔒 Channel Lock (最優先、他の全指示を上書きする)',
          `このチャンネルはあなた (${channelAgent}) の作業場です。専門領域: **${domain}**`,
          '',
          '### 基本動作',
          '- 専門業務の依頼を即座に実行する (「よろしく」「書き直して」「作って」も含む)',
          '- 他の agent に DISPATCH せず、あなた自身が作業を完了させる',
          '',
          '### コンテキスト汚染への対処 (重要)',
          '- System prompt 末尾に注入される `🎭 Persona` / `🪞 直近の内省` / `🧠 長期記憶` / `📋 進行中タスク` 等は',
          '  **全 channel 共通**のコンテキストで、他 agent 領域の情報 (漫画台本 / 予定 / SNS等) も混在する。',
          `- このチャンネルでは **${channelAgent} 領域の情報だけ**を参照する。それ以外は context noise として無視。`,
          `- たとえ memory に 台本 / 予定 / SNS の話題が含まれていても、この channel の応答には絶対に持ち込まない。`,
          `- 出力は必ず ${channelAgent} の専門領域 (${domain}) の内容だけで構成する。`,
          '',
          '### 禁止事項',
          '- 他 agent への [DISPATCH:] 出力',
          '- 他 agent 領域のコンテンツ出力 (例: mail-agent なのに漫画台本を書く)',
          '- 「〜専用です」「#一般 へ移動してください」を safe choice として多用',
          '',
          `### refuse してよい場面`,
          `- ユーザーが明確に別領域を依頼した時のみ (例: #mail で「台本書いて」→ 「#台本 へどうぞ」)。`,
        ].join('\n')
      );
    }

    // XANGI_COMMANDS注入 (機能フラグで制御)
    if (this.enableXangiCommands) {
      parts.push(CHAT_SYSTEM_PROMPT_PERSISTENT + '\n\n## XANGI_COMMANDS.md\n\n' + XANGI_COMMANDS);
    }

    // ワークスペースコンテキスト（CLAUDE.md, AGENTS.md, MEMORY.md）— 常に注入
    const context = loadWorkspaceContext(this.workdir);
    if (context) parts.push(context);

    // izuna-workspace コンテキスト注入（L1メモリ・タスク・予定）
    const izunaContext = await getIzunaContext();
    if (izunaContext) {
      parts.push(`## 記憶・タスク・予定\n${izunaContext}`);
    }

    // 📜 直近会話ログ注入: channelAgent が無い orchestrator channel (#一般 等) で
    //    短い訂正 ("17時だよ今日の") を前後文脈から解釈できるようにする。
    //    agent 固有チャンネルでは Channel Lock で noise 防止のため入れない。
    if (channelId && !channelAgent) {
      try {
        const recent = await getRecentConversation(channelId, '#一般');
        if (recent) parts.push(recent);
      } catch {
        /* ignore */
      }
    }

    // トリガー（毎回リロード）
    if (this.enableTriggers) {
      this.triggers = loadTriggers(this.workdir);
      if (this.triggers.length > 0) {
        if (this.enableTools) {
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
    if (this.enableSkills) {
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
    if (this.enableTools) {
      parts.push(TOOLS_USAGE_PROMPT);
    }

    return parts.join('\n\n');
  }

  private getOrCreateSession(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { messages: [], updatedAt: Date.now() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * コンテキスト刈り込み（karaagebot準拠）
   * 1. ツール結果をTOOL_RESULT_MAX_CHARS_IN_CONTEXTに切り詰め
   * 2. 直近CONTEXT_KEEP_LAST件を保護
   * 3. 合計文字数がCONTEXT_MAX_CHARSを超えたら古いメッセージから削除
   * 4. メッセージ数がMAX_SESSION_MESSAGESを超えたら古いものを削除
   */
  private trimSession(session: Session): void {
    // ツール結果を切り詰め（コンテキスト内）
    for (const msg of session.messages) {
      if (msg.role === 'tool' && msg.content.length > TOOL_RESULT_MAX_CHARS_IN_CONTEXT) {
        const head = Math.floor(TOOL_RESULT_MAX_CHARS_IN_CONTEXT * 0.4);
        const tail = Math.floor(TOOL_RESULT_MAX_CHARS_IN_CONTEXT * 0.4);
        msg.content =
          msg.content.slice(0, head) +
          `\n\n... [${msg.content.length - head - tail} chars trimmed for context] ...\n\n` +
          msg.content.slice(-tail);
      }
    }

    // メッセージ数制限
    if (session.messages.length > MAX_SESSION_MESSAGES) {
      session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
    }

    // 合計文字数制限（直近CONTEXT_KEEP_LAST件を保護）
    let totalChars = session.messages.reduce((sum, m) => sum + m.content.length, 0);
    while (totalChars > CONTEXT_MAX_CHARS && session.messages.length > CONTEXT_KEEP_LAST) {
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
