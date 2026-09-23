import type { Api } from 'grammy';
import type { ReactionTypeEmoji } from '@grammyjs/types';

export const TELEGRAM_REACTION_EMOJIS = [
  '👍',
  '👎',
  '❤',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🤔',
  '🤯',
  '😱',
  '🤬',
  '😢',
  '🎉',
  '🤩',
  '🤮',
  '💩',
  '🙏',
  '👌',
  '🕊',
  '🤡',
  '🥱',
  '🥴',
  '😍',
  '🐳',
  '❤‍🔥',
  '🌚',
  '🌭',
  '💯',
  '🤣',
  '⚡',
  '🍌',
  '🏆',
  '💔',
  '🤨',
  '😐',
  '🍓',
  '🍾',
  '💋',
  '🖕',
  '😈',
  '😴',
  '😭',
  '🤓',
  '👻',
  '👨‍💻',
  '👀',
  '🎃',
  '🙈',
  '😇',
  '😨',
  '🤝',
  '✍',
  '🤗',
  '🫡',
  '🎅',
  '🎄',
  '☃',
  '💅',
  '🤪',
  '🗿',
  '🆒',
  '💘',
  '🙉',
  '🦄',
  '😘',
  '💊',
  '🙊',
  '😎',
  '👾',
  '🤷‍♂',
  '🤷',
  '🤷‍♀',
  '😡',
] as const satisfies readonly ReactionTypeEmoji['emoji'][];

const allowedReactions = new Set<string>(TELEGRAM_REACTION_EMOJIS);

export function parseTelegramReaction(
  value: string | undefined,
  fallback: string,
  warn: (message: string) => void
): ReactionTypeEmoji['emoji'] | undefined {
  const emoji = value === undefined ? fallback : value.trim();
  if (!emoji) return undefined;
  if (allowedReactions.has(emoji)) return emoji as ReactionTypeEmoji['emoji'];
  warn('Unsupported Telegram reaction; disabling it');
  return undefined;
}

function isDefiniteTelegramFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return (record.error_code ?? record.statusCode ?? record.status) === 400;
}

export async function sendTelegramControlReply(
  api: Pick<Api, 'sendMessage'>,
  chatId: number,
  userId: number,
  chatType: string,
  messageThreadId: number | undefined,
  text: string,
  ephemeralEnabled: boolean
): Promise<void> {
  const options = messageThreadId === undefined ? {} : { message_thread_id: messageThreadId };
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (ephemeralEnabled && isGroup) {
    try {
      await api.sendMessage(chatId, text, {
        ...options,
        ephemeral_message_parameters: { receiver_user_id: userId },
      });
      return;
    } catch (error) {
      if (!isDefiniteTelegramFailure(error)) throw error;
    }
  }
  await api.sendMessage(chatId, text, options);
}

export function createTelegramReactionTracker(
  api: Pick<Api, 'setMessageReaction'>,
  chatId: number,
  messageId: number,
  ack: ReactionTypeEmoji['emoji'] | undefined,
  done: ReactionTypeEmoji['emoji'] | undefined,
  warn: (error: unknown) => void
): { finish(success: boolean): Promise<void> } {
  if (!ack) return { finish: async () => {} };
  const initial = Promise.resolve()
    .then(() => api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: ack }]))
    .catch(warn);
  let finished = false;
  return {
    async finish(success: boolean) {
      if (finished) return;
      finished = true;
      await initial;
      if (success && !done) return;
      await Promise.resolve()
        .then(() =>
          api.setMessageReaction(
            chatId,
            messageId,
            success && done ? [{ type: 'emoji', emoji: done }] : []
          )
        )
        .catch(warn);
    },
  };
}
