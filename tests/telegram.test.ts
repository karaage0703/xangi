import { describe, it, expect, vi } from 'vitest';
import {
  buildPromptWithContext,
  buildTelegramWebhookUrl,
  cleanMention,
  formatTelegramError,
  getTelegramRetryDelayMs,
  hasBotMention,
  hasOtherBotMention,
  isResetCommand,
  isRetryableTelegramError,
  normalizeTelegramWebhookPath,
  redactTelegramSecrets,
  retryTelegramEdit,
  retryTelegramOperation,
  shouldProcessMessage,
  shouldStreamTelegramResponse,
  TelegramBotLoopGuard,
} from '../src/telegram.js';

describe('Telegram webhook URL', () => {
  it('normalizes paths with and without a leading slash', () => {
    expect(normalizeTelegramWebhookPath()).toBe('/telegram/webhook');
    expect(normalizeTelegramWebhookPath('telegram/webhook')).toBe('/telegram/webhook');
    expect(normalizeTelegramWebhookPath('//telegram/webhook')).toBe('/telegram/webhook');
  });

  it('joins the public URL and webhook path with one slash', () => {
    expect(buildTelegramWebhookUrl('https://example.com/', 'telegram/webhook')).toBe(
      'https://example.com/telegram/webhook'
    );
  });
});

describe('buildPromptWithContext', () => {
  const human = { id: 1, is_bot: false, first_name: 'Alice', username: 'alice' };
  const bot = { id: 2, is_bot: true, first_name: 'Weather', username: 'weather_bot' };

  it('returns private chat text unchanged', () => {
    expect(buildPromptWithContext('hello', 'private', human, undefined, false, false)).toBe(
      'hello'
    );
  });

  it('labels a human group mention', () => {
    expect(buildPromptWithContext('hello', 'group', human, 'X', true, false)).toBe(
      '[グループ「X」 / ユーザー @alice からのメンション]\nhello'
    );
  });

  it('labels a bot group post', () => {
    expect(buildPromptWithContext('forecast', 'group', bot, 'X', false, false)).toBe(
      '[グループ「X」 / Bot @weather_bot からの投稿]\nforecast'
    );
  });

  it('falls back when the title and username are absent', () => {
    const sender = { id: 3, is_bot: false, first_name: 'Bob' };
    expect(buildPromptWithContext('reply', 'supergroup', sender, undefined, false, true)).toBe(
      '[グループ / ユーザー Bob からの返信]\nreply'
    );
  });
});

describe('Telegram API resilience', () => {
  const token = ['123456789', 'AAGQKx89NeOZO55ATltcdVCFq614NBLBsGQ'].join(':');

  it('redacts bot tokens from API URLs and standalone text', () => {
    const input = `request to https://api.telegram.org/bot${token}/getMe failed; token=${token}`;
    const redacted = redactTelegramSecrets(input);

    expect(redacted).not.toContain(token);
    expect(redacted).toContain('https://api.telegram.org/bot<redacted>/getMe');
    expect(redacted).toContain('<telegram-bot-token>');
  });

  it('formats nested network errors without leaking the token', () => {
    const fetchError = Object.assign(
      new Error(`request to https://api.telegram.org/bot${token}/getMe failed`),
      { code: 'ETIMEDOUT', errno: 'ETIMEDOUT' }
    );
    const error = Object.assign(new Error("Network request for 'getMe' failed!"), {
      error: fetchError,
    });

    const formatted = formatTelegramError(error);
    expect(formatted).toContain('code=ETIMEDOUT');
    expect(formatted).not.toContain(token);
  });

  it('retries network failures but not authentication failures', () => {
    const timeout = Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
    const unauthorized = { message: 'Unauthorized', error_code: 401 };
    const pollingConflict = { message: 'Conflict', error_code: 409 };

    expect(isRetryableTelegramError(timeout)).toBe(true);
    expect(isRetryableTelegramError(unauthorized)).toBe(false);
    expect(isRetryableTelegramError(pollingConflict)).toBe(false);
  });

  it('caps exponential backoff at 60 seconds', () => {
    expect(getTelegramRetryDelayMs(1, () => 0)).toBe(750);
    expect(getTelegramRetryDelayMs(20, () => 1)).toBe(60_000);
  });

  it('recovers after retryable startup failures', async () => {
    const timeout = Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(timeout)
      .mockResolvedValue('ok');
    const sleep = vi.fn(async () => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await expect(
        retryTelegramOperation('Bot API', operation, { sleep, random: () => 0 })
      ).resolves.toBe('ok');
      expect(operation).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith('[xangi-telegram] Bot API connection restored');
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it('treats message-not-modified after a timeout as a successful idempotent edit', async () => {
    const timeout = Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
    const notModified = {
      message: 'Bad Request: message is not modified',
      error_code: 400,
    };
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(notModified);
    const sleep = vi.fn(async () => undefined);

    await expect(retryTelegramEdit(operation, { sleep, random: () => 0 })).resolves.toEqual({
      ok: true,
    });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('bounds edit retries when the API remains unavailable', async () => {
    const timeout = Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(timeout);
    const sleep = vi.fn(async () => undefined);

    const result = await retryTelegramEdit(operation, {
      maxAttempts: 3,
      sleep,
      random: () => 0,
    });

    expect(result.ok).toBe(false);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe('TelegramBotLoopGuard', () => {
  it('limits consecutive bot turns only within the configured time window', () => {
    const guard = new TelegramBotLoopGuard(1_000);

    expect(guard.allow('chat-1', 'bot-1', 3, 0)).toBe(true);
    expect(guard.allow('chat-1', 'bot-1', 3, 100)).toBe(true);
    expect(guard.allow('chat-1', 'bot-1', 3, 200)).toBe(true);
    expect(guard.allow('chat-1', 'bot-1', 3, 300)).toBe(false);
    expect(guard.allow('chat-1', 'bot-1', 3, 1_200)).toBe(true);
  });

  it('isolates counters by chat and sender bot', () => {
    const guard = new TelegramBotLoopGuard(10_000);

    expect(guard.allow('chat-1', 'bot-1', 1, 0)).toBe(true);
    expect(guard.allow('chat-1', 'bot-1', 1, 1)).toBe(false);
    expect(guard.allow('chat-1', 'bot-2', 1, 1)).toBe(true);
    expect(guard.allow('chat-2', 'bot-1', 1, 1)).toBe(true);
  });

  it('resets every bot counter in a chat after a human message', () => {
    const guard = new TelegramBotLoopGuard(10_000);

    expect(guard.allow('chat-1', 'bot-1', 1, 0)).toBe(true);
    expect(guard.allow('chat-1', 'bot-1', 1, 1)).toBe(false);
    guard.resetChat('chat-1');
    expect(guard.allow('chat-1', 'bot-1', 1, 2)).toBe(true);
  });
});

describe('cleanMention', () => {
  it('removes bot mention and surrounding spaces', () => {
    expect(cleanMention('@xangi_bot hello', '@xangi_bot')).toBe('hello');
    expect(cleanMention('hello @xangi_bot', '@xangi_bot')).toBe('hello');
    expect(cleanMention('  @xangi_bot   hello   ', '@xangi_bot')).toBe('hello');
    expect(cleanMention('@xangi_bot', '@xangi_bot')).toBe('');
    expect(cleanMention('@XANGI_BOT hello', '@xangi_bot')).toBe('hello');
  });

  it('handles multiple mentions (if any)', () => {
    expect(cleanMention('@xangi_bot hello @xangi_bot world', '@xangi_bot')).toBe('hello world');
  });
});

describe('hasBotMention', () => {
  it('matches Telegram usernames case-insensitively', () => {
    expect(hasBotMention('@XANGI_BOT hello', 'xangi_bot')).toBe(true);
    expect(hasBotMention('hello', 'xangi_bot')).toBe(false);
  });
});

describe('group mention routing', () => {
  it('detects mentions directed to another bot', () => {
    expect(hasOtherBotMention('@weather_bot forecast', 'xangi_bot')).toBe(true);
    expect(hasOtherBotMention('@XANGI_BOT hello', 'xangi_bot')).toBe(false);
    expect(hasOtherBotMention('@alice hello', 'xangi_bot')).toBe(false);
    expect(hasOtherBotMention('@xangi_bot @weather_bot hello', 'xangi_bot')).toBe(true);
  });

  it('enables streaming only for private chats', () => {
    expect(shouldStreamTelegramResponse('private', true, true)).toBe(true);
    expect(shouldStreamTelegramResponse('group', true, true)).toBe(false);
    expect(shouldStreamTelegramResponse('supergroup', true, true)).toBe(false);
    expect(shouldStreamTelegramResponse('private', false, true)).toBe(false);
  });
});

describe('isResetCommand', () => {
  const defaultPatterns = ['/reset', '/new', '/clear'];

  it('matches exact commands case-insensitively', () => {
    expect(isResetCommand('/reset', defaultPatterns)).toBe(true);
    expect(isResetCommand('/RESET', defaultPatterns)).toBe(true);
    expect(isResetCommand('/new', defaultPatterns)).toBe(true);
    expect(isResetCommand('/clear', defaultPatterns)).toBe(true);
  });

  it('strips surrounding whitespace', () => {
    expect(isResetCommand('  /reset  ', defaultPatterns)).toBe(true);
    expect(isResetCommand('/new\n', defaultPatterns)).toBe(true);
  });

  it('does NOT match partial or different text', () => {
    expect(isResetCommand('/reset please', defaultPatterns)).toBe(false);
    expect(isResetCommand('please /reset', defaultPatterns)).toBe(false);
    expect(isResetCommand('reset', defaultPatterns)).toBe(false);
  });
});

describe('shouldProcessMessage', () => {
  const defaultBotInfo = { id: 100, username: 'xangi_bot' };
  const allowedUsers = ['111', '222'];
  const allowedBots = ['333'];
  const allowedChats = ['999'];
  const autoReplyChats = ['888'];

  it('disallows when from.id is the bot itself', () => {
    const res = shouldProcessMessage({
      from: { id: 100, is_bot: true },
      chat: { id: 123, type: 'private' },
      text: 'hello',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedBots,
    });
    expect(res).toBe(false);
  });

  it('allows user in allowedUsers list in private DM', () => {
    const res = shouldProcessMessage({
      from: { id: 111, is_bot: false },
      chat: { id: 123, type: 'private' },
      text: 'hello',
      botInfo: defaultBotInfo,
      allowedUsers,
    });
    expect(res).toBe(true);
  });

  it('disallows user not in allowedUsers list in private DM', () => {
    const res = shouldProcessMessage({
      from: { id: 999, is_bot: false },
      chat: { id: 123, type: 'private' },
      text: 'hello',
      botInfo: defaultBotInfo,
      allowedUsers,
    });
    expect(res).toBe(false);
  });

  it('allows anyone in allowedUsers list when allowAll is active (*)', () => {
    const res = shouldProcessMessage({
      from: { id: 999, is_bot: false },
      chat: { id: 123, type: 'private' },
      text: 'hello',
      botInfo: defaultBotInfo,
      allowedUsers: ['*'],
    });
    expect(res).toBe(true);
  });

  it('allows listed bot in allowedBots in private DM', () => {
    const res = shouldProcessMessage({
      from: { id: 333, is_bot: true },
      chat: { id: 123, type: 'private' },
      text: 'hello',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedBots,
    });
    expect(res).toBe(true);
  });

  it('disallows bot not in allowedBots list', () => {
    const res = shouldProcessMessage({
      from: { id: 444, is_bot: true },
      chat: { id: 123, type: 'private' },
      text: 'hello',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedBots,
    });
    expect(res).toBe(false);
  });

  it('disallows group chat not in allowedChats list', () => {
    const res = shouldProcessMessage({
      from: { id: 111, is_bot: false },
      chat: { id: 777, type: 'group' },
      text: '@xangi_bot hello',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedChats,
    });
    expect(res).toBe(false);
  });

  it('allows group chat in allowedChats list when bot is mentioned', () => {
    const res = shouldProcessMessage({
      from: { id: 111, is_bot: false },
      chat: { id: 999, type: 'group' },
      text: '@xangi_bot hello',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedChats,
    });
    expect(res).toBe(true);
  });

  it('allows a group mention with different username casing', () => {
    const res = shouldProcessMessage({
      from: { id: 111, is_bot: false },
      chat: { id: 999, type: 'group' },
      text: '@XANGI_BOT hello',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedChats,
    });
    expect(res).toBe(true);
  });

  it('ignores another bot mention even in an auto-reply chat', () => {
    const res = shouldProcessMessage({
      from: { id: 111, is_bot: false },
      chat: { id: 888, type: 'group' },
      text: '@weather_bot forecast',
      botInfo: defaultBotInfo,
      allowedUsers,
      autoReplyChats,
    });
    expect(res).toBe(false);
  });

  it('ignores a message that mentions both this bot and another bot', () => {
    const res = shouldProcessMessage({
      from: { id: 111, is_bot: false },
      chat: { id: 999, type: 'group' },
      text: '@xangi_bot ask @weather_bot',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedChats,
    });
    expect(res).toBe(false);
  });

  it('allows auto-reply chats without mention for human', () => {
    const res = shouldProcessMessage({
      from: { id: 111, is_bot: false },
      chat: { id: 888, type: 'group' },
      text: 'hello',
      botInfo: defaultBotInfo,
      allowedUsers,
      autoReplyChats,
    });
    expect(res).toBe(true);
  });

  it('allows replies to the bot in group chat for human', () => {
    const res = shouldProcessMessage({
      from: { id: 111, is_bot: false },
      chat: { id: 999, type: 'group' },
      text: 'reply to bot',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedChats,
      isReplyToMe: true,
    });
    expect(res).toBe(true);
  });

  it('ignores an allowed bot in a group without an explicit self mention', () => {
    const res = shouldProcessMessage({
      from: { id: 333, is_bot: true },
      chat: { id: 999, type: 'group' },
      text: 'bot message',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedBots,
      allowedChats,
    });
    expect(res).toBe(false);
  });

  it('ignores an allowed bot reply without an explicit self mention', () => {
    const res = shouldProcessMessage({
      from: { id: 333, is_bot: true },
      chat: { id: 999, type: 'group' },
      text: 'reply to bot',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedBots,
      allowedChats,
      isReplyToMe: true,
    });
    expect(res).toBe(false);
  });

  it('allows an allowed bot in a group when it explicitly mentions this bot', () => {
    const res = shouldProcessMessage({
      from: { id: 333, is_bot: true },
      chat: { id: 999, type: 'group' },
      text: '@xangi_bot bot message',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedBots,
      allowedChats,
    });
    expect(res).toBe(true);
  });

  it('disallows non-autoreply group chat without mention/reply for human', () => {
    const res = shouldProcessMessage({
      from: { id: 111, is_bot: false },
      chat: { id: 999, type: 'group' },
      text: 'just chatting',
      botInfo: defaultBotInfo,
      allowedUsers,
      allowedChats,
    });
    expect(res).toBe(false);
  });
});
