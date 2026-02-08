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

    // キャッシュをクリアして再インポート
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('DISCORD_TOKEN or SLACK_BOT_TOKEN');
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

  it('should default to claude-code backend', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.AGENT_BACKEND;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.agent.backend).toBe('claude-code');
  });

  it('should accept codex backend', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.AGENT_BACKEND = 'codex';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.agent.backend).toBe('codex');
  });

  it('should throw error for invalid backend', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.AGENT_BACKEND = 'invalid';

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
});
