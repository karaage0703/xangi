import { createFileObservation } from './file-changes.js';
import { getSessionEntry } from './sessions.js';
/**
 * `runner.runStream` を呼びつつ xangi-events (turn.started / message.delta /
 * turn.complete / turn.aborted / agent.error) を漏れなく発火するラッパー。
 *
 * 経緯: events.* は元々 web-chat / Discord / Slack の各呼び出し元で個別に
 * wiring されていた。共通化することで全 call site が同じ events 配信契約に
 * 従うようになる。
 *
 * 約束:
 * - 呼び出し元は events.turnStarted / messageDelta / turnComplete /
 *   turnAborted / agentError を一切書かなくていい。
 * - 既存の StreamCallbacks (onText/onToolUse/onComplete/onError) はそのまま
 *   通る。caller の UI 更新ロジックを壊さない。
 * - cancel (`Request cancelled by user`) は agent.error ではなく
 *   turn.aborted として送る。
 *
 * 非ストリーミング呼び出しが欲しい caller は callbacks を空 `{}` で渡し、
 * 戻り値の RunResult から最終テキストを取ればよい。runStream 経由でも
 * messageDelta は xangi-pets に届くので、host platform の表示は
 * incremental にしないが pet 側では typing animation が出る。
 */

import { registerRunningSession } from './running-session-context.js';
import { events, type Platform } from './events-emitter.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import {
  abortActivity,
  completeActivity,
  errorActivity,
  startActivity,
  updateActivityText,
  updateActivityTool,
  updateActivityFileChanges,
} from './activity-store.js';

export interface BubbleEventContext {
  threadId: string;
  turnId: string;
  threadLabel?: string;
  platform: Platform;
  /** turn.started に乗せる userText (任意) */
  userText?: string;
  /** UI内部メタデータを共通eventsから除外する場合のみ指定。 */
  eventTextSanitizer?: (text: string) => string;
}

const CANCEL_MESSAGE = 'Request cancelled by user';

export async function runWithBubbleEvents(
  runner: Pick<AgentRunner, 'runStream'>,
  prompt: string,
  ctx: BubbleEventContext,
  callbacks: StreamCallbacks = {},
  options?: RunOptions
): Promise<RunResult> {
  const { userText, eventTextSanitizer, ...eventBase } = ctx;
  startActivity(ctx);
  events.turnStarted({ ...eventBase, userText });
  let errorEmitted = false;
  let lastPublicText = '';
  let completion: RunResult | undefined;
  let callbackError: Error | undefined;
  const session = options?.appSessionId ? getSessionEntry(options.appSessionId) : undefined;
  const workdir = options?.workdir ?? process.env.WORKSPACE_PATH;
  const workspaceId =
    session?.workspaceId ?? (workdir === process.env.WORKSPACE_PATH ? 'default' : undefined);
  const observation =
    workdir && !options?.internalTask ? createFileObservation(workdir, workspaceId) : undefined;
  const collectChanges = () => {
    if (!observation) return;
    try {
      updateActivityFileChanges(ctx, observation.finish());
    } catch {
      updateActivityFileChanges(ctx, { files: [], partial: true, concurrent: false });
    }
  };
  const releaseSession = registerRunningSession(options?.channelId, options?.appSessionId);
  try {
    const runOptions = {
      ...options,
      platform: options?.platform ?? ctx.platform,
      userText: options?.userText ?? userText,
    };

    const result = await runner.runStream(
      prompt,
      {
        onBackendReady: () => callbacks.onBackendReady?.(),
        onModel: (model) => callbacks.onModel?.(model),
        onText: (chunk, fullText) => {
          const publicFullText = eventTextSanitizer ? eventTextSanitizer(fullText) : fullText;
          const publicChunk = eventTextSanitizer
            ? publicFullText.startsWith(lastPublicText)
              ? publicFullText.slice(lastPublicText.length)
              : eventTextSanitizer(chunk)
            : chunk;
          updateActivityText(ctx, publicFullText, publicChunk);
          if (publicChunk) {
            events.messageDelta({
              ...eventBase,
              chunk: publicChunk,
              fullText: publicFullText,
            });
          }
          lastPublicText = publicFullText;
          callbacks.onText?.(chunk, fullText);
        },
        onToolUse: (toolName, toolInput) => {
          observation?.onToolUse(toolName, toolInput);
          updateActivityTool(ctx, toolName, toolInput);
          callbacks.onToolUse?.(toolName, toolInput);
        },
        onFileChanges: (changes) => {
          observation?.onFileChanges(changes);
          callbacks.onFileChanges?.(changes);
        },
        onTraceEvent: (event) => callbacks.onTraceEvent?.(event),
        onComplete: (result) => {
          completion = result;
        },
        onError: (error) => {
          callbackError = error;
        },
      },
      runOptions
    );
    collectChanges();
    if (callbackError) throw callbackError;
    const completed = completion ?? result;
    const publicResult = eventTextSanitizer
      ? eventTextSanitizer(completed.result)
      : completed.result;
    completeActivity(ctx, publicResult);
    events.turnComplete({ ...eventBase, text: publicResult });
    callbacks.onComplete?.(completed);
    return result;
  } catch (e) {
    collectChanges();
    if (!errorEmitted) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === CANCEL_MESSAGE) {
        abortActivity(ctx);
        events.turnAborted(eventBase);
      } else {
        errorActivity(ctx, msg);
        events.agentError({ ...eventBase, message: msg });
      }
    }
    errorEmitted = true;
    callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
    throw e;
  } finally {
    releaseSession();
  }
}
