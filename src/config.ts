import * as fs from 'node:fs';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import type { ChatPlatform } from './prompts/index.js';
import { EnvValidator } from './config-validate.js';

export const ALL_AGENT_BACKENDS = [
  'claude-code',
  'codex',
  'cursor',
  'grok',
  'antigravity',
  'local-llm',
] as const;
export type AgentBackend = (typeof ALL_AGENT_BACKENDS)[number];
export type DiscordCompletionNotifyMode = 'off' | 'message' | 'mention';

const DEFAULT_COMPLETION_NOTIFY_AFTER_MS = 10_000;

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
  /** 初回providerセッションの会話履歴先読み。全チャットプラットフォーム共通。 */
  historyPrefetch?: {
    enabled: boolean;
    count: number;
  };
  discord: {
    enabled: boolean;
    token: string;
    allowedUsers?: string[];
    /** 返信をチャンネルではなくスレッドに投稿するか (default: false)。発言ごとにスレッドを作成する */
    replyInThread?: boolean;
    streaming?: boolean;
    showThinking?: boolean;
    showToolUse?: boolean;
    toolHistoryMode?: 'inline' | 'button' | 'off';
    showLiveToolUse?: boolean;
    showToolButton?: boolean;
    completionNotifyMode?: DiscordCompletionNotifyMode;
    completionNotifyAfterMs?: number;
    injectChannelTopic?: boolean;
    injectTimestamp?: boolean;
    showButtons?: boolean;
    replySuggestions?: boolean;
    replySuggestionCount?: number;
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
    /** /threadmode slash command を有効化するか (default: true) */
    allowThreadModeCommand?: boolean;
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
    replyInChannels?: string[];
    completionNotifyAfterMs?: number;
    streaming?: boolean;
    showThinking?: boolean;
    replySuggestions?: boolean;
    replySuggestionCount?: number;
    /** Slack reaction-based bot message deletion (default: true) */
    reactionDeleteEnabled?: boolean;
    /** Emoji reaction names that trigger deletion (default: wastebasket,x) */
    deleteReactions?: string[];
  };
  web: {
    replySuggestions: boolean;
    replySuggestionCount: number;
  };
  line: {
    enabled: boolean;
    channelSecret?: string;
    channelAccessToken?: string;
    allowedUsers?: string[];
    webhookPort?: number;
    webhookPath?: string;
    /**
     * Loading animation API (POST /v2/bot/chat/loading/start) を使って
     * webhook 受信直後に「入力中…」を表示するか (default: true)。
     * 1:1 DM のみ。グループ・トークルームでは LINE 側で無視される。
     */
    loadingAnimationEnabled?: boolean;
    /**
     * Loading animation の表示秒数 (5/10/15/20/25/30/40/50/60、default: 60)。
     * 5 の倍数で 60 を超えない値にスナップされる。Bot から新メッセージを
     * 送ると自動消滅する。
     */
    loadingAnimationSeconds?: number;
    /**
     * 応答に時間がかかった時の reply→push 自動切替を有効にするか (default: true)。
     * 無効にすると reply token のみ使用、60s 超で返信不可になる。
     */
    slowResponseEnabled?: boolean;
    /**
     * Slow response 閾値 ms (default: 45000 = 45秒)。
     * これを超えた時点で「考え中」テンプレを reply token で送り、本回答は
     * Push API で後追い送信する。LINE reply token は 60s で失効するため
     * 安全マージンを取って 45s に設定。
     */
    slowResponseThresholdMs?: number;
    /**
     * Idle session reset を有効にするか (default: true)。
     * LINE は Slack スレッド / Discord New ボタンのような UI 境界が無いため、
     * 一定時間黙ったら次の発話で session を自動切替する仕組み。
     */
    idleResetEnabled?: boolean;
    /**
     * Idle reset の閾値時間 (default: 4 時間)。
     * 直前の発話から N 時間以上経過していたら、新メッセージ到着時に既存 session を
     * archive して新規発番する (会話履歴は logs/sessions/*.jsonl に残る)。
     * 子どもの会話パターン (学校・就寝・食事クラスタ) を自然に分けるため 4h を default に。
     */
    idleResetHours?: number;
    /**
     * Reset コマンドのテキストパターン (default: 子ども向け含む規定セット)。
     * ユーザがこれらのフレーズを送ると session を archive + 新規発番し、
     * Runner は起動せず「最初からお話するね」と即返す。
     * env では CSV で指定 (`LINE_RESET_TEXT_PATTERNS=リセット,/reset,...`)。
     */
    resetTextPatterns?: string[];
  };
  telegram: {
    enabled: boolean;
    botToken?: string;
    allowedUsers?: string[];
    allowedBots?: string[];
    allowedChats?: string[];
    autoReplyChats?: string[];
    mode?: 'polling' | 'webhook';
    webhookPort?: number;
    webhookPath?: string;
    webhookSecretToken?: string;
    webhookUrl?: string;
    streaming?: boolean;
    showThinking?: boolean;
    allowedBotsMaxConsecutive?: number;
    replyToMentionInGroup?: boolean;
    idleResetEnabled?: boolean;
    idleResetHours?: number;
    resetTextPatterns?: string[];
    forceIpv4?: boolean;
    mediaEnabled?: boolean;
    mediaMaxDownloadMb?: number;
    mediaRetentionHours?: number;
    mediaAllowedMimeTypes?: string[];
    mediaGroupDebounceMs?: number;
  };
  agent: {
    backend: AgentBackend;
    config: AgentConfig;
    platform?: ChatPlatform;
    /** 切り替え許可バックエンド一覧（未設定=全て許可） */
    allowedBackends: AgentBackend[];
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
  // 環境変数の検証層。不正な値は警告 + デフォルトへフォールバック
  // （XANGI_CONFIG_STRICT=true で起動中断に格上げ）
  const v = new EnvValidator();

  const discordToken = process.env.DISCORD_TOKEN;
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  const lineChannelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const lineChannelSecret = process.env.LINE_CHANNEL_SECRET;
  const lineEnabled = !!lineChannelAccessToken && !!lineChannelSecret;
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramEnabled = !!telegramBotToken;

  // 少なくともどれかが有効である必要がある（WebChat / LINE / Telegram 単独運用も可）
  const webChatEnabled = process.env.WEB_CHAT_ENABLED === 'true';
  if (!discordToken && !slackBotToken && !webChatEnabled && !lineEnabled && !telegramBotToken) {
    throw new Error(
      'DISCORD_TOKEN, SLACK_BOT_TOKEN, LINE_CHANNEL_ACCESS_TOKEN+LINE_CHANNEL_SECRET, TELEGRAM_BOT_TOKEN, or WEB_CHAT_ENABLED=true environment variable is required'
    );
  }

  const discordAllowedUser = process.env.DISCORD_ALLOWED_USER;
  const slackAllowedUser = process.env.SLACK_ALLOWED_USER;
  const lineAllowedUser = process.env.LINE_ALLOWED_USER;
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
  const lineAllowedUsers = lineAllowedUser
    ? lineAllowedUser
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const telegramAllowedUser = process.env.TELEGRAM_ALLOWED_USER;
  const telegramAllowedUsers = telegramAllowedUser
    ? telegramAllowedUser
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const backend = (process.env.AGENT_BACKEND || 'claude-code') as AgentBackend;
  if (
    backend !== 'claude-code' &&
    backend !== 'codex' &&
    backend !== 'cursor' &&
    backend !== 'grok' &&
    backend !== 'antigravity' &&
    backend !== 'local-llm'
  ) {
    throw new Error(
      `Invalid AGENT_BACKEND: ${backend}. Must be 'claude-code', 'codex', 'cursor', 'grok', 'antigravity', or 'local-llm'`
    );
  }

  // プラットフォーム自動検出
  // 単独運用なら専用 prompt を注入、複数同時運用なら undefined (全コマンド注入経路)。
  // LINE 単独運用の場合は XANGI_COMMANDS_LINE で Markdown 禁止
  // 等の LINE 固有ルールを注入する。
  const discordEnabled = !!discordToken;
  const slackEnabled = !!slackBotToken && !!slackAppToken;
  let platform: ChatPlatform | undefined;
  const enabledPlatforms = [
    discordEnabled && 'discord',
    slackEnabled && 'slack',
    lineEnabled && 'line',
    telegramEnabled && 'telegram',
  ].filter(Boolean) as ChatPlatform[];
  if (enabledPlatforms.length === 1) {
    platform = enabledPlatforms[0];
  }
  // 複数有効 or 全部 disabled (Web Chat only) → undefined（全コマンド注入 / Web 専用扱い）

  const agentConfig: AgentConfig = {
    model: process.env.AGENT_MODEL || undefined,
    timeoutMs: v.int('TIMEOUT_MS', DEFAULT_TIMEOUT_MS, { min: 1000 }),
    workdir: process.env.WORKSPACE_PATH || undefined,
    skipPermissions: process.env.SKIP_PERMISSIONS !== 'false', // デフォルトで有効（Discord/Slack/Web 連携の非対話実行で permission プロンプト待ちを避けるため）
    persistent: process.env.PERSISTENT_MODE !== 'false', // デフォルトで有効
    maxProcesses: v.int('MAX_PROCESSES', 10, { min: 1, max: 100 }),
    idleTimeoutMs: v.int('IDLE_TIMEOUT_MS', 30 * 60 * 1000, { min: 1000 }), // 30分
  };

  // ALLOWED_BACKENDS パース（未設定なら全 backend 許可、typo は警告して除外）
  const allowedBackends: AgentBackend[] = v.enumList('ALLOWED_BACKENDS', ALL_AGENT_BACKENDS) ?? [
    ...ALL_AGENT_BACKENDS,
  ];

  // LOCAL_LLM_MODE は local-llm/runner 等で直接参照されるが、typo 検出のためここで検証する
  v.enumOf('LOCAL_LLM_MODE', ['agent', 'lite', 'chat'] as const, 'agent');

  // XANGI_HOOKS_ENABLED / XANGI_HOOKS_FILE は hooks.ts で直接参照されるが、typo 検出のためここで検証する
  v.enumOf('XANGI_HOOKS_ENABLED', ['true', 'false'] as const, 'true');
  {
    const hooksFile = process.env.XANGI_HOOKS_FILE?.trim();
    if (hooksFile && !fs.existsSync(hooksFile)) {
      v.issue(
        'XANGI_HOOKS_FILE',
        hooksFile,
        'ファイルが存在しません。hooks は無効として起動します'
      );
    }
  }

  const allowedModelsRaw = process.env.ALLOWED_MODELS;
  const allowedModels: string[] | undefined = allowedModelsRaw
    ? allowedModelsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const config: Config = {
    historyPrefetch: {
      enabled: process.env.HISTORY_PREFETCH_ENABLED !== 'false',
      count: v.int('HISTORY_PREFETCH_COUNT', 10, { min: 1, max: 100 }),
    },
    discord: {
      enabled: !!discordToken,
      token: discordToken || '',
      allowedUsers: discordAllowedUsers,
      replyInThread: process.env.DISCORD_REPLY_IN_THREAD === 'true', // デフォルトOFF
      streaming: process.env.DISCORD_STREAMING !== 'false',
      showThinking: process.env.DISCORD_SHOW_THINKING !== 'false',
      showToolUse: process.env.DISCORD_SHOW_TOOL_USE !== 'false',
      toolHistoryMode: (() => {
        const mode = process.env.DISCORD_TOOL_HISTORY_MODE?.trim().toLowerCase();
        if (mode === 'inline' || mode === 'button' || mode === 'off') return mode;
        if (mode) {
          v.issue(
            'DISCORD_TOOL_HISTORY_MODE',
            mode,
            `許可される値は inline / button / off です。フォールバック値を使用します`
          );
        }
        if (process.env.DISCORD_SHOW_TOOL_USE === 'true') return 'inline';
        if (process.env.DISCORD_SHOW_TOOL_USE === 'false') return 'off';
        return 'button';
      })(),
      showLiveToolUse: process.env.DISCORD_SHOW_LIVE_TOOL_USE !== 'false',
      showToolButton: process.env.DISCORD_SHOW_TOOL_BUTTON !== 'false',
      completionNotifyMode: v.enumOf(
        'DISCORD_COMPLETION_NOTIFY',
        ['off', 'message', 'mention'] as const,
        'message'
      ),
      completionNotifyAfterMs: v.int(
        'DISCORD_COMPLETION_NOTIFY_AFTER_MS',
        DEFAULT_COMPLETION_NOTIFY_AFTER_MS,
        { min: 0 }
      ),
      injectChannelTopic: process.env.INJECT_CHANNEL_TOPIC !== 'false', // デフォルトON
      injectTimestamp: process.env.INJECT_TIMESTAMP !== 'false', // デフォルトON
      showButtons: process.env.DISCORD_SHOW_BUTTONS !== 'false', // デフォルトON
      replySuggestions: process.env.DISCORD_REPLY_SUGGESTIONS === 'true',
      replySuggestionCount: v.int('DISCORD_REPLY_SUGGESTIONS_COUNT', 3, { min: 1, max: 5 }),
      allowAutoreplyCommand: process.env.ALLOW_AUTOREPLY_COMMAND !== 'false', // デフォルトON
      respondToBots:
        process.env.RESPOND_TO_BOTS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) || [],
      respondToBotsEnabled: process.env.RESPOND_TO_BOTS_ENABLED === 'true', // デフォルトOFF
      respondToBotsMaxConsecutive: v.int('RESPOND_TO_BOTS_MAX_CONSECUTIVE', 3), // デフォルト3回、0以下は制限無効
      allowRespondToBotsCommand: process.env.ALLOW_RESPOND_TO_BOTS_COMMAND !== 'false', // デフォルトON
      allowThreadModeCommand: process.env.ALLOW_THREAD_MODE_COMMAND !== 'false', // デフォルトON
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
      replyInChannels:
        process.env.SLACK_REPLY_IN_CHANNELS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) || [],
      completionNotifyAfterMs: v.int(
        'SLACK_COMPLETION_NOTIFY_AFTER_MS',
        DEFAULT_COMPLETION_NOTIFY_AFTER_MS,
        { min: 0 }
      ),
      streaming: process.env.SLACK_STREAMING !== 'false',
      showThinking: process.env.SLACK_SHOW_THINKING !== 'false',
      replySuggestions: process.env.SLACK_REPLY_SUGGESTIONS === 'true',
      replySuggestionCount: v.int('SLACK_REPLY_SUGGESTIONS_COUNT', 3, { min: 1, max: 5 }),
      reactionDeleteEnabled: process.env.SLACK_REACTION_DELETE_ENABLED !== 'false',
      deleteReactions: process.env.SLACK_DELETE_REACTIONS?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) || ['wastebasket', 'x'],
    },
    web: {
      replySuggestions: process.env.WEB_REPLY_SUGGESTIONS === 'true',
      replySuggestionCount: v.int('WEB_REPLY_SUGGESTIONS_COUNT', 3, { min: 1, max: 5 }),
    },
    line: {
      enabled: lineEnabled,
      channelSecret: lineChannelSecret,
      channelAccessToken: lineChannelAccessToken,
      allowedUsers: lineAllowedUsers,
      webhookPort: v.int('LINE_WEBHOOK_PORT', 8765, { min: 1, max: 65535 }),
      webhookPath: process.env.LINE_WEBHOOK_PATH || '/webhook',
      loadingAnimationEnabled: process.env.LINE_LOADING_ANIMATION_ENABLED !== 'false',
      loadingAnimationSeconds: v.int('LINE_LOADING_ANIMATION_SECONDS', 60, { min: 5, max: 60 }),
      slowResponseEnabled: process.env.LINE_SLOW_RESPONSE_ENABLED !== 'false',
      slowResponseThresholdMs: v.int('LINE_SLOW_RESPONSE_THRESHOLD_MS', 45000, { min: 1000 }),
      idleResetEnabled: process.env.LINE_IDLE_RESET_ENABLED !== 'false',
      idleResetHours: v.float('LINE_IDLE_RESET_HOURS', 4, { min: 0 }),
      resetTextPatterns: process.env.LINE_RESET_TEXT_PATTERNS
        ? process.env.LINE_RESET_TEXT_PATTERNS.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined, // line.ts 側で default パターンに fallback
    },
    telegram: {
      enabled: telegramEnabled,
      botToken: telegramBotToken,
      allowedUsers: telegramAllowedUsers,
      allowedBots: process.env.TELEGRAM_ALLOWED_BOTS
        ? process.env.TELEGRAM_ALLOWED_BOTS.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      allowedChats: process.env.TELEGRAM_ALLOWED_CHATS
        ? process.env.TELEGRAM_ALLOWED_CHATS.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      autoReplyChats: process.env.TELEGRAM_AUTO_REPLY_CHATS
        ? process.env.TELEGRAM_AUTO_REPLY_CHATS.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      mode: v.enumOf('TELEGRAM_MODE', ['polling', 'webhook'] as const, 'polling'),
      webhookPort: v.int('TELEGRAM_WEBHOOK_PORT', 8766, { min: 1, max: 65535 }),
      webhookPath: process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook',
      webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
      streaming: process.env.TELEGRAM_STREAMING !== 'false',
      showThinking: process.env.TELEGRAM_SHOW_THINKING !== 'false',
      allowedBotsMaxConsecutive: v.int('TELEGRAM_ALLOWED_BOTS_MAX_CONSECUTIVE', 3),
      replyToMentionInGroup: process.env.TELEGRAM_REPLY_TO_MENTION_IN_GROUP !== 'false',
      idleResetEnabled: process.env.TELEGRAM_IDLE_RESET_ENABLED !== 'false',
      idleResetHours: v.float('TELEGRAM_IDLE_RESET_HOURS', 4, { min: 0 }),
      forceIpv4: process.env.TELEGRAM_FORCE_IPV4 === 'true',
      mediaEnabled: process.env.TELEGRAM_MEDIA_ENABLED === 'true',
      mediaMaxDownloadMb: v.int('TELEGRAM_MEDIA_MAX_DOWNLOAD_MB', 20, { min: 1, max: 20 }),
      mediaRetentionHours: v.float('TELEGRAM_MEDIA_RETENTION_HOURS', 24, { min: 0 }),
      mediaAllowedMimeTypes: process.env.TELEGRAM_MEDIA_ALLOWED_MIME
        ? process.env.TELEGRAM_MEDIA_ALLOWED_MIME.split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        : ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
      mediaGroupDebounceMs: v.int('TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS', 750, {
        min: 100,
        max: 5000,
      }),
      resetTextPatterns: process.env.TELEGRAM_RESET_TEXT_PATTERNS
        ? process.env.TELEGRAM_RESET_TEXT_PATTERNS.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : ['/reset', '/new', '/clear'],
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

  // 検証結果をまとめて報告（問題なしなら無音、XANGI_CONFIG_STRICT=true なら throw）
  v.report();

  return config;
}
