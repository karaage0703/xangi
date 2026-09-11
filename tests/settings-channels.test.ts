import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { WebClient } from '@slack/web-api';
import type { Client } from 'discord.js';
import {
  cacheSettingsChannelLister,
  createSlackSettingsWebClient,
  listSettingsChannelsWithTimeout,
  listDiscordSettingsChannels,
  listSlackSettingsChannels,
  SLACK_SETTINGS_WEB_CLIENT_OPTIONS,
  SettingsChannelListTimeoutError,
  settingsChannelListErrorMessage,
} from '../src/settings-channels.js';

describe('settings channel lists', () => {
  it('lists Discord text destinations by name without exposing IDs in labels', async () => {
    const client = {
      channels: {
        cache: new Map([
          [
            'channel-1',
            {
              id: 'channel-1',
              name: 'general',
              guildId: 'guild-1',
              guild: { name: 'Example Guild' },
              isTextBased: () => true,
              isThread: () => false,
            },
          ],
          [
            'voice-1',
            {
              id: 'voice-1',
              name: 'voice',
              guildId: 'guild-1',
              guild: { name: 'Example Guild' },
              isTextBased: () => false,
              isThread: () => false,
            },
          ],
          [
            'thread-1',
            {
              id: 'thread-1',
              name: 'discussion',
              guildId: 'guild-1',
              guild: { name: 'Example Guild' },
              isTextBased: () => true,
              isThread: () => true,
            },
          ],
        ]),
      },
    } as unknown as Client;

    await expect(listDiscordSettingsChannels(client)).resolves.toEqual([
      { id: 'channel-1', name: '#general', group: 'Example Guild' },
    ]);
  });

  it('lists Slack conversations joined by the bot across pages by name', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        channels: [{ id: 'C2', name: 'random' }],
        response_metadata: { next_cursor: 'next' },
      })
      .mockResolvedValueOnce({
        channels: [{ id: 'C1', name: 'general' }],
        response_metadata: { next_cursor: '' },
      });
    const client = { users: { conversations: list } } as unknown as WebClient;

    await expect(listSlackSettingsChannels(client)).resolves.toEqual([
      { id: 'C1', name: '#general' },
      { id: 'C2', name: '#random' },
    ]);
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 'next', exclude_archived: true })
    );
  });

  it('explains how to recover when Slack channel scopes are missing', () => {
    const error = Object.assign(new Error('An API error occurred: missing_scope'), {
      data: { error: 'missing_scope', needed: 'channels:read,groups:read' },
    });
    expect(settingsChannelListErrorMessage('slack', error)).toBe(
      'Slack Appの権限が不足しています。Bot Token Scopesへ channels:read / groups:read を追加し、ワークスペースへ再インストールしてから一覧を再読み込みしてください。'
    );
  });

  it('stops waiting when a channel lister never settles', async () => {
    vi.useFakeTimers();
    const pending = listSettingsChannelsWithTimeout(
      () => new Promise(() => undefined),
      25
    );
    const rejection = expect(pending).rejects.toBeInstanceOf(SettingsChannelListTimeoutError);

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    vi.useRealTimers();
  });

  it('shows an actionable message when Slack channel loading times out', () => {
    expect(settingsChannelListErrorMessage('slack', new SettingsChannelListTimeoutError())).toBe(
      'Slackチャンネル一覧の取得がタイムアウトしました。接続を確認してから再読み込みしてください。'
    );
  });

  it('does not let the Slack SDK continue retrying after a settings request ends', () => {
    expect(SLACK_SETTINGS_WEB_CLIENT_OPTIONS).toMatchObject({
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 8_000,
    });
  });

  it('rejects a Slack 429 response without starting an SDK retry chain', async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ ok: false, error: 'ratelimited' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
      const client = createSlackSettingsWebClient(
        'xoxb-test',
        `http://127.0.0.1:${address.port}/api/`
      );
      await expect(client.users.conversations()).rejects.toMatchObject({
        code: 'slack_webapi_rate_limited_error',
        retryAfter: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('shows the Slack retry-after delay when the API rate limits channel loading', () => {
    const error = Object.assign(new Error('rate limited'), {
      code: 'slack_webapi_rate_limited_error',
      retryAfter: 30,
    });
    expect(settingsChannelListErrorMessage('slack', error)).toBe(
      'Slack APIの呼び出し上限に達しました。30秒待ってから一覧を再読み込みしてください。'
    );
  });

  it('deduplicates concurrent Slack channel loads and caches successful results', async () => {
    vi.useFakeTimers();
    const source = vi.fn().mockResolvedValue([{ id: 'C1', name: '#general' }]);
    const cached = cacheSettingsChannelLister(source, 60_000);

    const [first, second] = await Promise.all([cached(), cached()]);
    expect(first).toEqual([{ id: 'C1', name: '#general' }]);
    expect(second).toEqual(first);
    expect(source).toHaveBeenCalledTimes(1);

    await cached();
    expect(source).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await cached();
    expect(source).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
