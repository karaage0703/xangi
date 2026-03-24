/**
 * ローカルLLMバックエンド — xangi本体に統合
 *
 * Ollama等のOpenAI互換APIを直接叩いてエージェントループを実行する。
 * 外部HTTPサーバー不要。
 */
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../agent-runner.js';
import type { AgentConfig } from '../config.js';
import type { LLMMessage } from './types.js';
import { LLMClient } from './llm-client.js';
import { loadWorkspaceContext } from './context.js';
import { getBuiltinTools, toLLMTools, executeTool } from './tools.js';
import { loadSkills } from '../skills.js';
import { CHAT_SYSTEM_PROMPT_PERSISTENT, XANGI_COMMANDS } from '../base-runner.js';
import { logPrompt, logResponse, logError } from '../transcript-logger.js';

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

  constructor(config: AgentConfig) {
    const baseUrl = (process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    const model = process.env.LOCAL_LLM_MODEL || config.model || '';
    const apiKey = process.env.LOCAL_LLM_API_KEY || '';
    const thinking = process.env.LOCAL_LLM_THINKING !== 'false';
    const maxTokens = process.env.LOCAL_LLM_MAX_TOKENS
      ? parseInt(process.env.LOCAL_LLM_MAX_TOKENS, 10)
      : 8192;
    const numCtx = process.env.LOCAL_LLM_NUM_CTX
      ? parseInt(process.env.LOCAL_LLM_NUM_CTX, 10)
      : undefined;

    this.llm = new LLMClient(baseUrl, model, apiKey, thinking, maxTokens, numCtx);
    this.workdir = config.workdir || process.cwd();

    console.log(`[local-llm] LLM: ${baseUrl} (model: ${model}, thinking: ${thinking})`);
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const sessionId = options?.sessionId || crypto.randomUUID();
    this.cleanupSessions();

    const session = this.getOrCreateSession(sessionId);
    const systemPrompt = this.buildSystemPrompt();
    const tools = getBuiltinTools();
    const llmTools = toLLMTools(tools);

    // ユーザーメッセージ追加
    const userMsg: LLMMessage = { role: 'user', content: prompt };
    session.messages.push(userMsg);

    // トランスクリプトにプロンプトを記録
    const channelId = options?.channelId || sessionId;
    logPrompt(this.workdir, channelId, prompt, sessionId);

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
        options
      );

      this.trimSession(session);
      session.updatedAt = Date.now();

      // トランスクリプトにレスポンスを記録
      logResponse(this.workdir, channelId, { result, sessionId });

      return { result, sessionId };
    } catch (err) {
      // セッション履歴に起因するエラーの場合、セッションをクリアしてリトライ
      if (session.messages.length > 1 && isSessionRelatedError(err)) {
        console.warn(
          `[local-llm] Session-related error, retrying with fresh session: ${err instanceof Error ? err.message : String(err)}`
        );
        logError(
          this.workdir,
          channelId,
          `Session resume failed, retrying: ${err instanceof Error ? err.message : String(err)}`,
          sessionId
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
            options
          );

          this.trimSession(session);
          session.updatedAt = Date.now();
          logResponse(this.workdir, channelId, { result, sessionId });

          return { result, sessionId };
        } catch (retryErr) {
          const errorMsg = formatLlmError(retryErr);
          logError(
            this.workdir,
            channelId,
            `LLM chat retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
            sessionId
          );
          return { result: errorMsg, sessionId };
        }
      }

      const errorMsg = formatLlmError(err);
      logError(
        this.workdir,
        channelId,
        `LLM chat error: ${err instanceof Error ? err.message : String(err)}`,
        sessionId
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
    const tools = getBuiltinTools();
    const llmTools = toLLMTools(tools);

    const userMsg: LLMMessage = { role: 'user', content: prompt };
    session.messages.push(userMsg);

    const channelId = options?.channelId || sessionId;

    // トランスクリプトにプロンプトを記録
    logPrompt(this.workdir, channelId, prompt, sessionId);
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
        options
      );

      session.messages.push({ role: 'assistant', content: fullText });
      this.trimSession(session);
      session.updatedAt = Date.now();

      // トランスクリプトにレスポンスを記録
      logResponse(this.workdir, channelId, { result: fullText, sessionId });

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
          channelId,
          `Session resume failed (stream), retrying: ${err instanceof Error ? err.message : String(err)}`,
          sessionId
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
            options
          );

          session.messages.push({ role: 'assistant', content: fullText });
          this.trimSession(session);
          session.updatedAt = Date.now();
          logResponse(this.workdir, channelId, { result: fullText, sessionId });

          const result: RunResult = { result: fullText, sessionId };
          callbacks.onComplete?.(result);
          return result;
        } catch (retryErr) {
          const error = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          const errorMsg = formatLlmError(retryErr);
          logError(this.workdir, channelId, `LLM stream retry failed: ${error.message}`, sessionId);
          callbacks.onError?.(error);
          return { result: errorMsg, sessionId };
        }
      }

      const error = err instanceof Error ? err : new Error(String(err));
      const errorMsg = formatLlmError(err);
      logError(this.workdir, channelId, `LLM stream error: ${error.message}`, sessionId);
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
   */
  private async executeAgentLoop(
    session: Session,
    systemPrompt: string,
    llmTools: ReturnType<typeof toLLMTools>,
    channelId: string,
    sessionId: string,
    abortController: AbortController,
    options?: RunOptions
  ): Promise<string> {
    let toolRounds = 0;
    let finalContent = '';

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
        logError(this.workdir, channelId, `LLM chat call failed: ${errorMsg}`, sessionId);
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
        const result = await executeTool(toolCall.name, toolCall.arguments, toolContext);
        const rawOutput = result.success
          ? result.output
          : `Error: ${result.error ?? 'Unknown error'}${result.output ? `\nOutput: ${result.output}` : ''}`;
        const toolResultContent = trimToolResult(rawOutput);

        if (!result.success) {
          logError(
            this.workdir,
            channelId,
            `Tool ${toolCall.name} failed: ${rawOutput}`,
            sessionId
          );
        }

        console.log(
          `[local-llm] Tool result: ${result.success ? 'OK' : 'FAIL'} (${toolResultContent.length} chars)`
        );
        session.messages.push({
          role: 'tool',
          content: toolResultContent,
          toolCallId: toolCall.id,
        });
      }

      toolRounds++;
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        finalContent = 'Maximum tool rounds reached.';
        break;
      }
    }

    return finalContent;
  }

  /**
   * ストリーミングループ: ツール呼び出し + 最終応答ストリーミング
   */
  private async executeStreamLoop(
    session: Session,
    systemPrompt: string,
    llmTools: ReturnType<typeof toLLMTools>,
    channelId: string,
    sessionId: string,
    abortController: AbortController,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<string> {
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
        logError(
          this.workdir,
          channelId,
          `LLM chat call failed (stream tool loop): ${errorMsg}`,
          sessionId
        );
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
        const result = await executeTool(toolCall.name, toolCall.arguments, toolContext);
        const rawToolOutput = result.success
          ? result.output
          : `Error: ${result.error ?? 'Unknown error'}${result.output ? `\nOutput: ${result.output}` : ''}`;
        const toolResultContent = trimToolResult(rawToolOutput);
        if (!result.success) {
          logError(
            this.workdir,
            channelId,
            `Tool ${toolCall.name} failed: ${rawToolOutput}`,
            sessionId
          );
        }
        console.log(
          `[local-llm] Tool result: ${result.success ? 'OK' : 'FAIL'} (${toolResultContent.length} chars)`
        );
        session.messages.push({
          role: 'tool',
          content: toolResultContent,
          toolCallId: toolCall.id,
        });
      }
      toolRounds++;
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
      logError(this.workdir, channelId, `LLM chatStream failed: ${errorMsg}`, sessionId);
      throw err;
    }

    return fullText;
  }

  private buildSystemPrompt(): string {
    const parts: string[] = [];

    // チャットプラットフォーム説明 + xangiコマンド（base-runner共通）
    parts.push(CHAT_SYSTEM_PROMPT_PERSISTENT + '\n\n## XANGI_COMMANDS.md\n\n' + XANGI_COMMANDS);

    // ワークスペースコンテキスト（CLAUDE.md, AGENTS.md, MEMORY.md）
    const context = loadWorkspaceContext(this.workdir);
    if (context) parts.push(context);

    // スキル一覧と使い方（karaagebot準拠: パスを明示）
    const skills = loadSkills(this.workdir);
    if (skills.length > 0) {
      const skillLines = skills
        .map((s) => `  - **${s.name}**: ${s.description}\n    SKILL.md: ${s.path}`)
        .join('\n');
      parts.push(
        `## Available Skills\n\nUse the read tool to load SKILL.md before using a skill. NEVER guess commands — always read SKILL.md first.\n${skillLines}`
      );
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
