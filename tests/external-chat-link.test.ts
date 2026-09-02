import { describe, expect, it } from 'vitest';
import {
  discordChannelUrl,
  isAllowedExternalChatUrl,
  slackPermalinkTarget,
} from '../src/external-chat-link.js';

describe('external chat links', () => {
  it('builds Discord guild and direct-message channel URLs', () => {
    expect(discordChannelUrl('123', '456')).toBe('https://discord.com/channels/456/123');
    expect(discordChannelUrl('123')).toBe('https://discord.com/channels/@me/123');
    expect(discordChannelUrl('not-a-channel', '456')).toBeUndefined();
  });

  it('uses the Slack thread timestamp before a transcript message timestamp', () => {
    expect(slackPermalinkTarget('C123:1234.5678', '9999.0000')).toEqual({
      channel: 'C123',
      messageTs: '1234.5678',
    });
    expect(slackPermalinkTarget('C123', '9999.0000')).toEqual({
      channel: 'C123',
      messageTs: '9999.0000',
    });
    expect(slackPermalinkTarget('C123')).toBeUndefined();
  });

  it('allows only the expected HTTPS hosts', () => {
    expect(isAllowedExternalChatUrl('discord', 'https://discord.com/channels/1/2')).toBe(true);
    expect(isAllowedExternalChatUrl('slack', 'https://example.slack.com/archives/C1/p1')).toBe(
      true
    );
    expect(isAllowedExternalChatUrl('slack', 'http://example.slack.com/archives/C1/p1')).toBe(
      false
    );
    expect(isAllowedExternalChatUrl('discord', 'https://example.com/channels/1/2')).toBe(false);
  });
});
