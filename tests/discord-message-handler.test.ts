import { describe, expect, it } from 'vitest';
import { shouldProcessDiscordMessage } from '../src/discord/message-handler.js';

describe('shouldProcessDiscordMessage', () => {
  it('processes normal messages', () => {
    expect(shouldProcessDiscordMessage({ system: false })).toBe(true);
  });

  it('does not process Discord system messages', () => {
    expect(shouldProcessDiscordMessage({ system: true })).toBe(false);
  });
});
