/**
 * ローカルLLMバックエンド — xangi本体に統合
 *
 * Ollama等のOpenAI互換APIを直接叩いてエージェントループを実行する。
 * 外部HTTPサーバー不要。
 */
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../agent-runner.js';
import type { AgentConfig } from '../config.js';
import type { LLMMessage, LLMImageContent } from './types.js';
import { LLMClient } from './llm-client.js';
import { extractAttachmentPaths, encodeImageToBase64, getMimeType } from './image-utils.js';
import { loadWorkspaceContext } from './context.js';
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

export class LocalLlmRunner implements AgentRunner {
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

    this.llm = new LLMClient(baseUrl, model, apiKey, thinking, maxTokens, numCtx);
    this.workdir = config.workdir || process.cwd();

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
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const sessionId = options?.sessionId || crypto.randomUUID();
    this.cleanupSessions();

    const session = this.getOrCreateSession(sessionId);
    const systemPrompt = this.buildSystemPrompt();
    const tools = this.enableTools ? getAllTools() : [];
    const llmTools = this.enableTools ? toLLMTools(tools) : [];

    // ユーザーメッセージ追加（画像添付があればマルチモーダルメッセージにする）
    const userMsg = this.buildUserMessage(prompt);
    session.messages.push(userMsg);

    // トランスクリプトにプロンプトを記録
    const channelId = options?.channelId || sessionId;
    const appSid = options?.appSessionId || channelId;
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
    const systemPrompt = this.buildSystemPrompt();
    const tools = this.enableTools ? getAllTools() : [];
    const llmTools = this.enableTools ? toLLMTools(tools) : [];

    const userMsg = this.buildUserMessage(prompt);
    session.messages.push(userMsg);

    const channelId = options?.channelId || sessionId;
    const appSid = options?.appSessionId || channelId;

    // トランスクリプトにプロンプトを記録
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

      this.trimSession(session);
      session.updatedAt = Date.now();

      // トランスクリプトにレスポンスを記録
      logResponse(this.workdir, appSid, { result: fullText, sessionId });

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
      let response;
      try {
        response = await this.llm.chat(session.messages, {
          systemPrompt,
          tools: llmTools.length > 0 ? llmTools : undefined,
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
          response = await this.llm.chat(session.messages, {
            systemPrompt,
            tools: llmTools.length > 0 ? llmTools : undefined,
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
      for await (const chunk of this.llm.chatStream(session.messages, {
        systemPrompt,
        signal: abortController.signal,
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

  private buildSystemPrompt(): string {
    const parts: string[] = [];

    // XANGI_COMMANDS注入
    if (this.enableXangiCommands) {
      parts.push(CHAT_SYSTEM_PROMPT_PERSISTENT + '\n\n## XANGI_COMMANDS.md\n\n' + XANGI_COMMANDS);
    }

    // ワークスペースコンテキスト（CLAUDE.md, AGENTS.md, MEMORY.md）— 常に注入
    const context = loadWorkspaceContext(this.workdir);
    if (context) parts.push(context);

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
