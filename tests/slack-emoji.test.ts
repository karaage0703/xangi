import { describe, expect, it } from 'vitest';
import { renderSlackEmojiAliases } from '../src/slack-emoji.js';

describe('renderSlackEmojiAliases', () => {
  it('renders standard Slack emoji aliases', () => {
    expect(renderSlackEmojiAliases('こんにちは :dolphin:')).toBe('こんにちは 🐬');
  });

  it('keeps unknown aliases and Markdown code unchanged', () => {
    expect(
      renderSlackEmojiAliases(':custom_team_emoji: `:dolphin:`\n```txt\n:smile:\n```')
    ).toBe(':custom_team_emoji: `:dolphin:`\n```txt\n:smile:\n```');
  });
});
