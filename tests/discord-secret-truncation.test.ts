import { describe, it, expect, vi, afterEach } from 'vitest';
import { discordApi } from '../src/cli/discord-api.js';
import { SECRET_AI_WARNING } from '../src/secret-filter.js';

const credential = 'DUMMY_KNOWN_PASSWORD_31R+/"\\Ω';
const commands = ['discord_history', 'discord_search'];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mockMessage(content: string): void {
  vi.stubEnv('DISCORD_TOKEN', credential);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 'message',
              content,
              author: { id: 'user', username: 'fixture', discriminator: '0' },
              timestamp: '2026-01-01T00:00:00Z',
              attachments: [],
            },
          ]),
          { status: 200 }
        )
    )
  );
}

describe.each(commands)('%s masks before shortening message bodies', (command) => {
  it.each([180, 190, 199, 200])(
    'does not disclose a secret starting at character %i',
    async (position) => {
      const prefix = 'x'.repeat(position);
      mockMessage(`${prefix}${credential} after`);
      const output = await discordApi(command, { channel: 'channel', keyword: 'after' });
      expect(output).not.toContain(credential);
      expect(output).toContain(SECRET_AI_WARNING);
      if (position < 200) {
        const previouslyLeakedPart = credential.slice(0, 200 - position);
        expect(output).not.toContain(prefix + previouslyLeakedPart);
        // The preview begins the replacement, even when just one character fits.
        expect(output).toContain(prefix + '[');
      } else {
        expect(output).toContain(prefix);
        expect(output).not.toContain(prefix + '[');
      }
    }
  );

  it.each([
    ['JSON-escaped', JSON.stringify(credential).slice(1, -1)],
    ['URL-encoded', encodeURIComponent(credential)],
  ])('masks %s known values before shortening', async (_name, representation) => {
    const prefix = 'x'.repeat(190);
    mockMessage(`${prefix}${representation} after`);
    const output = await discordApi(command, { channel: 'channel', keyword: 'after' });
    expect(output).not.toContain(prefix + representation.slice(0, 10));
    expect(output).toContain(prefix + '[REDACTED_');
  });

  it('keeps the existing 200-character preview for ordinary content', async () => {
    mockMessage('n'.repeat(210) + ' after');
    const output = await discordApi(command, { channel: 'channel', keyword: 'after' });
    expect(output).toContain('n'.repeat(200));
    expect(output).not.toContain('n'.repeat(201));
  });
});
