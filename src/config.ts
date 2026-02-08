import { DEFAULT_TIMEOUT_MS } from './constants.js';

export type AgentBackend = 'claude-code' | 'codex';

export interface AgentConfig {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
  /** 常駐プロセスモード（高速化） */
  persistent?: boolean;
  /** 同時実行プロセス数の上限（RunnerManager用） */
  maxProcesses?: number;
  /** アイドルタイムアウト（ミリ秒、RunnerManager用） */
  idleTimeoutMs?: number;
}

export interface Config {
  discord: {
    enabled: boolean;
    token: string;
    allowedUsers?: string[];
    autoReplyChannels?: string[];
    streaming?: boolean;
    showThinking?: boolean;
  };
  slack: {
    enabled: boolean;
    botToken?: string;
    appToken?: string;
    allowedUsers?: string[];
    autoReplyChannels?: string[];
    replyInThread?: boolean;
    streaming?: boolean;
    showThinking?: boolean;
  };
  agent: {
    backend: AgentBackend;
    config: AgentConfig;
  };
  scheduler: {
    enabled: boolean;
    startupEnabled: boolean;
  };
  // 後方互換性のため残す
  claudeCode: AgentConfig;
}

export function loadConfig(): Config {
  const discordToken = process.env.DISCORD_TOKEN;
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;

  // 少なくともどちらかが有効である必要がある
  if (!discordToken && !slackBotToken) {
    throw new Error('DISCORD_TOKEN or SLACK_BOT_TOKEN environment variable is required');
  }

  const discordAllowedUser = process.env.DISCORD_ALLOWED_USER;
  const slackAllowedUser = process.env.SLACK_ALLOWED_USER;
  const discordAllowedUsers = discordAllowedUser ? [discordAllowedUser] : [];
  const slackAllowedUsers = slackAllowedUser ? [slackAllowedUser] : [];

  const backend = (process.env.AGENT_BACKEND || 'claude-code') as AgentBackend;
  if (backend !== 'claude-code' && backend !== 'codex') {
    throw new Error(`Invalid AGENT_BACKEND: ${backend}. Must be 'claude-code' or 'codex'`);
  }

  const agentConfig: AgentConfig = {
    model: process.env.AGENT_MODEL || undefined,
    timeoutMs: process.env.TIMEOUT_MS ? parseInt(process.env.TIMEOUT_MS, 10) : DEFAULT_TIMEOUT_MS,
    workdir: process.env.WORKSPACE_PATH || undefined,
    skipPermissions: process.env.SKIP_PERMISSIONS === 'true',
    persistent: process.env.PERSISTENT_MODE !== 'false', // デフォルトで有効
    maxProcesses: process.env.MAX_PROCESSES ? parseInt(process.env.MAX_PROCESSES, 10) : 10,
    idleTimeoutMs: process.env.IDLE_TIMEOUT_MS
      ? parseInt(process.env.IDLE_TIMEOUT_MS, 10)
      : 30 * 60 * 1000, // 30分
  };

  return {
    discord: {
      enabled: !!discordToken,
      token: discordToken || '',
      allowedUsers: discordAllowedUsers,
      autoReplyChannels:
        process.env.AUTO_REPLY_CHANNELS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) || [],
      streaming: process.env.DISCORD_STREAMING !== 'false',
      showThinking: process.env.DISCORD_SHOW_THINKING !== 'false',
    },
    slack: {
      enabled: !!slackBotToken && !!slackAppToken,
      botToken: slackBotToken,
      appToken: slackAppToken,
      allowedUsers: slackAllowedUsers,
      autoReplyChannels:
        process.env.SLACK_AUTO_REPLY_CHANNELS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) || [],
      replyInThread: process.env.SLACK_REPLY_IN_THREAD !== 'false',
      streaming: process.env.SLACK_STREAMING !== 'false',
      showThinking: process.env.SLACK_SHOW_THINKING !== 'false',
    },
    agent: {
      backend,
      config: agentConfig,
    },
    scheduler: {
      enabled: process.env.SCHEDULER_ENABLED !== 'false', // デフォルトで有効
      startupEnabled: process.env.STARTUP_ENABLED !== 'false', // デフォルトで有効
    },
    // 後方互換性のため残す
    claudeCode: agentConfig,
  };
}
