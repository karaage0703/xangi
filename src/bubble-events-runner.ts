/**
 * `runner.runStream` を呼びつつ xangi-events (turn.started / message.delta /
 * turn.complete / turn.aborted / agent.error) を漏れなく発火するラッパー。
 *
 * 経緯: events.* は元々 web-chat / Discord / Slack の各呼び出し元で個別に
 * wiring されており、auto-talk では呼び忘れていたため xangi-pets に
 * バブルが届かなかった。共通化することで全 call site が同じ events 配信契約に
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

import { events, type Platform } from './events-emitter.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import {
  abortActivity,
  completeActivity,
  errorActivity,
  startActivity,
  updateActivityText,
  updateActivityTool,
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
  runner: AgentRunner,
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
  try {
    const runOptions = {
      ...options,
      platform: options?.platform ?? ctx.platform,
    };

    return await runner.runStream(
      prompt,
      {
        onBackendReady: () => callbacks.onBackendReady?.(),
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
          updateActivityTool(ctx, toolName, toolInput);
          callbacks.onToolUse?.(toolName, toolInput);
        },
        onComplete: (result) => {
          const publicResult = eventTextSanitizer
            ? eventTextSanitizer(result.result)
            : result.result;
          completeActivity(ctx, publicResult);
          events.turnComplete({ ...eventBase, text: publicResult });
          callbacks.onComplete?.(result);
        },
        onError: (error) => {
          if (error.message === CANCEL_MESSAGE) {
            abortActivity(ctx);
            events.turnAborted(eventBase);
          } else {
            errorActivity(ctx, error.message);
            events.agentError({ ...eventBase, message: error.message });
          }
          errorEmitted = true;
          callbacks.onError?.(error);
        },
      },
      runOptions
    );
  } catch (e) {
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
    throw e;
  }
}
