import { randomUUID } from 'node:crypto';

export interface UserQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
  allowFreeText: boolean;
}
export interface UserInputRequest {
  questions: UserQuestion[];
}
export type UserInputAnswer = { cancelled: true } | { answers: Record<string, string[]> };
export type UserInputTimeoutAction = 'reply' | 'stop';
export type UserInputResult =
  UserInputAnswer | { cancelled: true; timedOut: true } | { unavailable: true; message?: string };
export const USER_UNAVAILABLE_NOTICE =
  '[System notice: no user answer] The user is currently unable to respond. ' +
  'Continue the already authorized work using available information and clearly state any assumptions. ' +
  'Do not repeat this question or pause all work waiting for it. ' +
  'Never treat silence as a selected option, consent, or explicit authorization. ' +
  'Leave actions requiring explicit authorization pending and continue independent authorized work.';

/** Shared deadline for Web, Discord and Slack. Invalid values retain the default. */
export function userInputTimeoutMs(): number {
  const value = Number(process.env.AGENT_USER_INPUT_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 1000 && value <= 86_400_000 ? value : 600_000;
}
export function userInputTimeoutAction(): UserInputTimeoutAction {
  return process.env.AGENT_USER_INPUT_TIMEOUT_ACTION?.trim().toLowerCase() === 'stop'
    ? 'stop'
    : 'reply';
}
/** Web settings encode arbitrary multiline text in a single dotenv entry. */
export function decodeUserInputTimeoutMessage(value: string): string {
  if (!value.startsWith('json:')) return value;
  try {
    const decoded: unknown = JSON.parse(value.slice(5));
    return typeof decoded === 'string' ? decoded : '';
  } catch {
    return '';
  }
}
export function userInputTimeoutMessage(): string {
  const value = decodeUserInputTimeoutMessage(process.env.AGENT_USER_INPUT_TIMEOUT_MESSAGE || '');
  return value.trim() && value.length <= 4000 ? value : USER_UNAVAILABLE_NOTICE;
}
export function userInputTimeoutNotice(message = USER_UNAVAILABLE_NOTICE): string {
  if (message === USER_UNAVAILABLE_NOTICE) return message;
  return (
    '[System notice: no user answer] Configured automatic timeout reply:\n' +
    message +
    '\nThe user has not answered. This automatic reply is not a user selection, consent, or explicit authorization.'
  );
}
export function userInputTimeoutHint(action: UserInputTimeoutAction): string {
  return action === 'stop' ? '期限後は作業を停止します。' : '期限後は未回答として作業を続けます。';
}
export function userInputWaitLabel(expiresAt: number): string {
  const seconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  return seconds % 60 === 0 ? `${seconds / 60}分` : `${seconds}秒`;
}
export type UserInputCallback = (
  request: UserInputRequest,
  signal: AbortSignal
) => Promise<UserInputResult>;
export interface PendingUserInput extends UserInputRequest {
  id: string;
  expiresAt: number;
  timeoutAction: UserInputTimeoutAction;
}
interface Entry {
  scope: string;
  actor: string;
  request: PendingUserInput;
  finish: (answer: UserInputResult) => void;
}
const pending = new Map<string, Entry>();
export const userInputEnabled = () => process.env.AGENT_USER_INPUT !== 'false';

/** Strictly bounded provider data. Never render provider HTML or silently select defaults. */
export function normalizeQuestions(value: unknown, _provider: 'codex'): UserInputRequest {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    throw new Error('Invalid questions');
  const seen = new Set<string>();
  const text = (v: unknown, max: number) => {
    if (typeof v !== 'string' || !v.trim() || v.length > max)
      throw new Error('Invalid question text');
    return v;
  };
  return {
    questions: value.map((v) => {
      if (!v || typeof v !== 'object') throw new Error('Invalid question');
      const q = v as Record<string, unknown>;
      const id = text(q.id, 200);
      if (seen.has(id)) throw new Error('Duplicate question');
      seen.add(id);
      const options = q.options == null ? [] : q.options;
      if (!Array.isArray(options) || options.length > 20) throw new Error('Invalid options');
      return {
        id,
        header: typeof q.header === 'string' ? q.header.slice(0, 80) : '',
        question: text(q.question, 2000),
        options: options.map((o: unknown) => {
          if (!o || typeof o !== 'object') throw new Error('Invalid option');
          const option = o as Record<string, unknown>;
          return {
            label: text(option.label, 100),
            description:
              typeof option.description === 'string' ? option.description.slice(0, 500) : '',
          };
        }),
        multiSelect: false,
        allowFreeText: q.isOther === true || options.length === 0,
      };
    }),
  };
}
export function validateAnswer(request: UserInputRequest, value: unknown): UserInputAnswer {
  if (!value || typeof value !== 'object') throw new Error('回答が不正です');
  if ('cancelled' in value && value.cancelled === true) return { cancelled: true };
  const answers = (value as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers))
    throw new Error('回答を入力してください');
  const result: Record<string, string[]> = Object.create(null);
  for (const q of request.questions) {
    const a = (answers as Record<string, unknown>)[q.id];
    if (
      !Array.isArray(a) ||
      !a.length ||
      a.length > 20 ||
      (!q.multiSelect && a.length !== 1) ||
      a.some(
        (v) =>
          typeof v !== 'string' ||
          !v.trim() ||
          v.length > 2000 ||
          (!q.allowFreeText && !q.options.some((o) => o.label === v))
      )
    ) {
      throw new Error('各質問に有効な回答を入力してください');
    }
    result[q.id] = [...new Set(a)] as string[];
  }
  return { answers: result };
}
export function listUserInputs(scope: string, actor: string): PendingUserInput[] {
  return [...pending.values()]
    .filter((e) => e.scope === scope && e.actor === actor)
    .map((e) => e.request);
}
export function answerUserInput(id: string, scope: string, actor: string, answer: unknown): void {
  const entry = pending.get(id);
  if (!entry || entry.scope !== scope || entry.actor !== actor)
    throw new Error('質問は終了済みか、回答権限がありません');
  entry.finish(validateAnswer(entry.request, answer));
}
export async function requestUserInput(
  scope: string,
  actor: string,
  request: UserInputRequest,
  signal: AbortSignal,
  present: (request: PendingUserInput) => Promise<void>
): Promise<UserInputResult> {
  if (signal.aborted) return { cancelled: true };
  const id = randomUUID();
  const expiresAt = Date.now() + userInputTimeoutMs();
  const timeoutAction = userInputTimeoutAction();
  const message = userInputTimeoutMessage();
  let finish!: (answer: UserInputResult) => void;
  const result = new Promise<UserInputResult>((resolve) => {
    finish = (answer) => {
      pending.delete(id);
      resolve(answer);
    };
  });
  const cancel = () => finish({ cancelled: true });
  const timer = setTimeout(
    () =>
      finish(
        timeoutAction === 'stop'
          ? { cancelled: true, timedOut: true }
          : { unavailable: true, message }
      ),
    expiresAt - Date.now()
  );
  signal.addEventListener('abort', cancel, { once: true });
  const entry = { scope, actor, request: { ...request, id, expiresAt, timeoutAction }, finish };
  pending.set(id, entry);
  try {
    await present(entry.request);
    return await result;
  } finally {
    pending.delete(id);
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
