import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { slackApi } from '../src/cli/slack-api.js';

const originalFetch = globalThis.fetch;
const originalToken = process.env.SLACK_BOT_TOKEN;
const originalUserToken = process.env.SLACK_USER_TOKEN;
const originalChannel = process.env.XANGI_CHANNEL_ID;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('slackApi', () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    delete process.env.XANGI_CHANNEL_ID;
    process.env.SLACK_USER_TOKEN = 'xoxp-test-user';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = originalToken;
    }
    if (originalChannel === undefined) {
      delete process.env.XANGI_CHANNEL_ID;
    } else {
      process.env.XANGI_CHANNEL_ID = originalChannel;
    }
    if (originalUserToken === undefined) delete process.env.SLACK_USER_TOKEN;
    else process.env.SLACK_USER_TOKEN = originalUserToken;
    vi.restoreAllMocks();
  });

  it('slack_send posts JSON to chat.postMessage', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, channel: 'C123', ts: '1.0001' }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await slackApi('slack_send', {
      channel: 'C123',
      message: 'hello',
      'thread-ts': '1.0000',
    });

    expect(result).toContain('ts: 1.0001');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://slack.com/api/chat.postMessage');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer xoxb-test-token',
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      channel: 'C123',
      text: 'hello',
      thread_ts: '1.0000',
    });
  });

  it.each([
    ['slack_send', { message: 'hello', 'thread-ts': '1.0000' }, 'chat.postMessage'],
    ['slack_edit', { content: 'updated', 'message-ts': '1.0001' }, 'chat.update'],
    ['slack_delete', { 'message-ts': '1.0001' }, 'chat.delete'],
  ])('%s uses the user token only when explicitly selected', async (command, flags, method) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock;
    delete process.env.SLACK_BOT_TOKEN;

    await slackApi(command, { ...flags, channel: 'C123', as: 'user' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://slack.com/api/${method}`);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer xoxp-test-user' });
    const body = JSON.parse(String(init?.body));
    expect(body.channel).toBe('C123');
    expect(body).not.toHaveProperty('as_user');
    expect(body).not.toHaveProperty('username');
    if (command === 'slack_send') expect(body.thread_ts).toBe('1.0000');
    else expect(body.ts).toBe('1.0001');
  });

  it.each(['slack_send', 'slack_edit', 'slack_delete'])(
    '%s rejects unknown identities before sending',
    async (command) => {
      const fetchMock = vi.fn<typeof fetch>();
      globalThis.fetch = fetchMock;
      await expect(
        slackApi(command, {
          channel: 'C123',
          message: 'hi',
          content: 'hi',
          'message-ts': '1',
          as: 'typo',
        })
      ).rejects.toThrow('--as must be bot or user');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, 'xoxb-wrong-token', 'xapp-wrong-token', 'xoxe-1-refresh-token'])(
    'rejects missing or non-user token %s without bot fallback',
    async (token) => {
      if (token === undefined) delete process.env.SLACK_USER_TOKEN;
      else process.env.SLACK_USER_TOKEN = token;
      const fetchMock = vi.fn<typeof fetch>();
      globalThis.fetch = fetchMock;
      await expect(
        slackApi('slack_send', {
          channel: 'C123',
          message: 'hi',
          as: 'user',
        })
      ).rejects.toThrow('SLACK_USER_TOKEN');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('accepts a rotated user access token', async () => {
    process.env.SLACK_USER_TOKEN = 'xoxe.xoxp-1-user-access';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock;
    await slackApi('slack_send', { channel: 'C123', message: 'hi', as: 'user' });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer xoxe.xoxp-1-user-access',
    });
  });

  it.each(['token_revoked', 'invalid_auth', 'missing_scope', 'token_expired'])(
    'does not retry as bot after user-token failure %s',
    async (error) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: false, error }));
      globalThis.fetch = fetchMock;
      await expect(
        slackApi('slack_send', {
          channel: 'C123',
          message: 'hi',
          as: 'user',
        })
      ).rejects.toThrow(error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
        Authorization: 'Bearer xoxp-test-user',
      });
    }
  );

  it.each(['slack_channels', 'slack_search'])(
    '%s rejects an identity flag rather than silently ignoring it',
    async (command) => {
      const fetchMock = vi.fn<typeof fetch>();
      globalThis.fetch = fetchMock;
      await expect(slackApi(command, { as: 'user' })).rejects.toThrow('--as is only supported');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('explicit bot identity keeps using the bot token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock;
    await slackApi('slack_send', { channel: 'C123', message: 'hi', as: 'bot' });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer xoxb-test-token',
    });
  });

  it('slack_send can resolve current channel from context', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, ts: '2.0001' }));
    globalThis.fetch = fetchMock as typeof fetch;

    await slackApi('slack_send', { message: 'hello' }, { channelId: 'CCTX' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ channel: 'CCTX' });
  });

  it('slack_channels lists conversations with default types', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        channels: [
          { id: 'C1', name: 'general', is_private: false },
          { id: 'G1', name: 'private-dev', is_private: true },
        ],
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await slackApi('slack_channels', {});

    expect(result).toContain('#general (C1, public)');
    expect(result).toContain('#private-dev (G1, private)');
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/conversations.list');
    expect(parsed.searchParams.get('types')).toBe('public_channel,private_channel');
    expect(parsed.searchParams.get('limit')).toBe('100');
  });

  it('slack_search filters conversations.history messages', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        messages: [
          { ts: '1719876543.000100', user: 'U1', text: 'PR ready' },
          { ts: '1719876544.000100', user: 'U2', text: 'other' },
        ],
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await slackApi('slack_search', { channel: 'C123', keyword: 'pr' });

    expect(result).toContain('PR ready');
    expect(result).not.toContain('other');
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/conversations.history');
    expect(parsed.searchParams.get('channel')).toBe('C123');
    expect(parsed.searchParams.get('limit')).toBe('15');
  });

  it('slack_edit accepts message-id alias for ts', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock as typeof fetch;

    await slackApi('slack_edit', {
      channel: 'C123',
      'message-id': '1719876543.000100',
      content: 'updated',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      channel: 'C123',
      ts: '1719876543.000100',
      text: 'updated',
    });
  });

  it('slack_delete calls chat.delete', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await slackApi('slack_delete', {
      channel: 'C123',
      'message-ts': '1719876543.000100',
    });

    expect(result).toContain('削除しました');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://slack.com/api/chat.delete');
    expect(JSON.parse(String(init?.body))).toEqual({
      channel: 'C123',
      ts: '1719876543.000100',
    });
  });

  it('throws ValidationError when channel is missing outside context', async () => {
    await expect(slackApi('slack_send', { message: 'hello' })).rejects.toThrow(
      'channel が未指定'
    );
  });

  it('throws Slack API errors', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: false, error: 'missing_scope' }));

    await expect(slackApi('slack_channels', {})).rejects.toThrow('missing_scope');
  });
});
