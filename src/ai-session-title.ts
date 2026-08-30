import type { AgentRunner, RunOptions } from './agent-runner.js';
import {
  stripPromptMetadata,
  stripUserPromptHookContexts,
  truncateSessionTitle,
} from './session-title.js';

const TITLE_TIMEOUT_MS = 10_000;
const inFlight = new Set<string>();

export const AI_SESSION_TITLE_PROMPT = `Generate a concise title for the user's message.
Use the same language as the user. Describe the actual subject, not generic wording such as "question" or "request".
Return only the title as plain text, with no quotes, markdown, explanation, or trailing punctuation.
Keep it within 50 characters.

User message:
`;

export function normalizeAiSessionTitle(raw: string): string {
  const firstLine = raw
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.replace(/^["'`「『]+|["'`」』]+$/g, '')
    .replace(/[。．.!！?？]+$/g, '')
    .trim();
  if (
    /^(?:LLMエラー\s*[:：]|LLM(?:サーバー|との)|エラー\s*[:：]|error\s*[:：]|timeout\s*[:：]|タイムアウト\s*[:：]|ごめん、うまく応答)/i.test(
      firstLine || ''
    )
  ) {
    return '';
  }
  return truncateSessionTitle(firstLine || '');
}

export interface StartAiSessionTitleOptions {
  runner: AgentRunner;
  appSessionId: string;
  userText: string;
  runOptions: Pick<
    RunOptions,
    | 'settingsChannelId'
    | 'platform'
    | 'defaultBackend'
    | 'defaultModel'
    | 'defaultEffort'
    | 'workdir'
  >;
  onTitle: (title: string) => void | Promise<void>;
  timeoutMs?: number;
}

export type GenerateAiSessionTitleOptions = Omit<StartAiSessionTitleOptions, 'onTitle'>;

/** AIタイトルを1件生成する。明示的な再生成など、完了を待つ経路で使う。 */
export async function generateAiSessionTitle(
  options: GenerateAiSessionTitleOptions
): Promise<string> {
  const userText = stripUserPromptHookContexts(stripPromptMetadata(options.userText)).trim();
  if (!userText) throw new Error('empty user text');

  const runKey = `session-title:${options.appSessionId}`;
  const timeoutMs = options.timeoutMs ?? TITLE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        options.runner.cancel?.(runKey);
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const result = await Promise.race([
      options.runner.run(`${AI_SESSION_TITLE_PROMPT}${userText}`, {
        ...options.runOptions,
        channelId: runKey,
        runnerKey: runKey,
        defaultLocalLlmMode: 'chat',
        localLlmMode: 'chat',
        skipPermissions: true,
        internalTask: true,
        userText,
      }),
      timeout,
    ]);
    const title = normalizeAiSessionTitle(result.result);
    if (!title) throw new Error('empty title');
    return title;
  } finally {
    if (timer) clearTimeout(timer);
    options.runner.destroy?.(runKey);
  }
}

/**
 * 初回ターンと並行してAIタイトルを生成する。呼び出し側はawaitせず、本編を優先する。
 * 失敗時は既存prefixを維持し、会話本体へ例外を伝播しない。
 */
export function startAiSessionTitle(options: StartAiSessionTitleOptions): boolean {
  if (inFlight.has(options.appSessionId)) return false;

  const userText = stripUserPromptHookContexts(stripPromptMetadata(options.userText)).trim();
  if (!userText) return false;

  inFlight.add(options.appSessionId);

  void (async () => {
    try {
      const title = await generateAiSessionTitle(options);
      await options.onTitle(title);
    } catch (error) {
      console.warn(
        `[session-title] AI title generation failed for ${options.appSessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      inFlight.delete(options.appSessionId);
    }
  })();

  return true;
}
