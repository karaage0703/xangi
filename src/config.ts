import { DEFAULT_TIMEOUT_MS } from './constants.js';
import type { ChatPlatform } from './prompts/index.js';

export type AgentBackend = 'claude-code' | 'codex' | 'gemini' | 'local-llm';

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

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface Config {
  discord: {
    enabled: boolean;
    token: string;
    allowedUsers?: string[];
    autoReplyChannels?: string[];
    streaming?: boolean;
    showThinking?: boolean;
    injectChannelTopic?: boolean;
    injectTimestamp?: boolean;
    showButtons?: boolean;
    allowAutoreplyCommand?: boolean;
    /**
     * 反応する他 bot の ID ホワイトリスト (設定値、事前に env で指定)。
     * - 空配列 (default) = 他 bot のメッセージには反応しない
     * - ['*'] = 全 bot のメッセージに反応
     * - ['<bot_id_1>', '<bot_id_2>'] = 指定 bot のみ反応
     * 自分自身の bot ID は常に除外される (無限ループ防止)。
     * 実際の有効/無効は `respondToBotsEnabled` で制御。
     */
    respondToBots?: string[];
    /**
     * bot メッセージ応答機能を有効化するか (default: false)。
     * `/respondtobots` slash command でトグル可能。
     */
    respondToBotsEnabled?: boolean;
    /**
     * 同じ bot からの連続返信に対する応答回数の上限 (default: 3)。
     * 0 以下を指定すると制限無効 (無限ループ事故のリスクあるので注意)。
     * 別 bot や人間のメッセージが入ったら連鎖はリセットされる。
     */
    respondToBotsMaxConsecutive?: number;
    /** /respondtobots slash command を有効化するか (default: true) */
    allowRespondToBotsCommand?: boolean;
    /** /llmmode slash command を有効化するか (default: true)。Local LLM 動作モードを per-channel 切替 */
    allowLlmModeCommand?: boolean;
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
    platform?: ChatPlatform;
    /** 切り替え許可バックエンド一覧（未設定=全て許可） */
    allowedBackends?: AgentBackend[];
    /** 切り替え許可モデル一覧（未設定=全て許可） */
    allowedModels?: string[];
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

  // 少なくともどちらかが有効である必要がある（WebChatのみでもOK）
  const webChatEnabled = process.env.WEB_CHAT_ENABLED === 'true';
  if (!discordToken && !slackBotToken && !webChatEnabled) {
    throw new Error(
      'DISCORD_TOKEN, SLACK_BOT_TOKEN, or WEB_CHAT_ENABLED=true environment variable is required'
    );
  }

  const discordAllowedUser = process.env.DISCORD_ALLOWED_USER;
  const slackAllowedUser = process.env.SLACK_ALLOWED_USER;
  const discordAllowedUsers = discordAllowedUser
    ? discordAllowedUser
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const slackAllowedUsers = slackAllowedUser
    ? slackAllowedUser
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const backend = (process.env.AGENT_BACKEND || 'claude-code') as AgentBackend;
  if (
    backend !== 'claude-code' &&
    backend !== 'codex' &&
    backend !== 'gemini' &&
    backend !== 'local-llm'
  ) {
    throw new Error(
      `Invalid AGENT_BACKEND: ${backend}. Must be 'claude-code', 'codex', 'gemini', or 'local-llm'`
    );
  }

  // プラットフォーム自動検出
  const discordEnabled = !!discordToken;
  const slackEnabled = !!slackBotToken && !!slackAppToken;
  let platform: ChatPlatform | undefined;
  if (discordEnabled && !slackEnabled) {
    platform = 'discord';
  } else if (slackEnabled && !discordEnabled) {
    platform = 'slack';
  }
  // 両方有効 → undefined（全コマンド注入）

  const agentConfig: AgentConfig = {
    model: process.env.AGENT_MODEL || undefined,
    timeoutMs: process.env.TIMEOUT_MS ? parseInt(process.env.TIMEOUT_MS, 10) : DEFAULT_TIMEOUT_MS,
    workdir: process.env.WORKSPACE_PATH || undefined,
    skipPermissions: process.env.SKIP_PERMISSIONS !== 'false', // デフォルトで有効（Discord/Slack/Web 連携の非対話実行で permission プロンプト待ちを避けるため）
    persistent: process.env.PERSISTENT_MODE !== 'false', // デフォルトで有効
    maxProcesses: process.env.MAX_PROCESSES ? parseInt(process.env.MAX_PROCESSES, 10) : 10,
    idleTimeoutMs: process.env.IDLE_TIMEOUT_MS
      ? parseInt(process.env.IDLE_TIMEOUT_MS, 10)
      : 30 * 60 * 1000, // 30分
  };

  // ALLOWED_BACKENDS / ALLOWED_MODELS パース
  const allowedBackendsRaw = process.env.ALLOWED_BACKENDS;
  const allowedBackends: AgentBackend[] | undefined = allowedBackendsRaw
    ? (allowedBackendsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as AgentBackend[])
    : undefined;

  const allowedModelsRaw = process.env.ALLOWED_MODELS;
  const allowedModels: string[] | undefined = allowedModelsRaw
    ? allowedModelsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

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
      injectChannelTopic: process.env.INJECT_CHANNEL_TOPIC !== 'false', // デフォルトON
      injectTimestamp: process.env.INJECT_TIMESTAMP !== 'false', // デフォルトON
      showButtons: process.env.DISCORD_SHOW_BUTTONS !== 'false', // デフォルトON
      allowAutoreplyCommand: process.env.ALLOW_AUTOREPLY_COMMAND !== 'false', // デフォルトON
      respondToBots:
        process.env.RESPOND_TO_BOTS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) || [],
      respondToBotsEnabled: process.env.RESPOND_TO_BOTS_ENABLED === 'true', // デフォルトOFF
      respondToBotsMaxConsecutive: process.env.RESPOND_TO_BOTS_MAX_CONSECUTIVE
        ? parseInt(process.env.RESPOND_TO_BOTS_MAX_CONSECUTIVE, 10)
        : 3, // デフォルト3回
      allowRespondToBotsCommand: process.env.ALLOW_RESPOND_TO_BOTS_COMMAND !== 'false', // デフォルトON
      allowLlmModeCommand: process.env.ALLOW_LLM_MODE_COMMAND !== 'false', // デフォルトON
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
      platform,
      allowedBackends,
      allowedModels,
    },
    scheduler: {
      enabled: process.env.SCHEDULER_ENABLED !== 'false', // デフォルトで有効
      startupEnabled: process.env.STARTUP_ENABLED !== 'false', // デフォルトで有効
    },
    // 後方互換性のため残す
    claudeCode: agentConfig,
  };
}
