import { DEFAULT_TIMEOUT_MS } from './constants.js';
import type { ChatPlatform } from './prompts/index.js';

export type AgentBackend = 'claude-code' | 'codex' | 'gemini' | 'cursor' | 'local-llm';

export interface AgentConfig {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
  /** Claude Code の --permission-mode（例: acceptEdits, plan, bypassPermissions） */
  permissionMode?: string;
  /** Claude Code の --add-dir 追加ディレクトリ一覧 */
  addDirs?: string[];
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
    showToolUse?: boolean;
    toolHistoryMode?: 'inline' | 'button' | 'off';
    showLiveToolUse?: boolean;
    showToolButton?: boolean;
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
  const lineChannelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const lineChannelSecret = process.env.LINE_CHANNEL_SECRET;
  const lineEnabled = !!lineChannelAccessToken && !!lineChannelSecret;

  // 少なくともどれかが有効である必要がある（WebChat / LINE 単独運用も可）
  const webChatEnabled = process.env.WEB_CHAT_ENABLED === 'true';
  if (!discordToken && !slackBotToken && !webChatEnabled && !lineEnabled) {
    throw new Error(
      'DISCORD_TOKEN, SLACK_BOT_TOKEN, LINE_CHANNEL_ACCESS_TOKEN+LINE_CHANNEL_SECRET, or WEB_CHAT_ENABLED=true environment variable is required'
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

  const backend = (process.env.AGENT_BACKEND || 'claude-code') as AgentBackend;
  if (
    backend !== 'claude-code' &&
    backend !== 'codex' &&
    backend !== 'gemini' &&
    backend !== 'cursor' &&
    backend !== 'local-llm'
  ) {
    throw new Error(
      `Invalid AGENT_BACKEND: ${backend}. Must be 'claude-code', 'codex', 'gemini', 'cursor', or 'local-llm'`
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
  ].filter(Boolean) as ChatPlatform[];
  if (enabledPlatforms.length === 1) {
    platform = enabledPlatforms[0];
  }
  // 複数有効 or 全部 disabled (Web Chat only) → undefined（全コマンド注入 / Web 専用扱い）

  const addDirsRaw = process.env.CLAUDE_ADD_DIRS;
  const addDirs: string[] | undefined = addDirsRaw
    ? addDirsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const agentConfig: AgentConfig = {
    model: process.env.AGENT_MODEL || undefined,
    timeoutMs: process.env.TIMEOUT_MS ? parseInt(process.env.TIMEOUT_MS, 10) : DEFAULT_TIMEOUT_MS,
    workdir: process.env.WORKSPACE_PATH || undefined,
    skipPermissions: process.env.SKIP_PERMISSIONS !== 'false', // デフォルトで有効（Discord/Slack/Web 連携の非対話実行で permission プロンプト待ちを避けるため）
    permissionMode: process.env.CLAUDE_PERMISSION_MODE || undefined,
    addDirs,
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
      showToolUse: process.env.DISCORD_SHOW_TOOL_USE !== 'false',
      toolHistoryMode: (() => {
        const mode = process.env.DISCORD_TOOL_HISTORY_MODE?.trim().toLowerCase();
        if (mode === 'inline' || mode === 'button' || mode === 'off') return mode;
        if (process.env.DISCORD_SHOW_TOOL_USE === 'true') return 'inline';
        if (process.env.DISCORD_SHOW_TOOL_USE === 'false') return 'off';
        return 'button';
      })(),
      showLiveToolUse: process.env.DISCORD_SHOW_LIVE_TOOL_USE !== 'false',
      showToolButton: process.env.DISCORD_SHOW_TOOL_BUTTON !== 'false',
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
    line: {
      enabled: lineEnabled,
      channelSecret: lineChannelSecret,
      channelAccessToken: lineChannelAccessToken,
      allowedUsers: lineAllowedUsers,
      webhookPort: process.env.LINE_WEBHOOK_PORT
        ? parseInt(process.env.LINE_WEBHOOK_PORT, 10)
        : 8765,
      webhookPath: process.env.LINE_WEBHOOK_PATH || '/webhook',
      loadingAnimationEnabled: process.env.LINE_LOADING_ANIMATION_ENABLED !== 'false',
      loadingAnimationSeconds: process.env.LINE_LOADING_ANIMATION_SECONDS
        ? parseInt(process.env.LINE_LOADING_ANIMATION_SECONDS, 10)
        : 60,
      slowResponseEnabled: process.env.LINE_SLOW_RESPONSE_ENABLED !== 'false',
      slowResponseThresholdMs: process.env.LINE_SLOW_RESPONSE_THRESHOLD_MS
        ? parseInt(process.env.LINE_SLOW_RESPONSE_THRESHOLD_MS, 10)
        : 45000,
      idleResetEnabled: process.env.LINE_IDLE_RESET_ENABLED !== 'false',
      idleResetHours: process.env.LINE_IDLE_RESET_HOURS
        ? parseFloat(process.env.LINE_IDLE_RESET_HOURS)
        : 4,
      resetTextPatterns: process.env.LINE_RESET_TEXT_PATTERNS
        ? process.env.LINE_RESET_TEXT_PATTERNS.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined, // line.ts 側で default パターンに fallback
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
