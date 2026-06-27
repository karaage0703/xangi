import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // 環境変数をリセット
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw error when no tokens are set', async () => {
    delete process.env.DISCORD_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.WEB_CHAT_ENABLED;

    // キャッシュをクリアして再インポート
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('DISCORD_TOKEN');
  });

  it('should not throw when only WebChat is explicitly enabled', async () => {
    delete process.env.DISCORD_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    process.env.WEB_CHAT_ENABLED = 'true';

    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).not.toThrow();
  });

  it('should load Discord config when DISCORD_TOKEN is set', async () => {
    process.env.DISCORD_TOKEN = 'test-discord-token';
    process.env.DISCORD_ALLOWED_USER = '123456789';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.enabled).toBe(true);
    expect(config.discord.token).toBe('test-discord-token');
    expect(config.discord.allowedUsers).toContain('123456789');
  });

  it('should default Discord completion notifications to message after 10 seconds', async () => {
    process.env.DISCORD_TOKEN = 'test-discord-token';
    delete process.env.DISCORD_COMPLETION_NOTIFY;
    delete process.env.DISCORD_COMPLETION_NOTIFY_AFTER_MS;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.completionNotifyMode).toBe('message');
    expect(config.discord.completionNotifyAfterMs).toBe(10_000);
  });

  it('should allow disabling Discord completion notifications via env', async () => {
    process.env.DISCORD_TOKEN = 'test-discord-token';
    process.env.DISCORD_COMPLETION_NOTIFY = 'off';
    process.env.DISCORD_COMPLETION_NOTIFY_AFTER_MS = '60000';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.completionNotifyMode).toBe('off');
    expect(config.discord.completionNotifyAfterMs).toBe(60_000);
  });

  it('should default Discord replyInThread to false', async () => {
    process.env.DISCORD_TOKEN = 'test-discord-token';
    delete process.env.DISCORD_REPLY_IN_THREAD;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.replyInThread).toBe(false);
  });

  it('should enable Discord replyInThread when DISCORD_REPLY_IN_THREAD=true', async () => {
    process.env.DISCORD_TOKEN = 'test-discord-token';
    process.env.DISCORD_REPLY_IN_THREAD = 'true';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.replyInThread).toBe(true);
  });

  it('should default to claude-code backend', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.AGENT_BACKEND;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.agent.backend).toBe('claude-code');
  });

  it('should allow all backends when ALLOWED_BACKENDS is unset', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.ALLOWED_BACKENDS;

    const { ALL_AGENT_BACKENDS, loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.agent.allowedBackends).toEqual([...ALL_AGENT_BACKENDS]);
  });

  it('should accept codex backend', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.AGENT_BACKEND = 'codex';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.agent.backend).toBe('codex');
  });

  it('should accept cursor backend', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.AGENT_BACKEND = 'cursor';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.agent.backend).toBe('cursor');
  });

  it('should accept grok backend', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.AGENT_BACKEND = 'grok';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.agent.backend).toBe('grok');
  });

  it('should throw error for invalid backend', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.AGENT_BACKEND = 'invalid';

    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('Invalid AGENT_BACKEND');
  });

  it('should reject removed gemini backend', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.AGENT_BACKEND = 'gemini';

    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('Invalid AGENT_BACKEND');
  });

  it('should enable scheduler and startup by default', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.STARTUP_ENABLED;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.scheduler.enabled).toBe(true);
    expect(config.scheduler.startupEnabled).toBe(true);
  });

  it('should disable scheduler when SCHEDULER_ENABLED=false', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.SCHEDULER_ENABLED = 'false';
    process.env.STARTUP_ENABLED = 'false';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.scheduler.enabled).toBe(false);
    expect(config.scheduler.startupEnabled).toBe(false);
  });

  it('should enable allowAutoreplyCommand by default', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.ALLOW_AUTOREPLY_COMMAND;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.allowAutoreplyCommand).toBe(true);
  });

  it('should enable allowAutoreplyCommand when ALLOW_AUTOREPLY_COMMAND=true', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.ALLOW_AUTOREPLY_COMMAND = 'true';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.allowAutoreplyCommand).toBe(true);
  });

  it('should disable allowAutoreplyCommand when ALLOW_AUTOREPLY_COMMAND=false', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.ALLOW_AUTOREPLY_COMMAND = 'false';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.allowAutoreplyCommand).toBe(false);
  });

  it('should default respondToBots to empty array', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.RESPOND_TO_BOTS;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.respondToBots).toEqual([]);
  });

  it('should parse RESPOND_TO_BOTS as comma-separated list', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.RESPOND_TO_BOTS = '111,222 , 333';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.respondToBots).toEqual(['111', '222', '333']);
  });

  it('should parse RESPOND_TO_BOTS=* as wildcard', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.RESPOND_TO_BOTS = '*';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.respondToBots).toEqual(['*']);
  });

  it('should default respondToBotsEnabled to false', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.RESPOND_TO_BOTS_ENABLED;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.respondToBotsEnabled).toBe(false);
  });

  it('should set respondToBotsEnabled=true when RESPOND_TO_BOTS_ENABLED=true', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.RESPOND_TO_BOTS_ENABLED = 'true';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.respondToBotsEnabled).toBe(true);
  });

  it('should keep respondToBotsEnabled=false when RESPOND_TO_BOTS_ENABLED=false', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.RESPOND_TO_BOTS_ENABLED = 'false';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.respondToBotsEnabled).toBe(false);
  });

  it('should default respondToBotsMaxConsecutive to 3', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.RESPOND_TO_BOTS_MAX_CONSECUTIVE;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.respondToBotsMaxConsecutive).toBe(3);
  });

  it('should parse RESPOND_TO_BOTS_MAX_CONSECUTIVE as integer', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.RESPOND_TO_BOTS_MAX_CONSECUTIVE = '10';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.respondToBotsMaxConsecutive).toBe(10);
  });

  it('should allow respondToBotsMaxConsecutive=0 for unlimited', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.RESPOND_TO_BOTS_MAX_CONSECUTIVE = '0';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.respondToBotsMaxConsecutive).toBe(0);
  });

  it('should enable allowRespondToBotsCommand by default', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.ALLOW_RESPOND_TO_BOTS_COMMAND;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.allowRespondToBotsCommand).toBe(true);
  });

  it('should disable allowRespondToBotsCommand when ALLOW_RESPOND_TO_BOTS_COMMAND=false', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.ALLOW_RESPOND_TO_BOTS_COMMAND = 'false';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.allowRespondToBotsCommand).toBe(false);
  });

  it('should enable skipPermissions by default', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.SKIP_PERMISSIONS;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.agent.config.skipPermissions).toBe(true);
  });

  it('should enable skipPermissions when SKIP_PERMISSIONS=true', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.SKIP_PERMISSIONS = 'true';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.agent.config.skipPermissions).toBe(true);
  });

  it('should disable skipPermissions when SKIP_PERMISSIONS=false', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.SKIP_PERMISSIONS = 'false';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.agent.config.skipPermissions).toBe(false);
  });
});
