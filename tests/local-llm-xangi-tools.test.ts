import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getXangiTools } from '../src/local-llm/xangi-tools.js';

function names(platform?: Parameters<typeof getXangiTools>[0]): string[] {
  return getXangiTools(platform).map((tool) => tool.name);
}

describe('Local LLM xangi tools by platform', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, XANGI_SELF_LIFECYCLE: 'restart-only' };
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.BACKEND_SWITCHING_ENABLED;
    delete process.env.RUNTIME_SETTINGS_ENABLED;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('web sessions expose web_history but not Discord tools', () => {
    const toolNames = names('web');

    expect(toolNames).toContain('web_history');
    expect(toolNames).toContain('media_send');
    expect(toolNames).toContain('web_status');
    expect(toolNames).toContain('runtime_settings');
    expect(toolNames).toContain('extension_uninstall');
    expect(toolNames).not.toContain('discord_history');
    expect(toolNames).not.toContain('discord_send');
    expect(toolNames).not.toContain('slack_history');
  });

  it('Discord sessions expose Discord tools but not web_history', () => {
    const toolNames = names('discord');

    expect(toolNames).toContain('discord_history');
    expect(toolNames).toContain('discord_message');
    expect(toolNames).toContain('discord_send');
    expect(toolNames).toContain('web_status');
    expect(toolNames).toContain('runtime_settings');
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
    expect(toolNames).toContain('runtime_settings');
    expect(toolNames).not.toContain('discord_history');
    expect(toolNames).not.toContain('discord_message');
    expect(toolNames).not.toContain('discord_send');
    expect(toolNames).not.toContain('web_history');
  });

  it('Telegram sessions expose only common schedule and system tools', () => {
    const toolNames = names('telegram');

    expect(toolNames).toContain('schedule_add');
    expect(toolNames).toContain('schedule_update');
    expect(toolNames).toContain('system_restart');
    expect(toolNames).not.toContain('discord_history');
    expect(toolNames).not.toContain('slack_history');
    expect(toolNames).not.toContain('web_history');
  });

  it('exposes schedule_update with only id required', () => {
    const tool = getXangiTools('discord').find((candidate) => candidate.name === 'schedule_update');
    expect(tool).toBeDefined();
    expect(tool!.parameters.required).toEqual(['id']);
    expect(tool!.parameters.properties).toMatchObject({
      id: { type: 'string' },
      input: { type: 'string' },
      message: { type: 'string' },
      channel: { type: 'string' },
      platform: { enum: ['discord', 'slack', 'telegram', 'web'] },
    });
  });

  it('omits disabled scheduler, lifecycle, and runtime settings tools', () => {
    process.env.SCHEDULER_ENABLED = 'false';
    process.env.XANGI_SELF_LIFECYCLE = 'off';
    process.env.BACKEND_SWITCHING_ENABLED = 'false';
    process.env.RUNTIME_SETTINGS_ENABLED = 'false';

    const toolNames = names('telegram');
    expect(toolNames).not.toContain('schedule_list');
    expect(toolNames).not.toContain('schedule_add');
    expect(toolNames).not.toContain('system_restart');
    expect(toolNames).not.toContain('runtime_settings');
  });

  it('exposes parent-owned extension_uninstall on every platform', () => {
    for (const platform of ['web', 'discord', 'slack', 'telegram'] as const) {
      const tool = getXangiTools(platform).find(
        (candidate) => candidate.name === 'extension_uninstall'
      );
      expect(tool?.parameters.required).toEqual(['id']);
    }
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
