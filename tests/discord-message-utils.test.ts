import { describe, expect, it } from 'vitest';
import type { Client } from 'discord.js';
import { fetchChannelMessages, fetchDiscordLinkContent } from '../src/discord/message-utils.js';

/** Minimal discord.js stand-in: channel mention expansion only needs `channels.fetch`. */
function channelMentionClient(content: string): Client {
  return {
    channels: {
      fetch: async () => ({
        name: 'dev',
        messages: {
          fetch: async () => [{ createdAt: new Date(0), author: { tag: 'alice' }, content }],
        },
      }),
    },
  } as unknown as Client;
}

/** Minimal discord.js stand-in: one message fetched by ID for message links. */
function messageLinkClient(content: string): Client {
  return {
    channels: {
      fetch: async () => ({
        name: 'dev',
        messages: {
          fetch: async () => ({
            author: { tag: 'bob' },
            content,
            attachments: { size: 0, map: () => [] },
          }),
        },
      }),
    },
  } as unknown as Client;
}

describe('Discord quote expansion', () => {
  it('keeps $ replacement patterns in a quoted channel message literal', async () => {
    const content = "it's $' and $& and $` and $$";
    const result = await fetchChannelMessages(channelMentionClient(content), 'quote <#111> please');

    expect(result).toContain(`alice: ${content}`);
    expect(result.startsWith('quote ')).toBe(true);
    expect(result.endsWith('\n---\n please')).toBe(true);
    expect(result.match(/ please/gu)).toHaveLength(1);
  });

  it('keeps $ replacement patterns in a quoted linked message literal', async () => {
    const content = "use $& and $' here";
    const result = await fetchDiscordLinkContent(
      messageLinkClient(content),
      'see https://discord.com/channels/1/2/3 now'
    );

    expect(result).toContain(`bob):\n${content}`);
    expect(result.startsWith('see ')).toBe(true);
    expect(result.endsWith('\n---\n now')).toBe(true);
    expect(result).not.toContain('https://discord.com/channels/1/2/3');
  });
});
