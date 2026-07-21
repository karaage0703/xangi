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

  it('loads safe Telegram media defaults and explicit overrides', async () => {
    process.env.WEB_CHAT_ENABLED = 'true';
    delete process.env.TELEGRAM_MEDIA_ENABLED;
    delete process.env.TELEGRAM_MEDIA_MAX_DOWNLOAD_MB;
    delete process.env.TELEGRAM_MEDIA_RETENTION_HOURS;
    delete process.env.TELEGRAM_MEDIA_ALLOWED_MIME;
    delete process.env.TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS;

    const { loadConfig } = await import('../src/config.js');
    const defaults = loadConfig().telegram;
    expect(defaults.mediaEnabled).toBe(false);
    expect(defaults.mediaMaxDownloadMb).toBe(20);
    expect(defaults.mediaRetentionHours).toBe(24);
    expect(defaults.mediaAllowedMimeTypes).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
    ]);
    expect(defaults.mediaGroupDebounceMs).toBe(750);

    process.env.TELEGRAM_MEDIA_ENABLED = 'true';
    process.env.TELEGRAM_MEDIA_MAX_DOWNLOAD_MB = '8';
    process.env.TELEGRAM_MEDIA_RETENTION_HOURS = '12';
    process.env.TELEGRAM_MEDIA_ALLOWED_MIME = 'image/*, video/mp4';
    process.env.TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = '1000';
    const overridden = loadConfig().telegram;
    expect(overridden.mediaEnabled).toBe(true);
    expect(overridden.mediaMaxDownloadMb).toBe(8);
    expect(overridden.mediaRetentionHours).toBe(12);
    expect(overridden.mediaAllowedMimeTypes).toEqual(['image/*', 'video/mp4']);
    expect(overridden.mediaGroupDebounceMs).toBe(1000);
  });

  it('disables Discord reply suggestions by default and supports overrides', async () => {
    process.env.DISCORD_TOKEN = 'test-discord-token';
    delete process.env.DISCORD_REPLY_SUGGESTIONS;
    delete process.env.DISCORD_REPLY_SUGGESTIONS_COUNT;

    const { loadConfig } = await import('../src/config.js');
    const defaults = loadConfig();
    expect(defaults.discord.replySuggestions).toBe(false);
    expect(defaults.discord.replySuggestionCount).toBe(3);

    process.env.DISCORD_REPLY_SUGGESTIONS = 'true';
    process.env.DISCORD_REPLY_SUGGESTIONS_COUNT = '5';
    const overridden = loadConfig();
    expect(overridden.discord.replySuggestions).toBe(true);
    expect(overridden.discord.replySuggestionCount).toBe(5);
  });

  it('disables Slack reply suggestions by default and supports overrides', async () => {
    process.env.WEB_CHAT_ENABLED = 'true';
    delete process.env.SLACK_REPLY_SUGGESTIONS;
    delete process.env.SLACK_REPLY_SUGGESTIONS_COUNT;

    const { loadConfig } = await import('../src/config.js');
    const defaults = loadConfig();
    expect(defaults.slack.replySuggestions).toBe(false);
    expect(defaults.slack.replySuggestionCount).toBe(3);

    process.env.SLACK_REPLY_SUGGESTIONS = 'true';
    process.env.SLACK_REPLY_SUGGESTIONS_COUNT = '5';
    const overridden = loadConfig();
    expect(overridden.slack.replySuggestions).toBe(true);
    expect(overridden.slack.replySuggestionCount).toBe(5);
  });

  it('disables Web reply suggestions by default and supports overrides', async () => {
    process.env.WEB_CHAT_ENABLED = 'true';
    delete process.env.WEB_REPLY_SUGGESTIONS;
    delete process.env.WEB_REPLY_SUGGESTIONS_COUNT;

    const { loadConfig } = await import('../src/config.js');
    const defaults = loadConfig();
    expect(defaults.web.replySuggestions).toBe(false);
    expect(defaults.web.replySuggestionCount).toBe(3);

    process.env.WEB_REPLY_SUGGESTIONS = 'true';
    process.env.WEB_REPLY_SUGGESTIONS_COUNT = '5';
    const overridden = loadConfig();
    expect(overridden.web.replySuggestions).toBe(true);
    expect(overridden.web.replySuggestionCount).toBe(5);
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

  it('should allow /threadmode command by default', async () => {
    process.env.DISCORD_TOKEN = 'test-discord-token';
    delete process.env.ALLOW_THREAD_MODE_COMMAND;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.allowThreadModeCommand).toBe(true);
  });

  it('should disable /threadmode command when ALLOW_THREAD_MODE_COMMAND=false', async () => {
    process.env.DISCORD_TOKEN = 'test-discord-token';
    process.env.ALLOW_THREAD_MODE_COMMAND = 'false';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.allowThreadModeCommand).toBe(false);
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

  it('should parse Slack reply-in-channel overrides as comma-separated list', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.SLACK_REPLY_IN_CHANNELS = 'C0AD8S0QCFP, C1234567890 ,, CABCDEF1234';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.slack.replyInChannels).toEqual(['C0AD8S0QCFP', 'C1234567890', 'CABCDEF1234']);
  });

  it('should configure Slack completion notification threshold', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.SLACK_COMPLETION_NOTIFY_AFTER_MS = '60000';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.slack.completionNotifyAfterMs).toBe(60_000);
  });

  it('should default Slack completion notification threshold to the Discord default value', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.DISCORD_COMPLETION_NOTIFY_AFTER_MS;
    delete process.env.SLACK_COMPLETION_NOTIFY_AFTER_MS;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.completionNotifyAfterMs).toBe(10_000);
    expect(config.slack.completionNotifyAfterMs).toBe(10_000);
  });

  it('should keep Slack completion notification threshold independent from Discord env', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.DISCORD_COMPLETION_NOTIFY_AFTER_MS = '45000';
    delete process.env.SLACK_COMPLETION_NOTIFY_AFTER_MS;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.discord.completionNotifyAfterMs).toBe(45_000);
    expect(config.slack.completionNotifyAfterMs).toBe(10_000);
  });

  it('should enable Slack reaction delete by default', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.SLACK_REACTION_DELETE_ENABLED;
    delete process.env.SLACK_DELETE_REACTIONS;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.slack.reactionDeleteEnabled).toBe(true);
    expect(config.slack.deleteReactions).toEqual(['wastebasket', 'x']);
  });

  it('should allow disabling Slack reaction delete', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.SLACK_REACTION_DELETE_ENABLED = 'false';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.slack.reactionDeleteEnabled).toBe(false);
  });

  it('should parse Slack delete reactions as comma-separated list', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.SLACK_DELETE_REACTIONS = 'wastebasket, x, xangi_delete ,,';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.slack.deleteReactions).toEqual(['wastebasket', 'x', 'xangi_delete']);
  });

  it('should enable first-turn history prefetch with 10 messages by default', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.HISTORY_PREFETCH_ENABLED;
    delete process.env.HISTORY_PREFETCH_COUNT;

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.historyPrefetch).toEqual({ enabled: true, count: 10 });
  });

  it('should configure or disable first-turn history prefetch', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.HISTORY_PREFETCH_ENABLED = 'false';
    process.env.HISTORY_PREFETCH_COUNT = '25';

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.historyPrefetch).toEqual({ enabled: false, count: 25 });
  });
});
