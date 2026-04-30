/**
 * ローカルLLMバックエンド — xangi本体に統合
 *
 * Ollama等のOpenAI互換APIを直接叩いてエージェントループを実行する。
 * 外部HTTPサーバー不要。
 */
import * as os from 'os';
import * as path from 'path';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../agent-runner.js';
import type { AgentConfig } from '../config.js';
import type { LLMMessage, LLMImageContent } from './types.js';
import { LLMClient, type ILLMClient } from './llm-client.js';
import { ClaudeCliClient } from './claude-client.js';
import { ClaudeSessionStore } from './claude-session-store.js';
import { extractAttachmentPaths, encodeImageToBase64, getMimeType } from './image-utils.js';
import { loadWorkspaceContext } from './context.js';
import { getIzunaContext, getRecentConversation } from './context-injector.js';
import { getBuiltinTools, toLLMTools, executeTool } from './tools.js';
import { loadSkills } from '../skills.js';
import { CHAT_SYSTEM_PROMPT_PERSISTENT, XANGI_COMMANDS } from '../base-runner.js';
import { logPrompt, logResponse, logError } from '../transcript-logger.js';
import {
  loadTriggers,
  matchTrigger,
  executeTrigger,
  buildTriggersPrompt,
  type Trigger,
} from './triggers.js';

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

function buildTriggerFeedbackMessage(triggerName: string, triggerResult: string): string {
  let formatRule = '一覧データは省略しすぎず、件数や主要項目を具体的に列挙してください。';
  if (triggerName === 'mail') {
    formatRule =
      '未読メールは件数に加えて、各メールの件名・差出人・日時を省略せず列挙してください。';
  } else if (triggerName === 'calendar') {
    formatRule = '予定は今日と明日に分けて、時系列で具体的に列挙してください。';
  } else if (triggerName === 'tasks') {
    formatRule = [
      'タスクは要約せず、trigger結果に含まれる項目名をそのまま使って全件列挙してください。',
      '返答は必ず P0 と P1 を分けた箇条書きにしてください。',
      '例:',
      'P0:',
      '- タスク名',
      'P1:',
      '- タスク名',
    ].join('\n');
  }
  return [
    `[${triggerName}の結果]`,
    '以下は実際に取得した最新データです。',
    'この情報だけを根拠に、元のユーザー依頼へ自然に返答してください。',
    formatRule,
    '',
    triggerResult,
  ].join('\n');
}

export class LocalLlmRunner implements AgentRunner {
  private readonly llm: ILLMClient;
  /** 'claude' | 'hayabusa' — buildSystemPrompt の出力量制御等に使う */
  readonly backend: 'claude' | 'hayabusa';
  private readonly workdir: string;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionTtlMs = 60 * 60 * 1000; // 1時間
  private readonly activeAbortControllers = new Map<string, AbortController>();
  /** liteモード: tools/スキル/XANGI_COMMANDS無効、1回のLLM呼び出しで完了 */
  readonly liteMode: boolean;
  /** liteモード用トリガー定義 */
  private triggers: Trigger[];
  /** claude バックエンド時の channel別 session_id store (諦めモード reset 用に直アクセス) */
  private readonly claudeSessionStore: ClaudeSessionStore | null;

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

    // LOCAL_LLM_MODE: "agent" (default) or "lite"
    const modeEnv = (process.env.LOCAL_LLM_MODE || 'agent').toLowerCase();
    this.liteMode = modeEnv === 'lite';

    // LLM_BACKEND: "claude" (default) or "hayabusa"
    const backendEnv = (process.env.LLM_BACKEND || 'claude').toLowerCase();
    this.backend = backendEnv === 'hayabusa' ? 'hayabusa' : 'claude';

    this.workdir = config.workdir || process.cwd();

    if (this.backend === 'claude') {
      const claudeCwd =
        process.env.CLAUDE_CWD || path.join(os.homedir(), 'projects', 'izuna-workspace');
      const timeoutMs = process.env.CLAUDE_TIMEOUT_MS
        ? parseInt(process.env.CLAUDE_TIMEOUT_MS, 10)
        : undefined;
      this.claudeSessionStore = new ClaudeSessionStore();
      this.llm = new ClaudeCliClient({
        cwd: claudeCwd,
        timeoutMs,
        sessionStore: this.claudeSessionStore,
        logger: (l) => console.log('[claude-cli]', l),
      });
      console.log(
        `[local-llm] LLM: claude -p (cwd: ${claudeCwd}, model: ${process.env.CLAUDE_MODEL || 'default'}, mode: ${this.liteMode ? 'lite' : 'agent'})`
      );
    } else {
      this.claudeSessionStore = null;
      this.llm = new LLMClient(baseUrl, model, apiKey, thinking, maxTokens, numCtx);
      console.log(
        `[local-llm] LLM: ${baseUrl} (model: ${model}, thinking: ${thinking}, mode: ${this.liteMode ? 'lite' : 'agent'})`
      );
    }

    // liteモード用トリガーを読み込み
    this.triggers = this.liteMode ? loadTriggers(this.workdir) : [];

    // 既存ログ出力を維持(backend 別に上で出している)
    console.log(`[local-llm] backend: ${this.backend}`);
    if (this.triggers.length > 0) {
      console.log(`[local-llm] Triggers loaded: ${this.triggers.map((t) => t.trigger).join(', ')}`);
    }
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
    const tools = this.liteMode ? [] : getBuiltinTools();
    const llmTools = this.liteMode ? [] : toLLMTools(tools);

    // ユーザーメッセージ追加（画像添付があればマルチモーダルメッセージにする）
    const userMsg = this.buildUserMessage(prompt);
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
    const systemPrompt = await this.buildSystemPrompt(options?.channelAgent, options?.channelId);
    const tools = this.liteMode ? [] : getBuiltinTools();
    const llmTools = this.liteMode ? [] : toLLMTools(tools);

    const userMsg = this.buildUserMessage(prompt);
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

      // トリガー検出・実行（liteモードのみ）
      let finalText = fullText;
      const triggerResult = await this.processTriggers(fullText, channelId, sessionId);
      if (triggerResult !== null) {
        const match = matchTrigger(fullText, this.triggers);
        if (match?.trigger.feedback) {
          // feedback: handler結果をLLMに戻して再応答
          session.messages.push({
            role: 'user',
            content: buildTriggerFeedbackMessage(match.trigger.name, triggerResult),
          });
          try {
            const feedbackResponse = await this.llm.chat(session.messages, {
              systemPrompt: await this.buildSystemPrompt(options?.channelAgent, options?.channelId),
              signal: abortController.signal,
            });
            session.messages.push({ role: 'assistant', content: feedbackResponse.content });
            // Strip trigger commands from feedback response to prevent
            // Discord-side handleDiscordCommandsInResponse from re-firing
            finalText = feedbackResponse.content
              .split('\n')
              .filter(
                (line: string) => !this.triggers.some((t: any) => line.trim().startsWith(t.trigger))
              )
              .join('\n');
            callbacks.onText?.(finalText, finalText);
          } catch {
            finalText = fullText + '\n\n' + triggerResult;
            callbacks.onText?.('\n\n' + triggerResult, finalText);
          }
        } else {
          // feedback: false — LLM応答 + trigger結果を表示
          finalText = fullText + '\n\n' + triggerResult;
          callbacks.onText?.('\n\n' + triggerResult, finalText);
        }
      }

      // Strip any remaining trigger commands from final output
      finalText = finalText
        .split('\n')
        .filter(
          (line: string) => !this.triggers.some((t: any) => line.trim().startsWith(t.trigger))
        )
        .join('\n')
        .trim();

      this.trimSession(session);
      session.updatedAt = Date.now();

      // トランスクリプトにレスポンスを記録
      logResponse(this.workdir, channelId, { result: finalText, sessionId });

      const result: RunResult = { result: finalText, sessionId };
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
   * liteモードではツールなしの1回呼び出しで完了する。
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
    // liteモード: 1回のLLM呼び出しで完了（ツールなし）+ トリガー検出
    if (this.liteMode) {
      let response;
      try {
        response = await this.llm.chat(session.messages, {
          systemPrompt,
          signal: abortController.signal,
          channelId,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[local-llm] LLM chat call failed: ${errorMsg}`);
        logError(this.workdir, channelId, `LLM chat call failed: ${errorMsg}`, sessionId);
        throw err;
      }
      session.messages.push({ role: 'assistant', content: response.content });

      // トリガー検出・実行
      const triggerResult = await this.processTriggers(response.content, channelId, sessionId);
      if (triggerResult !== null) {
        // feedback: true のトリガーなら結果をLLMに戻して再応答
        const match = matchTrigger(response.content, this.triggers);
        if (match?.trigger.feedback) {
          session.messages.push({
            role: 'user',
            content: buildTriggerFeedbackMessage(match.trigger.name, triggerResult),
          });
          let feedbackResponse;
          try {
            feedbackResponse = await this.llm.chat(session.messages, {
              systemPrompt,
              signal: abortController.signal,
              channelId,
            });
          } catch {
            // feedbackのLLM呼び出し失敗時はtrigger結果をそのまま返す
            return response.content + '\n\n' + triggerResult;
          }
          session.messages.push({ role: 'assistant', content: feedbackResponse.content });
          return feedbackResponse.content;
        }
        // feedback: false — LLM応答 + trigger結果を返す
        return response.content + '\n\n' + triggerResult;
      }

      return response.content;
    }

    let toolRounds = 0;
    let finalContent = '';

    while (toolRounds <= MAX_TOOL_ROUNDS) {
      let response;
      try {
        response = await this.llm.chat(session.messages, {
          systemPrompt,
          tools: llmTools.length > 0 ? llmTools : undefined,
          signal: abortController.signal,
          channelId,
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
    options?: RunOptions
  ): Promise<string> {
    // liteモードではツールループをスキップ
    if (!this.liteMode) {
      // ツールループ: non-streaming の chat() でツール呼び出しを処理
      let toolRounds = 0;
      while (toolRounds < MAX_TOOL_ROUNDS) {
        let response;
        try {
          response = await this.llm.chat(session.messages, {
            systemPrompt,
            tools: llmTools.length > 0 ? llmTools : undefined,
            signal: abortController.signal,
            channelId,
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
    }

    // 最終応答をストリーミングで取得
    let fullText = '';
    try {
      for await (const chunk of this.llm.chatStream(session.messages, {
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
      logError(this.workdir, channelId, `LLM chatStream failed: ${errorMsg}`, sessionId);
      throw err;
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

    // liteモードではXANGI_COMMANDS・CHAT_SYSTEM_PROMPT・スキル一覧を除外
    if (!this.liteMode) {
      parts.push(CHAT_SYSTEM_PROMPT_PERSISTENT + '\n\n## XANGI_COMMANDS.md\n\n' + XANGI_COMMANDS);
    }

    // ワークスペースコンテキスト（CLAUDE.md, AGENTS.md, MEMORY.md）— 両モードで注入
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

    // liteモードでトリガーが存在する場合、利用可能なコマンド一覧を追加（毎回リロード）
    if (this.liteMode) {
      this.triggers = loadTriggers(this.workdir);
    }
    if (this.liteMode && this.triggers.length > 0) {
      const triggersPrompt = buildTriggersPrompt(this.triggers);
      if (triggersPrompt) parts.push(triggersPrompt);
    }

    // スキル一覧と使い方 — agentモードのみ
    if (!this.liteMode) {
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

  /**
   * LLM応答テキストからトリガーを検出・実行する。
   * マッチしたら結果文字列を返す。マッチなしは null。
   */
  private async processTriggers(
    text: string,
    channelId: string,
    sessionId: string
  ): Promise<string | null> {
    // 毎回trigger.yamlを読み直す（再起動なしで変更反映）
    this.triggers = this.liteMode ? loadTriggers(this.workdir) : [];
    if (this.triggers.length === 0) return null;

    const match = matchTrigger(text, this.triggers);
    if (!match) return null;

    console.log(
      `[local-llm] Trigger matched: ${match.trigger.trigger} (args: ${match.args || '(none)'})`
    );

    const result = await executeTrigger(match.trigger, match.args, this.workdir);
    if (result.success) {
      console.log(
        `[local-llm] Trigger ${match.trigger.name} completed (${result.output.length} chars)`
      );
    } else {
      logError(
        this.workdir,
        channelId,
        `Trigger ${match.trigger.name} failed: ${result.output}`,
        sessionId
      );
    }

    return result.output;
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
