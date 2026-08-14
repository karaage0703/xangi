import { describe, expect, it } from 'vitest';
import { getXangiTools } from '../src/local-llm/xangi-tools.js';

function names(platform?: Parameters<typeof getXangiTools>[0]): string[] {
  return getXangiTools(platform).map((tool) => tool.name);
}

describe('Local LLM xangi tools by platform', () => {
  it('web sessions expose web_history but not Discord tools', () => {
    const toolNames = names('web');

    expect(toolNames).toContain('web_history');
    expect(toolNames).toContain('media_send');
    expect(toolNames).not.toContain('discord_history');
    expect(toolNames).not.toContain('discord_send');
    expect(toolNames).not.toContain('slack_history');
  });

  it('Discord sessions expose Discord tools but not web_history', () => {
    const toolNames = names('discord');

    expect(toolNames).toContain('discord_history');
    expect(toolNames).toContain('discord_message');
    expect(toolNames).toContain('discord_send');
    expect(toolNames).not.toContain('web_history');
    expect(toolNames).not.toContain('slack_history');
  });

  it('Slack sessions expose Slack tools but not Discord tools', () => {
    const toolNames = names('slack');

    expect(toolNames).toContain('slack_history');
    expect(toolNames).toContain('slack_send');
    expect(toolNames).toContain('slack_channels');
    expect(toolNames).toContain('slack_search');
    expect(toolNames).toContain('slack_edit');
    expect(toolNames).toContain('slack_delete');
    expect(toolNames).not.toContain('discord_history');
    expect(toolNames).not.toContain('discord_message');
    expect(toolNames).not.toContain('discord_send');
    expect(toolNames).not.toContain('web_history');
  });

  it('Telegram sessions expose only common schedule and system tools', () => {
    const toolNames = names('telegram');

    expect(toolNames).toContain('schedule_add');
    expect(toolNames).toContain('system_restart');
    expect(toolNames).not.toContain('discord_history');
    expect(toolNames).not.toContain('slack_history');
    expect(toolNames).not.toContain('web_history');
  });

  it('keeps the legacy all-platform set when platform is unknown', () => {
    const toolNames = names();

    expect(toolNames).toContain('discord_history');
    expect(toolNames).toContain('discord_message');
    expect(toolNames).toContain('web_history');
    expect(toolNames).toContain('slack_history');
    expect(toolNames).toContain('slack_search');
  });
});
