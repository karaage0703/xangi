import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  AutocompleteInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { loadConfig } from './config.js';
import { isGitHubAppEnabled } from './github-auth.js';
import { resolveApproval, requestApproval, setApprovalEnabled } from './approval.js';
import { getBackendDisplayName, type AgentRunner } from './agent-runner.js';
import { BackendResolver } from './backend-resolver.js';
import { DynamicRunnerManager } from './dynamic-runner.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { processManager } from './process-manager.js';
import { loadSkills, formatSkillList, type Skill } from './skills.js';
import { startSlackBot } from './slack.js';
import {
  downloadFile,
  extractFilePaths,
  stripFilePaths,
  buildPromptWithAttachments,
} from './file-utils.js';
import { initSettings, loadSettings, formatSettings } from './settings.js';
import { updateEnvKeyValue } from './env-persist.js';
import lockfile from 'proper-lockfile';
import {
  DISCORD_MAX_LENGTH,
  DISCORD_SAFE_LENGTH,
  STREAM_UPDATE_INTERVAL_MS,
  TIMEOUT_EXTEND_ENABLED,
} from './constants.js';
import {
  Scheduler,
  parseScheduleInput,
  formatScheduleList,
  SCHEDULE_SEPARATOR,
  type Platform,
  type ScheduleType,
} from './scheduler.js';
import {
  initSessions,
  getSession,
  setSession,
  deleteSession,
  ensureSession,
  incrementMessageCount,
  getActiveSessionId,
  getSessionEntry,
  updateSessionTitle,
} from './sessions.js';
import { stripPromptMetadata } from './session-title.js';
import {
  attachPlatformMessageIdToLast,
  findEntryByPlatformMessageId,
  updateMessageContent as updateTranscriptContent,
  deleteMessage as deleteTranscriptMessage,
} from './transcript-logger.js';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { startWebChat } from './web-chat.js';
import { startLineBot } from './line.js';
import { getEventsConfig, threadIdFor, turnIdFor } from './events-emitter.js';
import { runWithBubbleEvents } from './bubble-events-runner.js';
import { startInterInstanceChat, getInterChatConfig } from './inter-instance-chat/index.js';
dotenvConfig({ override: true });

/** メッセージを指定文字数で分割（カスタムセパレータ対応、デフォルトは行単位） */
function splitMessage(text: string, maxLength: number, separator: string = '\n'): string[] {
  const chunks: string[] = [];
  const blocks = text.split(separator);
  let current = '';
  for (const block of blocks) {
    const sep = current ? separator : '';
    if (current.length + sep.length + block.length > maxLength) {
      if (current) chunks.push(current.trim());
      // 単一ブロックがmaxLengthを超える場合は行単位でフォールバック
      if (block.length > maxLength) {
        const lines = block.split('\n');
        current = '';
        for (const line of lines) {
          if (current.length + line.length + 1 > maxLength) {
            if (current) chunks.push(current.trim());
            current = line;
          } else {
            current += (current ? '\n' : '') + line;
          }
        }
      } else {
        current = block;
      }
    } else {
      current += sep + block;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

/** スケジュール一覧をDiscord向けに分割する */
function splitScheduleContent(content: string, maxLength: number): string[] {
  const sep = '\n' + SCHEDULE_SEPARATOR + '\n';
  const chunks = splitMessage(content, maxLength, sep);
  return chunks.map((c) => c.replaceAll(SCHEDULE_SEPARATOR, ''));
}

/** スケジュールタイプに応じたラベルを生成 */
function getTypeLabel(
  type: ScheduleType,
  options: { expression?: string; runAt?: string; channelInfo?: string }
): string {
  const channelInfo = options.channelInfo || '';
  switch (type) {
    case 'cron':
      return `🔄 繰り返し: \`${options.expression}\`${channelInfo}`;
    case 'startup':
      return `🚀 起動時に実行${channelInfo}`;
    case 'once':
    default:
      return `⏰ 実行時刻: ${new Date(options.runAt!).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}${channelInfo}`;
  }
}

/** 残り時間を mm:ss でフォーマット */
function formatRemaining(remainingMs: number): string {
  const sec = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

/** 処理中に表示するボタン群 (Stop / 延長 / 残り MM:SS の順) */
function createProcessingButtons(timeout?: {
  remainingMs: number;
  canExtend: boolean;
  extendEnabled: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder().setCustomId('xangi_stop').setLabel('Stop').setStyle(ButtonStyle.Secondary)
  );
  if (timeout) {
    const isWarn = timeout.remainingMs <= 30_000;
    if (timeout.extendEnabled) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('xangi_extend')
          .setLabel('延長')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!timeout.canExtend)
      );
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('xangi_timeout_display')
        .setLabel(`⏱ ${formatRemaining(timeout.remainingMs)}`)
        .setStyle(isWarn ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(true)
    );
  }
  return row;
}

/**
 * 処理中の Discord 返信メッセージ管理 (タイムアウト UI 更新用)
 * channelId -> { message, intervalId }。runner の timeout-* イベントで
 * 残り時間ボタンと +5m ボタンを含むコンポーネント行を 10 秒間隔で edit する。
 *
 * processPrompt() (module-level) と main() 内の runner listener 双方からアクセスするため、
 * モジュール最上位に置く (xangi は 1 process = 1 Discord client なので共有しても安全)。
 */
type DiscordProcessingEntry = { message: Message; intervalId?: NodeJS.Timeout };
const discordProcessingMessages = new Map<string, DiscordProcessingEntry>();

/** チャンネルの現在のタイムアウト状態から Discord UI 用に整形 (top-level 版) */
function getDiscordTimeoutInfoFor(
  agentRunner: AgentRunner,
  channelId: string
): { remainingMs: number; canExtend: boolean; extendEnabled: boolean } | undefined {
  const state = agentRunner.getTimeoutState?.(channelId);
  if (!state?.active || state.timeoutAt == null) return undefined;
  const remainingMs = Math.max(0, state.timeoutAt - Date.now());
  // 「延長 = 残り時間を 2 倍」なので、残り時間を一度加算しても max を越えないか判定
  const canExtend =
    state.maxTimeoutAt != null && state.timeoutAt + remainingMs <= state.maxTimeoutAt;
  return { remainingMs, canExtend, extendEnabled: TIMEOUT_EXTEND_ENABLED };
}

/** 完了後に表示するNew Sessionボタン */
function createCompletedButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('xangi_new').setLabel('New').setStyle(ButtonStyle.Secondary)
  );
}

/**
 * ツール入力の要約を生成（Discord表示用）
 */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
    case 'read':
      return input.file_path || input.path
        ? `: ${String(input.file_path || input.path)
            .split('/')
            .slice(-2)
            .join('/')}`
        : '';
    case 'Edit':
    case 'Write':
      return input.file_path ? `: ${String(input.file_path).split('/').slice(-2).join('/')}` : '';
    case 'Bash':
    case 'exec': {
      const cmdKey = input.command || input.cmd;
      if (!cmdKey) return '';
      const cmd = String(cmdKey);
      // 60 文字だと codex exec / gemini -p のラッパーコマンドが本文に入る前に切れる。
      // 観測性を上げるため 200 文字まで表示。Discord 1 メッセージ 2000 字制限内で十分。
      // 環境変数 XANGI_TOOL_DISPLAY_MAX で上書き可能。
      const maxLen = parseInt(process.env.XANGI_TOOL_DISPLAY_MAX ?? '200', 10);
      const cmdDisplay = `: \`${cmd.slice(0, maxLen)}${cmd.length > maxLen ? '...' : ''}\``;
      const ghBadge = cmd.startsWith('gh ') && isGitHubAppEnabled() ? ' 🔑App' : '';
      return cmdDisplay + ghBadge;
    }
    case 'Glob':
      return input.pattern ? `: ${String(input.pattern)}` : '';
    case 'Grep':
      return input.pattern ? `: ${String(input.pattern)}` : '';
    case 'WebFetch':
    case 'web_fetch':
      return input.url ? `: ${String(input.url).slice(0, 60)}` : '';
    case 'Agent':
      return input.description ? `: ${String(input.description)}` : '';
    case 'Skill':
      return input.skill ? `: ${String(input.skill)}` : '';
    default:
      // MCPツール (mcp__server__tool 形式)
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const server = parts[1] || '';
        const tool = parts[2] || '';
        return ` (${server}/${tool})`;
      }
      return '';
  }
}

/**
 * dataDir を flock 風に排他ロックする。
 * 同じ dataDir を複数の xangi インスタンスで共有すると sessions.json を
 * 取り合って書き潰し合うため、起動時に警告して回避を促す。
 *
 * 取得成功時は release 関数を返す。取得失敗時 (別インスタンスが使用中) は
 * 警告を出して null を返す (起動は継続する; 重複検知はあくまで助言)。
 *
 * proper-lockfile は mtime ハートビート (`update`) で生存を示し、`stale` 時間
 * 経過後は強制取得を許す。crash で残った lock は次起動時に自動回収される。
 */
async function acquireDataDirLock(dataDir: string): Promise<(() => Promise<void>) | null> {
  try {
    const release = await lockfile.lock(dataDir, {
      stale: 60_000, // 60s 以上 mtime が更新されてなければ stale とみなす
      update: 30_000, // 30s ごとに mtime を更新 (heartbeat)
      retries: 0, // すぐに ELOCKED を返す
    });
    return release;
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
    if (code === 'ELOCKED') {
      console.warn(`[xangi] ⚠️  Another xangi process is using the same dataDir: ${dataDir}`);
      console.warn(
        `[xangi] ⚠️  Sessions and settings will be overwritten unpredictably. Set DATA_DIR to a separate path for this instance.`
      );
    } else {
      console.warn(`[xangi] Failed to acquire dataDir lock: ${err}`);
    }
    return null;
  }
}

/**
 * Discord用のツール承認コールバックを作成
 */
async function main() {
  const config = loadConfig();

  // 許可リストのチェック（"*" で全員許可、カンマ区切りで複数ユーザー対応）
  const discordAllowed = config.discord.allowedUsers || [];
  const slackAllowed = config.slack.allowedUsers || [];
  const lineAllowed = config.line.allowedUsers || [];

  if (config.discord.enabled && discordAllowed.length === 0) {
    console.error('[xangi] Error: DISCORD_ALLOWED_USER must be set (use "*" to allow everyone)');
    process.exit(1);
  }
  if (config.slack.enabled && slackAllowed.length === 0) {
    console.error('[xangi] Error: SLACK_ALLOWED_USER must be set (use "*" to allow everyone)');
    process.exit(1);
  }
  if (config.line.enabled && lineAllowed.length === 0) {
    console.error('[xangi] Error: LINE_ALLOWED_USER must be set (use "*" to allow everyone)');
    process.exit(1);
  }

  if (discordAllowed.includes('*')) {
    console.log('[xangi] Discord: All users are allowed');
  } else {
    console.log(`[xangi] Discord: Allowed users: ${discordAllowed.join(', ')}`);
  }
  if (slackAllowed.includes('*')) {
    console.log('[xangi] Slack: All users are allowed');
  } else if (slackAllowed.length > 0) {
    console.log(`[xangi] Slack: Allowed users: ${slackAllowed.join(', ')}`);
  }
  if (lineAllowed.includes('*')) {
    console.log('[xangi] LINE: All users are allowed');
  } else if (lineAllowed.length > 0) {
    console.log(`[xangi] LINE: Allowed users: ${lineAllowed.join(', ')}`);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // messageUpdate / messageDelete はキャッシュに無い古いメッセージにも
    // 発火させたい (transcript 反映用)。partial を有効化して payload-only で
    // 受け取り、必要に応じて fetch() する。
    partials: [Partials.Message, Partials.Channel],
  });

  // バックエンドリゾルバー & 動的ランナーマネージャーを作成
  const resolver = new BackendResolver(config);
  const agentRunner = new DynamicRunnerManager(config, resolver);
  const backendName = getBackendDisplayName(config.agent.backend);
  console.log(
    `[xangi] Using ${backendName} as agent backend (platform: ${config.agent.platform ?? 'all'})`
  );

  /** チャンネルの現在のタイムアウト状態から UI 用に整形 (main スコープのラッパー) */
  const getDiscordTimeoutInfo = (channelId: string) =>
    getDiscordTimeoutInfoFor(agentRunner, channelId);

  /** 処理中メッセージの components を最新のタイムアウト状態に合わせて edit */
  const refreshDiscordProcessingButtons = (channelId: string): void => {
    const entry = discordProcessingMessages.get(channelId);
    if (!entry) return;
    const info = getDiscordTimeoutInfo(channelId);
    if (!info) return; // active でなければ何もしない (timeout-cleared で別途片付ける)
    entry.message
      .edit({ components: [createProcessingButtons(info)] })
      .catch((e) => console.warn('[xangi] Failed to refresh processing buttons:', e?.message));
  };

  // runner の timeout-* イベントを Discord メッセージ更新に紐付け
  const runnerEmitter = agentRunner as unknown as {
    on?: (e: string, l: (p: unknown) => void) => void;
  };
  if (typeof runnerEmitter.on === 'function') {
    runnerEmitter.on('timeout-started', (payload: unknown) => {
      const p = payload as { channelId?: string };
      if (!p.channelId) return;
      const entry = discordProcessingMessages.get(p.channelId);
      if (!entry) return; // Discord 経由でなければ無視 (web/slack 等は別経路)
      // 初回描画
      refreshDiscordProcessingButtons(p.channelId);
      // 10 秒ごとの補完用 dedicated interval。
      // 通常は processPrompt の thinking/stream interval が毎秒 message.edit するときに
      // 一緒に components (Stop/延長/⏱) を最新化するので、追加 API call なしで 1 秒粒度更新が成立する。
      // ここはストリーミングが止まったまま長引いた場合や、tool 連続呼び出しで edit が
      // 走らない隙間に残り時間が遅れないようにする補完。
      if (entry.intervalId) clearInterval(entry.intervalId);
      entry.intervalId = setInterval(() => {
        const info = getDiscordTimeoutInfo(p.channelId!);
        if (!info) {
          if (entry.intervalId) clearInterval(entry.intervalId);
          return;
        }
        refreshDiscordProcessingButtons(p.channelId!);
      }, 10_000);
    });
    runnerEmitter.on('timeout-extended', (payload: unknown) => {
      const p = payload as { channelId?: string };
      if (!p.channelId) return;
      refreshDiscordProcessingButtons(p.channelId);
    });
    runnerEmitter.on('timeout-cleared', (payload: unknown) => {
      const p = payload as { channelId?: string };
      if (!p.channelId) return;
      const entry = discordProcessingMessages.get(p.channelId);
      if (!entry) return;
      if (entry.intervalId) clearInterval(entry.intervalId);
      discordProcessingMessages.delete(p.channelId);
    });
  }

  // スキルを読み込み
  const workdir = config.agent.config.workdir || process.cwd();
  let skills: Skill[] = loadSkills(workdir);
  console.log(`[xangi] Loaded ${skills.length} skills from ${workdir}`);

  // dataDir（永続データの保存先）を決定
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');

  // dataDir を排他ロック
  // 同じ dataDir を複数の xangi インスタンスで共有すると sessions.json の
  // 取り合いが起き、在庫が消える事故になる（過去事例: dev/borot 同時稼働で
  // 新規 web セッションが古い in-memory state で上書き消去）。
  const releaseDataDirLock = await acquireDataDirLock(dataDir);

  // 設定を初期化（dataDir 配下の settings.json を使用）
  initSettings(dataDir);
  const initialSettings = loadSettings();
  console.log(`[xangi] Settings loaded: autoRestart=${initialSettings.autoRestart}`);

  // スケジューラを初期化（ワークスペースの .xangi を使用）
  const scheduler = new Scheduler(dataDir);

  // セッション永続化を初期化
  initSessions(dataDir);

  // 外部イベントストリーム (pull 型 SSE) の設定をログ出力。
  // 実際の購読 URL は web-chat 起動時に Tailscale 解決込みで `[xangi-events (SSE)]
  // Access URLs:` として表示される。
  const eventsCfg = getEventsConfig();
  if (eventsCfg.enabled) {
    const note =
      eventsCfg.instanceIdSource === 'auto'
        ? 'auto-generated; set XANGI_INSTANCE_ID to override'
        : 'from XANGI_INSTANCE_ID';
    console.log(
      `[xangi-events] enabled, mode=pull (SSE via web-chat), instance_id=${eventsCfg.instanceId} (${note})`
    );
  }

  // WebチャットUI起動
  if (process.env.WEB_CHAT_ENABLED === 'true') {
    startWebChat({ agentRunner });
  }

  // LINE Bot 起動 (Tailscale Funnel 等で外部公開して webhook を受ける想定)
  if (config.line.enabled) {
    startLineBot({
      agentRunner,
      channelSecret: config.line.channelSecret!,
      channelAccessToken: config.line.channelAccessToken!,
      allowedUsers: lineAllowed,
      port: config.line.webhookPort,
      path: config.line.webhookPath,
      loadingAnimationEnabled: config.line.loadingAnimationEnabled,
      loadingAnimationSeconds: config.line.loadingAnimationSeconds,
      slowResponseEnabled: config.line.slowResponseEnabled,
      slowResponseThresholdMs: config.line.slowResponseThresholdMs,
      idleResetEnabled: config.line.idleResetEnabled,
      idleResetHours: config.line.idleResetHours,
      resetTextPatterns: config.line.resetTextPatterns,
    });
  }

  // インスタンス間チャット起動 (INTER_INSTANCE_CHAT_ENABLED=true のときのみ実体起動)
  const interChatCfg = getInterChatConfig();
  if (interChatCfg.enabled) {
    startInterInstanceChat();
  }

  // GitHub認証を初期化（秘密鍵をメモリに読み込む）
  const { initGitHubAuth } = await import('./github-auth.js');
  initGitHubAuth();

  // ツール承認の有効/無効（デフォルト無効）
  if (process.env.APPROVAL_ENABLED === 'true') {
    setApprovalEnabled(true);
  }

  // スラッシュコマンド定義
  const commands: ReturnType<SlashCommandBuilder['toJSON']>[] = [
    new SlashCommandBuilder().setName('new').setDescription('新しいセッションを開始する').toJSON(),
    new SlashCommandBuilder().setName('stop').setDescription('実行中のタスクを停止する').toJSON(),
    new SlashCommandBuilder()
      .setName('skills')
      .setDescription('利用可能なスキル一覧を表示')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('skill')
      .setDescription('スキルを実行する')
      .addStringOption((option) =>
        option.setName('name').setDescription('スキル名').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) => option.setName('args').setDescription('引数').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName('settings').setDescription('現在の設定を表示する').toJSON(),
    new SlashCommandBuilder().setName('restart').setDescription('ボットを再起動する').toJSON(),
    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('許可確認をスキップしてメッセージを実行')
      .addStringOption((option) =>
        option.setName('message').setDescription('実行するメッセージ').setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('schedule')
      .setDescription('スケジュール管理')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('スケジュールを追加')
          .addStringOption((opt) =>
            opt
              .setName('input')
              .setDescription('例: "30分後 ミーティング" / "毎日 9:00 おはよう"')
              .setRequired(true)
          )
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('スケジュール一覧を表示'))
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('スケジュールを削除')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('スケジュールID').setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('スケジュールの有効/無効を切り替え')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('スケジュールID').setRequired(true)
          )
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('backend')
      .setDescription('バックエンド/モデルの切り替え')
      .addSubcommand((sub) => sub.setName('show').setDescription('現在のバックエンド設定を表示'))
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('バックエンド/モデルを設定')
          .addStringOption((opt) =>
            opt
              .setName('type')
              .setDescription('バックエンド名')
              .setRequired(true)
              .addChoices(
                { name: 'Claude Code', value: 'claude-code' },
                { name: 'Codex', value: 'codex' },
                { name: 'Gemini', value: 'gemini' },
                { name: 'Local LLM', value: 'local-llm' }
              )
          )
          .addStringOption((opt) => opt.setName('model').setDescription('モデル名'))
          .addStringOption((opt) =>
            opt
              .setName('effort')
              .setDescription('effortレベル（Claude Code用）')
              .addChoices(
                { name: 'デフォルト', value: 'none' },
                { name: 'low', value: 'low' },
                { name: 'medium', value: 'medium' },
                { name: 'high', value: 'high' },
                { name: 'max', value: 'max' }
              )
          )
      )
      .addSubcommand((sub) => sub.setName('reset').setDescription('デフォルトに戻す'))
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('利用可能なバックエンド一覧を表示')
      )
      .toJSON(),
  ];

  // ALLOW_AUTOREPLY_COMMAND=true の場合のみコマンドを登録
  if (config.discord.allowAutoreplyCommand) {
    commands.push(
      new SlashCommandBuilder()
        .setName('autoreply')
        .setDescription('このチャンネルのメンションなし応答を切り替え')
        .toJSON()
    );
  }

  // ALLOW_RESPOND_TO_BOTS_COMMAND=true の場合のみコマンドを登録
  if (config.discord.allowRespondToBotsCommand) {
    commands.push(
      new SlashCommandBuilder()
        .setName('respondtobots')
        .setDescription(
          'bot メッセージへの応答を ON/OFF 切替 (反応対象は RESPOND_TO_BOTS 環境変数)'
        )
        .toJSON()
    );
  }

  // ALLOW_LLM_MODE_COMMAND=true の場合のみコマンドを登録（Local LLM 動作モード切替）
  if (config.discord.allowLlmModeCommand) {
    commands.push(
      new SlashCommandBuilder()
        .setName('llmmode')
        .setDescription(
          'このチャンネルの Local LLM 動作モードを切替 (agent/lite/chat/default/show)'
        )
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('モード')
            .setRequired(true)
            .addChoices(
              { name: 'agent (全機能ON、複雑タスク向け)', value: 'agent' },
              { name: 'lite (skills OFF、軽量、Discord 操作向け)', value: 'lite' },
              { name: 'chat (全機能OFF、純粋会話)', value: 'chat' },
              { name: 'default (チャンネル override 削除、起動時値に戻す)', value: 'default' },
              { name: 'show (現在の設定を表示)', value: 'show' }
            )
        )
        .toJSON()
    );
  }

  // 各スキルを個別のスラッシュコマンドとして追加
  for (const skill of skills) {
    // Discordコマンド名は小文字英数字とハイフンのみ（最大32文字）
    const cmdName = skill.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);

    if (cmdName) {
      commands.push(
        new SlashCommandBuilder()
          .setName(cmdName)
          .setDescription(skill.description.slice(0, 100) || `${skill.name}スキルを実行`)
          .addStringOption((option) =>
            option.setName('args').setDescription('引数（任意）').setRequired(false)
          )
          .toJSON()
      );
    }
  }

  // スラッシュコマンド登録
  client.once(Events.ClientReady, async (c) => {
    console.log(`[xangi] Ready! Logged in as ${c.user.tag}`);

    // ツール承認サーバー起動（Claude Code PreToolUseフック用）
    const { startApprovalServer } = await import('./approval-server.js');
    startApprovalServer(async (toolName, toolInput, dangerDescription) => {
      // 最初のauto-replyチャンネルに承認メッセージを送信
      const approvalChannelId = config.discord.autoReplyChannels?.[0];
      if (!approvalChannelId) return true; // チャンネル未設定なら許可
      const channel = c.channels.cache.get(approvalChannelId);
      if (!channel || !('send' in channel)) return true;

      const command =
        toolName === 'Bash'
          ? String((toolInput as Record<string, unknown>).command || '').slice(0, 200)
          : `${toolName}: ${String((toolInput as Record<string, unknown>).file_path || '')}`;

      return requestApproval(
        approvalChannelId,
        { command, matches: dangerDescription },
        (approvalId, danger) => {
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`xangi_approve_${approvalId}`)
              .setLabel('許可')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`xangi_deny_${approvalId}`)
              .setLabel('拒否')
              .setStyle(ButtonStyle.Danger)
          );
          (channel as unknown as { send: (opts: unknown) => Promise<unknown> }).send({
            content: `⚠️ **危険なコマンドを検知**\n\`\`\`\n${danger.command}\n\`\`\`\n${danger.matches.join(', ')}\n\n2分以内に応答がなければ自動拒否`,
            components: [row],
          });
        }
      );
    });

    // ツールサーバー起動（Claude Codeからcurlで叩くAPI）
    const { startToolServer } = await import('./tool-server.js');
    startToolServer();

    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    try {
      // ギルドコマンドとして登録（即時反映）
      const guilds = c.guilds.cache;
      console.log(`[xangi] Found ${guilds.size} guilds`);

      for (const [guildId, guild] of guilds) {
        // 起動時に全 channel を fetch して cache を確実に更新。
        // 起動後に作成された channel が gateway 経由の MessageCreate event を
        // 受け取れない症状 (キャッシュ不整合) を防ぐ。
        try {
          const chs = await guild.channels.fetch();
          console.log(`[xangi] Refreshed channel cache for ${guild.name}: ${chs.size} channels`);
        } catch (e) {
          console.warn(`[xangi] Failed to refresh channels for ${guild.name}:`, e);
        }

        await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), {
          body: commands,
        });
        console.log(`[xangi] ${commands.length} slash commands registered for: ${guild.name}`);
      }

      // グローバルコマンドをクリア（重複防止）
      await rest.put(Routes.applicationCommands(c.user.id), { body: [] });
      console.log('[xangi] Cleared global commands');
    } catch (error) {
      console.error('[xangi] Failed to register slash commands:', error);
    }
  });

  // スラッシュコマンド処理
  client.on(Events.InteractionCreate, async (interaction) => {
    // オートコンプリート処理
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, skills);
      return;
    }

    // ボタンインタラクション処理
    if (interaction.isButton()) {
      const channelId = interaction.channelId;
      // 許可チェック
      if (
        !config.discord.allowedUsers?.includes('*') &&
        !config.discord.allowedUsers?.includes(interaction.user.id)
      ) {
        await interaction.reply({ content: '許可されていないユーザーです', ephemeral: true });
        return;
      }

      if (interaction.customId === 'xangi_stop') {
        const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
        await interaction.deferUpdate().catch(() => {});
        if (!stopped) {
          await interaction.followUp({
            content: '実行中のタスクがありません',
            ephemeral: true,
          });
        }
        return;
      }

      if (interaction.customId === 'xangi_extend') {
        // additionalMs を省略して runner 側の「残り時間 2 倍」デフォルト挙動を使う
        const result = agentRunner.extendTimeout?.(channelId) ?? {
          ok: false,
          reason: 'unsupported' as const,
        };
        if (result.ok) {
          await interaction.deferUpdate().catch(() => {});
          // メッセージ自体は timeout-extended イベントで refresh される
        } else {
          const text =
            result.reason === 'max_timeout_exceeded'
              ? '⏱ 上限に達したため延長できません'
              : result.reason === 'no_active_request'
                ? '⏱ 処理中のリクエストがありません'
                : '⏱ このバックエンドでは延長できません';
          await interaction.reply({ content: text, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // 表示専用ボタン (残り時間バッジ) — クリックされても何もしない
      if (interaction.customId === 'xangi_timeout_display') {
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      if (interaction.customId === 'xangi_new') {
        deleteSession(channelId);
        agentRunner.destroy?.(channelId);
        // ボタンを消してメッセージを更新
        await interaction
          .update({
            components: [],
          })
          .catch(() => {});
        await interaction
          .followUp({ content: '🆕 新しいセッションを開始しました', ephemeral: true })
          .catch(() => {});
        return;
      }

      // 承認ボタン
      if (interaction.customId.startsWith('xangi_approve_')) {
        const approvalId = interaction.customId.replace('xangi_approve_', '');
        resolveApproval(approvalId, true);
        await interaction.update({ content: '✅ 許可しました', components: [] }).catch(() => {});
        return;
      }
      if (interaction.customId.startsWith('xangi_deny_')) {
        const approvalId = interaction.customId.replace('xangi_deny_', '');
        resolveApproval(approvalId, false);
        await interaction.update({ content: '❌ 拒否しました', components: [] }).catch(() => {});
        return;
      }

      // 未知のボタン → 何もせずACK
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // 許可リストチェック（"*" で全員許可）
    if (
      !config.discord.allowedUsers?.includes('*') &&
      !config.discord.allowedUsers?.includes(interaction.user.id)
    ) {
      await interaction.reply({ content: '許可されていないユーザーです', ephemeral: true });
      return;
    }

    const channelId = interaction.channelId;

    if (interaction.commandName === 'new') {
      deleteSession(channelId);
      agentRunner.destroy?.(channelId);
      await interaction.reply('🆕 新しいセッションを開始しました');
      return;
    }

    if (interaction.commandName === 'stop') {
      const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
      if (stopped) {
        await interaction.reply('🛑 タスクを停止しました');
      } else {
        await interaction.reply({ content: '実行中のタスクはありません', ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'settings') {
      const settings = loadSettings();
      await interaction.reply(formatSettings(settings));
      return;
    }

    if (interaction.commandName === 'backend') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'show') {
        const resolved = agentRunner.resolveForChannel(channelId);
        const override = resolver.getChannelOverride(channelId);
        const defaultRes = resolver.getDefault();
        const lines = [
          `**現在のバックエンド設定** (<#${channelId}>)`,
          `- バックエンド: **${getBackendDisplayName(resolved.backend)}**`,
        ];
        if (resolved.model) lines.push(`- モデル: ${resolved.model}`);
        if (resolved.effort) lines.push(`- effort: ${resolved.effort}`);
        if (override) {
          lines.push(`- ソース: チャンネル設定`);
        } else {
          lines.push(`- ソース: デフォルト (.env)`);
        }

        // Local LLM のとき詳細情報を併記
        if (resolved.backend === 'local-llm') {
          const llmBase = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434';
          const llmModelEnv = process.env.LOCAL_LLM_MODEL;
          const llmMode = process.env.LOCAL_LLM_MODE ?? 'agent (default)';
          const numCtx = process.env.LOCAL_LLM_NUM_CTX ?? '(モデルデフォルト)';
          const temperature = process.env.LOCAL_LLM_TEMPERATURE ?? '(モデルデフォルト = 1.0)';
          const maxTokens = process.env.LOCAL_LLM_MAX_TOKENS ?? '8192 (default)';
          const thinking = process.env.LOCAL_LLM_THINKING ?? 'false (default)';

          lines.push('', '**Local LLM 詳細:**');
          lines.push(`- base_url: \`${llmBase}\``);
          if (!resolved.model && llmModelEnv) lines.push(`- model (env): \`${llmModelEnv}\``);
          lines.push(`- mode: \`${llmMode}\``);
          lines.push(`- num_ctx: \`${numCtx}\``);
          lines.push(`- temperature: \`${temperature}\``);
          lines.push(`- max_tokens: \`${maxTokens}\``);
          lines.push(`- thinking: \`${thinking}\``);
        }

        lines.push(
          ``,
          `**デフォルト:** ${getBackendDisplayName(defaultRes.backend)}${defaultRes.model ? ` (${defaultRes.model})` : ''}`
        );
        await interaction.reply(lines.join('\n'));
        return;
      }

      if (sub === 'set') {
        const backendValue = interaction.options.getString(
          'type',
          true
        ) as import('./config.js').AgentBackend;
        const modelValue = interaction.options.getString('model') ?? undefined;
        const rawEffort = interaction.options.getString('effort');
        const effortValue =
          rawEffort && rawEffort !== 'none'
            ? (rawEffort as import('./config.js').EffortLevel)
            : undefined;

        // 許可チェック: ALLOWED_BACKENDSが未設定なら切り替え不可
        if (!resolver.isBackendAllowed(backendValue)) {
          const allowedBackends = resolver.getAllowedBackends();
          if (!config.agent.allowedBackends) {
            await interaction.reply({
              content: `❌ バックエンド切り替えが有効になっていません。\n.envに \`ALLOWED_BACKENDS\` を設定してください。`,
              ephemeral: true,
            });
          } else {
            await interaction.reply({
              content: `❌ バックエンド \`${backendValue}\` は許可されていません\n許可: ${allowedBackends.map((b) => getBackendDisplayName(b)).join(', ')}`,
              ephemeral: true,
            });
          }
          return;
        }
        if (modelValue && !resolver.isModelAllowed(modelValue)) {
          await interaction.reply({
            content: `❌ モデル \`${modelValue}\` は許可されていません`,
            ephemeral: true,
          });
          return;
        }

        // Local LLMの場合、Ollamaにモデルが存在するか確認
        if (backendValue === 'local-llm' && modelValue) {
          try {
            const ollamaBase = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434';
            const res = await fetch(`${ollamaBase}/api/tags`, {
              signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
              const data = (await res.json()) as {
                models?: Array<{ name: string }>;
              };
              const modelNames = data.models?.map((m) => m.name) ?? [];
              // "qwen3.5:9b" と "qwen3.5:9b" の完全一致、または "qwen3.5" のようなプレフィックス一致
              const found = modelNames.some(
                (n) => n === modelValue || n.startsWith(modelValue + ':')
              );
              if (!found) {
                await interaction.reply({
                  content: `❌ モデル \`${modelValue}\` はOllamaにインストールされていません\nインストール済み: ${modelNames.map((n) => `\`${n}\``).join(', ')}`,
                  ephemeral: true,
                });
                return;
              }
            }
          } catch {
            // Ollama接続失敗は無視（モデル確認をスキップ）
          }
        }

        // channelOverrides に保存
        resolver.setChannelOverride(channelId, {
          backend: backendValue,
          model: modelValue,
          effort: effortValue,
        });

        // セッション & ランナー破棄
        agentRunner.switchBackend(channelId);

        // 切り替え結果を明確に表示
        const display = getBackendDisplayName(backendValue);
        const resolvedModel =
          modelValue ||
          (backendValue === 'local-llm'
            ? process.env.LOCAL_LLM_MODEL || '(デフォルト)'
            : backendValue === 'claude-code'
              ? process.env.AGENT_MODEL || 'Claude (デフォルト)'
              : '(デフォルト)');
        const lines = [
          `🔄 モデルを切り替えました。新しいセッションを開始します。`,
          `- バックエンド: **${display}**`,
          `- モデル: **${resolvedModel}**`,
        ];
        if (effortValue) lines.push(`- effort: **${effortValue}**`);
        await interaction.reply(lines.join('\n'));
        return;
      }

      if (sub === 'reset') {
        resolver.deleteChannelOverride(channelId);
        agentRunner.switchBackend(channelId);
        const defaultRes = resolver.getDefault();
        await interaction.reply(
          `🔄 デフォルト (**${getBackendDisplayName(defaultRes.backend)}**) に戻しました。新しいセッションを開始します。`
        );
        return;
      }

      if (sub === 'list') {
        await interaction.deferReply();
        const allowed = resolver.getAllowedBackends();
        const allowedModels = resolver.getAllowedModels();
        const defaultRes = resolver.getDefault();
        const lines = ['**利用可能なバックエンド:**'];
        for (const b of allowed) {
          const isDefault = b === defaultRes.backend;
          lines.push(`- ${getBackendDisplayName(b)}${isDefault ? ' (デフォルト)' : ''}`);
        }
        if (allowedModels && allowedModels.length > 0) {
          lines.push('', '**許可モデル:**');
          for (const m of allowedModels) {
            lines.push(`- \`${m}\``);
          }
        }

        // Local LLM モデル一覧を取得（許可されている場合）
        // Ollama (`/api/tags`) と vLLM / OpenAI 互換 (`/v1/models`) の両方に対応
        if (allowed.includes('local-llm')) {
          const llmBase = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434';
          let modelsShown = false;

          // Ollama 経路
          try {
            const res = await fetch(`${llmBase}/api/tags`, {
              signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
              const data = (await res.json()) as {
                models?: Array<{ name: string; size: number }>;
              };
              if (data.models && data.models.length > 0) {
                lines.push('', '**Ollamaモデル（インストール済み）:**');
                for (const m of data.models) {
                  const sizeGB = (m.size / 1e9).toFixed(1);
                  lines.push(`- \`${m.name}\` (${sizeGB}GB)`);
                }
                modelsShown = true;
              }
            }
          } catch {
            // Ollama 未起動・別サーバーの可能性 → fallback へ
          }

          // vLLM / OpenAI 互換経路 (Ollama で取れなかった場合のフォールバック)
          if (!modelsShown) {
            try {
              const res = await fetch(`${llmBase}/v1/models`, {
                signal: AbortSignal.timeout(3000),
              });
              if (res.ok) {
                const data = (await res.json()) as {
                  data?: Array<{ id: string; max_model_len?: number; owned_by?: string }>;
                };
                if (data.data && data.data.length > 0) {
                  lines.push('', '**Local LLM モデル（OpenAI互換API）:**');
                  for (const m of data.data) {
                    const ctx = m.max_model_len
                      ? ` (max_model_len: ${m.max_model_len.toLocaleString()})`
                      : '';
                    const owner = m.owned_by ? ` [${m.owned_by}]` : '';
                    lines.push(`- \`${m.id}\`${ctx}${owner}`);
                  }
                  modelsShown = true;
                }
              }
            } catch {
              // 両方失敗 → 警告表示
            }
          }

          if (!modelsShown) {
            lines.push(
              '',
              `⚠️ Local LLM サーバー (\`${llmBase}\`) からモデル一覧を取得できませんでした。Ollama (\`/api/tags\`) も OpenAI互換 (\`/v1/models\`) も応答なし。`
            );
          }
        }

        if (!config.agent.allowedBackends) {
          lines.push('', '⚠️ `ALLOWED_BACKENDS` が未設定のため、切り替えは無効です。');
        }

        await interaction.editReply(lines.join('\n'));
        return;
      }
    }

    if (interaction.commandName === 'skip') {
      const skipMessage = interaction.options.getString('message', true);
      await interaction.deferReply();

      try {
        const sessionId = getSession(channelId);
        const appSessionId = ensureSession(channelId, { platform: 'discord' });

        // ワンショットのClaudeCodeRunnerを使用（skipPermissionsを確実に反映するため）
        const skipRunner = new ClaudeCodeRunner(config.agent.config);
        const runResult = await skipRunner.run(skipMessage, {
          skipPermissions: true,
          sessionId,
          channelId,
          appSessionId,
        });

        setSession(channelId, runResult.sessionId);

        // ファイルパスを抽出して添付送信
        const filePaths = extractFilePaths(runResult.result);
        const displayText =
          filePaths.length > 0 ? stripFilePaths(runResult.result) : runResult.result;

        const chunks = splitMessage(displayText, DISCORD_SAFE_LENGTH);
        await interaction.editReply(chunks[0] || '✅');
        if (chunks.length > 1 && 'send' in interaction.channel!) {
          const channel = interaction.channel as unknown as {
            send: (content: string) => Promise<unknown>;
          };
          for (let i = 1; i < chunks.length; i++) {
            await channel.send(chunks[i]);
          }
        }

        // ファイル添付送信
        if (filePaths.length > 0 && interaction.channel && 'send' in interaction.channel) {
          try {
            await (
              interaction.channel as unknown as {
                send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
              }
            ).send({
              files: filePaths.map((fp) => ({ attachment: fp })),
            });
            console.log(`[xangi] Sent ${filePaths.length} file(s) via /skip`);
          } catch (err) {
            console.error('[xangi] Failed to send files via /skip:', err);
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        let errorDetail: string;
        if (errorMsg.includes('timed out')) {
          errorDetail = `⏱️ タイムアウトしました`;
        } else if (errorMsg.includes('Process exited unexpectedly')) {
          errorDetail = `💥 AIプロセスが予期せず終了しました`;
        } else if (errorMsg.includes('Circuit breaker')) {
          errorDetail = '🔌 AIプロセスが一時停止中です';
        } else {
          errorDetail = `❌ エラー: ${errorMsg.slice(0, 200)}`;
        }
        await interaction.editReply(errorDetail).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'autoreply') {
      if (!config.discord.allowAutoreplyCommand) {
        await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
        return;
      }
      const chId = interaction.channelId;
      const channels = config.discord.autoReplyChannels ?? [];
      const idx = channels.indexOf(chId);
      const isCurrentlyOn = idx !== -1;

      if (isCurrentlyOn) {
        // OFF: メモリから削除
        channels.splice(idx, 1);
      } else {
        // ON: メモリに追加
        channels.push(chId);
      }
      config.discord.autoReplyChannels = channels;

      // .env に永続化 (Docker 環境で .env ファイルが無い場合は graceful skip)
      const persistResult = updateEnvKeyValue('AUTO_REPLY_CHANNELS', channels.join(','));
      if (!persistResult.ok) {
        console.warn(`[xangi] AUTO_REPLY_CHANNELS persistence skipped: ${persistResult.reason}`);
      }

      const status = isCurrentlyOn ? '❌ OFF' : '✅ ON';
      await interaction.reply(`メンションなし応答: ${status} (<#${chId}>)`);
      return;
    }

    if (interaction.commandName === 'respondtobots') {
      if (!config.discord.allowRespondToBotsCommand) {
        await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
        return;
      }
      const wasEnabled = config.discord.respondToBotsEnabled ?? false;
      const nextEnabled = !wasEnabled;
      config.discord.respondToBotsEnabled = nextEnabled;

      // .env に永続化 (Docker 環境で .env ファイルが無い場合は graceful skip)
      const persistResult = updateEnvKeyValue(
        'RESPOND_TO_BOTS_ENABLED',
        nextEnabled ? 'true' : 'false'
      );
      if (!persistResult.ok) {
        console.warn(
          `[xangi] RESPOND_TO_BOTS_ENABLED persistence skipped: ${persistResult.reason}`
        );
      }

      const whitelist = config.discord.respondToBots ?? [];
      const target =
        whitelist.length === 0
          ? '(RESPOND_TO_BOTS 未設定)'
          : whitelist.includes('*')
            ? '全 bot'
            : whitelist.join(', ');
      const status = nextEnabled ? '✅ ON' : '❌ OFF';
      await interaction.reply(`bot メッセージへの応答: ${status} / 反応対象: ${target}`);
      return;
    }

    if (interaction.commandName === 'llmmode') {
      if (!config.discord.allowLlmModeCommand) {
        await interaction.reply({ content: 'このコマンドは無効です', ephemeral: true });
        return;
      }
      const chId = interaction.channelId;
      const mode = interaction.options.getString('mode', true) as
        | 'agent'
        | 'lite'
        | 'chat'
        | 'default'
        | 'show';

      // show: 現在の設定を表示するだけ
      if (mode === 'show') {
        const current = resolver.getChannelOverride(chId);
        const resolved = resolver.resolve(chId);

        // 起動時 env LOCAL_LLM_MODE（未指定なら 'agent' default）
        const envMode = (process.env.LOCAL_LLM_MODE || '').toLowerCase();
        const startupMode =
          envMode === 'agent' || envMode === 'lite' || envMode === 'chat' ? envMode : 'agent';

        // 実際に適用される mode（チャンネル override 優先、無ければ起動時 env）
        const appliedMode = resolved.localLlmMode ?? startupMode;
        const source = resolved.localLlmMode
          ? 'チャンネル個別 override (CHANNEL_OVERRIDES)'
          : envMode
            ? `起動時 env LOCAL_LLM_MODE=${envMode}`
            : `起動時 default (LOCAL_LLM_MODE 未指定 → agent)`;

        const lines: string[] = [
          `📍 <#${chId}> の Local LLM 設定`,
          ``,
          `**適用中のモード:** \`${appliedMode}\``,
          `**由来:** ${source}`,
          ``,
          `### 設定の内訳`,
          `- backend: \`${resolved.backend}\``,
          `- model: ${resolved.model ? `\`${resolved.model}\`` : '(env デフォルト)'}`,
          `- 起動時 env \`LOCAL_LLM_MODE\`: \`${envMode || '(未指定 → agent)'}\``,
          `- チャンネル override (\`localLlmMode\`): ${current?.localLlmMode ? `\`${current.localLlmMode}\`` : 'なし'}`,
          ``,
          `### モード別の機能`,
          `- \`agent\`: tools / skills / xangi-commands ON、triggers OFF`,
          `- \`lite\`: tools / xangi-commands / triggers ON、skills OFF`,
          `- \`chat\`: 全機能 OFF（純粋会話）`,
        ];
        await interaction.reply(lines.join('\n'));
        return;
      }

      // default: override 削除（その他のフィールドは保持）
      if (mode === 'default') {
        resolver.setChannelLocalLlmMode(chId, null);
        await interaction.reply(`✅ <#${chId}> の Local LLM mode override を削除しました`);
        return;
      }

      // agent / lite / chat: 設定
      resolver.setChannelLocalLlmMode(chId, mode);
      await interaction.reply(`✅ <#${chId}> の Local LLM mode を \`${mode}\` に設定しました`);
      return;
    }

    if (interaction.commandName === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        await interaction.reply('⚠️ 自動再起動が無効です。先に有効にしてください。');
        return;
      }
      await interaction.reply('🔄 再起動します...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    if (interaction.commandName === 'schedule') {
      await handleScheduleCommand(interaction, scheduler, config.scheduler);
      return;
    }

    if (interaction.commandName === 'skills') {
      // スキルを再読み込み
      skills = loadSkills(workdir);
      await interaction.reply(formatSkillList(skills));
      return;
    }

    if (interaction.commandName === 'skill') {
      await handleSkill(interaction, agentRunner, config, channelId);
      return;
    }

    // 個別スキルコマンドの処理
    const matchedSkill = skills.find((s) => {
      const cmdName = s.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
      return cmdName === interaction.commandName;
    });

    if (matchedSkill) {
      await handleSkillCommand(interaction, agentRunner, config, channelId, matchedSkill.name);
      return;
    }
  });

  // Discordリンクからメッセージ内容を取得する関数
  async function fetchDiscordLinkContent(text: string): Promise<string> {
    const linkRegex = /https?:\/\/(?:www\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;
    const matches = [...text.matchAll(linkRegex)];

    if (matches.length === 0) return text;

    let result = text;
    for (const match of matches) {
      const [fullUrl, , channelId, messageId] = match;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'messages' in channel) {
          const fetchedMessage = await channel.messages.fetch(messageId);
          const author = fetchedMessage.author.tag;
          const content = fetchedMessage.content || '(添付ファイルのみ)';
          const attachmentInfo =
            fetchedMessage.attachments.size > 0
              ? `\n[添付: ${fetchedMessage.attachments.map((a) => a.name).join(', ')}]`
              : '';

          const quotedContent = `\n---\n📎 引用メッセージ (${author}):\n${content}${attachmentInfo}\n---\n`;
          result = result.replace(fullUrl, quotedContent);
          console.log(`[xangi] Fetched linked message from channel ${channelId}`);
        }
      } catch (err) {
        console.error(`[xangi] Failed to fetch linked message: ${fullUrl}`, err);
        // 取得失敗時はリンクをそのまま残す
      }
    }

    return result;
  }

  // 返信元メッセージを取得してプロンプトに追加する関数
  async function fetchReplyContent(message: Message): Promise<string | null> {
    if (!message.reference?.messageId) return null;

    try {
      const channel = message.channel;
      if (!('messages' in channel)) return null;

      const repliedMessage = await channel.messages.fetch(message.reference.messageId);
      const author = repliedMessage.author.tag;
      const content = repliedMessage.content || '(添付ファイルのみ)';
      const attachmentInfo =
        repliedMessage.attachments.size > 0
          ? `\n[添付: ${repliedMessage.attachments.map((a) => a.name).join(', ')}]`
          : '';

      console.log(`[xangi] Fetched reply-to message from ${author}`);
      return `\n---\n💬 返信元 (${author}):\n${content}${attachmentInfo}\n---\n`;
    } catch (err) {
      console.error(`[xangi] Failed to fetch reply-to message:`, err);
      return null;
    }
  }

  /**
   * メッセージコンテンツ内のチャンネルメンション <#ID> を無害化する
   * fetchChannelMessages() による意図しない二重展開を防ぐ
   */
  function sanitizeChannelMentions(content: string): string {
    return content.replace(/<#(\d+)>/g, '#$1');
  }

  // チャンネルメンションから最新メッセージを取得する関数
  async function fetchChannelMessages(text: string): Promise<string> {
    const channelMentionRegex = /<#(\d+)>/g;
    const matches = [...text.matchAll(channelMentionRegex)];

    if (matches.length === 0) return text;

    let result = text;
    for (const match of matches) {
      const [fullMention, channelId] = match;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'messages' in channel) {
          const messages = await channel.messages.fetch({ limit: 10 });
          const channelName = 'name' in channel ? channel.name : 'unknown';

          const messageList = messages
            .reverse()
            .map((m) => {
              const time = m.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
              const content = sanitizeChannelMentions(m.content || '(添付ファイルのみ)');
              return `[${time}] ${m.author.tag}: ${content}`;
            })
            .join('\n');

          const expandedContent = `\n---\n📺 #${channelName} の最新メッセージ:\n${messageList}\n---\n`;
          result = result.replace(fullMention, expandedContent);
          console.log(`[xangi] Fetched messages from channel #${channelName}`);
        }
      } catch (err) {
        console.error(`[xangi] Failed to fetch channel messages: ${channelId}`, err);
      }
    }

    return result;
  }

  /**
   * チャンネルメンション <#ID> にチャンネルID注釈を追加
   * 例: <#123456> → <#123456> [チャンネルID: 123456]
   */
  function annotateChannelMentions(text: string): string {
    return text.replace(/<#(\d+)>/g, (match, id) => `${match} [チャンネルID: ${id}]`);
  }

  // Discord APIエラーでプロセスが落ちないようにハンドリング
  client.on('error', (error) => {
    console.error('[xangi] Discord client error:', error.message);
  });

  // チャンネル単位の処理中ロック
  const processingChannels = new Set<string>();

  // 同じ bot からの連続返信を制限するためのカウンタ (channelId → {lastBotId, count})。
  // 別 bot や人間のメッセージが入ったらリセット。RESPOND_TO_BOTS_MAX_CONSECUTIVE で上限制御。
  const consecutiveBotResponses = new Map<string, { lastBotId: string; count: number }>();

  // Discord でユーザがメッセージを編集 → transcript jsonl にも反映する。
  // 対象は active session の jsonl のみ。古いセッションの履歴は対象外
  // (パフォーマンスとマルチセッション衝突回避のため、active のみ)。
  client.on(Events.MessageUpdate, async (_oldMsg, newMsg) => {
    try {
      if (newMsg.partial) {
        try {
          await newMsg.fetch();
        } catch {
          return; // 取得に失敗 (権限不足や削除済み) → 諦める
        }
      }
      if (newMsg.author?.bot) return; // bot 自身の edit (= xangi のストリーム edit) は無視
      const channelId = newMsg.channelId;
      if (!channelId) return;
      const appSessionId = getActiveSessionId(channelId);
      if (!appSessionId) return;

      const entry = findEntryByPlatformMessageId(workdir, appSessionId, newMsg.id);
      if (!entry) return;

      const newContent = newMsg.content ?? '';
      updateTranscriptContent(workdir, appSessionId, entry.id, newContent);
      console.log(
        `[xangi] Synced Discord edit (${newMsg.id}) → transcript ${entry.id} in session ${appSessionId}`
      );
    } catch (err) {
      console.warn('[xangi] Failed to sync Discord edit:', err);
    }
  });

  // Discord でメッセージが削除 → transcript jsonl からも該当行を削除。
  // ユーザの自分メッセージ削除と xangi 自身の bot メッセージ削除の両方に反応
  // (どちらでも platformMessageId が一致すれば削除する)。
  client.on(Events.MessageDelete, async (msg) => {
    try {
      const channelId = msg.channelId;
      if (!channelId) return;
      const appSessionId = getActiveSessionId(channelId);
      if (!appSessionId) return;

      const entry = findEntryByPlatformMessageId(workdir, appSessionId, msg.id);
      if (!entry) return;

      deleteTranscriptMessage(workdir, appSessionId, entry.id);
      console.log(
        `[xangi] Synced Discord delete (${msg.id}) → transcript ${entry.id} in session ${appSessionId}`
      );
    } catch (err) {
      console.warn('[xangi] Failed to sync Discord delete:', err);
    }
  });

  // メッセージ処理
  client.on(Events.MessageCreate, async (message) => {
    let isFromAllowedBot = false;
    if (message.author.bot) {
      // 自分自身のメッセージには絶対に反応しない (無限ループ防止)
      if (message.author.id === client.user?.id) return;
      // 機能が OFF なら他 bot メッセージは無視 (既存動作)
      if (!config.discord.respondToBotsEnabled) return;
      // ホワイトリスト判定 (RESPOND_TO_BOTS env / `*` で全許可)
      const allowedBots = config.discord.respondToBots ?? [];
      const allowAll = allowedBots.includes('*');
      const isAllowed = allowAll || allowedBots.includes(message.author.id);
      if (!isAllowed) return;
      // 連続返信制限チェック (default 3 回、0 以下は無制限)
      const maxConsec = config.discord.respondToBotsMaxConsecutive ?? 3;
      if (maxConsec > 0) {
        const counter = consecutiveBotResponses.get(message.channel.id);
        if (counter && counter.lastBotId === message.author.id) {
          if (counter.count >= maxConsec) {
            console.log(
              `[xangi] Consecutive bot response limit reached (${maxConsec}) for bot ${message.author.id} in channel ${message.channel.id}, skipping`
            );
            return;
          }
          counter.count += 1;
        } else {
          consecutiveBotResponses.set(message.channel.id, {
            lastBotId: message.author.id,
            count: 1,
          });
        }
      }
      // bot メッセージだが許可された相手 → 続行 (allowedUsers チェックはバイパス)
      isFromAllowedBot = true;
    } else {
      // 人間のメッセージが入ったら、そのチャンネルの連鎖カウンタをリセット
      consecutiveBotResponses.delete(message.channel.id);
    }

    const isMentioned = message.mentions.has(client.user!);
    const isDM = !message.guild;
    const isAutoReplyChannel =
      config.discord.autoReplyChannels?.includes(message.channel.id) ?? false;

    if (!isMentioned && !isDM && !isAutoReplyChannel) return;

    // 同じチャンネルで処理中なら無視（メンション時は除く）
    if (!isMentioned && processingChannels.has(message.channel.id)) {
      console.log(`[xangi] Skipping message in busy channel: ${message.channel.id}`);
      return;
    }

    if (
      !isFromAllowedBot &&
      !config.discord.allowedUsers?.includes('*') &&
      !config.discord.allowedUsers?.includes(message.author.id)
    ) {
      console.log(`[xangi] Unauthorized user: ${message.author.id} (${message.author.tag})`);
      return;
    }

    let prompt = message.content
      .replace(/<@[!&]?\d+>/g, '') // ユーザーメンションのみ削除（チャンネルメンションは残す）
      .replace(/\s+/g, ' ')
      .trim();

    // スキップ設定（返信元追加やリンク展開の前に判定する）
    // !skip プレフィックスで一時的にスキップモードにできる
    let skipPermissions = config.agent.config.skipPermissions ?? false;

    if (prompt.startsWith('!skip')) {
      skipPermissions = true;
      prompt = prompt.replace(/^!skip\s*/, '').trim();
    }

    // Discordリンクからメッセージ内容を取得
    prompt = await fetchDiscordLinkContent(prompt);

    // 返信元メッセージを取得してプロンプトに追加
    const replyContent = await fetchReplyContent(message);
    if (replyContent) {
      prompt = replyContent + prompt;
    }

    // チャンネルメンションにID注釈を追加（展開前に実行）
    prompt = annotateChannelMentions(prompt);

    // チャンネルメンションから最新メッセージを取得
    prompt = await fetchChannelMessages(prompt);

    // 添付ファイルをダウンロード
    const attachmentPaths: string[] = [];
    if (message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        try {
          const filePath = await downloadFile(attachment.url, attachment.name || 'file');
          attachmentPaths.push(filePath);
        } catch (err) {
          console.error(`[xangi] Failed to download attachment: ${attachment.name}`, err);
        }
      }
    }

    // テキストも添付もない場合はスキップ
    if (!prompt && attachmentPaths.length === 0) return;

    // 添付ファイル情報をプロンプトに追加
    prompt = buildPromptWithAttachments(
      prompt || '添付ファイルを確認してください',
      attachmentPaths
    );

    const channelId = message.channel.id;

    // チャンネルトピック（概要）をプロンプトに注入
    if (config.discord.injectChannelTopic !== false) {
      const channel = message.channel;
      if ('topic' in channel && channel.topic) {
        prompt += `\n\n[チャンネルルール（必ず従うこと）]\n${channel.topic}`;
      }
    }

    // タイムスタンプをプロンプトの先頭に注入
    if (config.discord.injectTimestamp !== false) {
      const d = new Date();
      const now = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });
      prompt = `[現在時刻: ${now}(${day})]\n${prompt}`;
    }

    processingChannels.add(channelId);
    try {
      await processPrompt(message, agentRunner, prompt, skipPermissions, channelId, config);
    } finally {
      processingChannels.delete(channelId);
    }
  });

  // Discordボットを起動
  if (config.discord.enabled) {
    await client.login(config.discord.token);
    console.log('[xangi] Discord bot started');

    // スケジューラにDiscord送信関数を登録
    scheduler.registerSender('discord', async (channelId, msg) => {
      const channel = await client.channels.fetch(channelId);
      if (channel && 'send' in channel) {
        await (channel as { send: (content: string) => Promise<unknown> }).send(msg);
      }
    });

    // スケジューラにエージェント実行関数を登録
    scheduler.registerAgentRunner('discord', async (prompt, channelId) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        throw new Error(`Channel not found: ${channelId}`);
      }

      // 処理中メッセージを送信
      const thinkingMsg = await (
        channel as {
          send: (content: string) => Promise<{ edit: (content: string) => Promise<unknown> }>;
        }
      ).send('🤔 考え中...');

      try {
        // タイムスタンプをプロンプトの先頭に注入
        let agentPrompt = prompt;
        if (config.discord.injectTimestamp !== false) {
          const d = new Date();
          const now = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
          const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });
          agentPrompt = `[現在時刻: ${now}(${day})]\n${agentPrompt}`;
        }

        // スケジューラーは毎回新規セッション（stateless）
        const schedAppSessionId = ensureSession(channelId, {
          platform: 'discord',
          scope: 'scheduler',
        });
        const { result, sessionId: newSessionId } = await agentRunner.run(agentPrompt, {
          skipPermissions: config.agent.config.skipPermissions ?? false,
          sessionId: undefined,
          channelId,
          appSessionId: schedAppSessionId,
        });

        // スケジューラーのセッションは scheduler スコープで保存
        setSession(channelId, newSessionId, 'scheduler');

        // 結果を送信
        const filePaths = extractFilePaths(result);
        const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

        // === セパレータで明示的に分割（content-digest等で複数投稿を1応答に含める用途）
        // LLMが前後に空白や余分な改行を入れることがあるため、正規表現で緩くマッチ
        const SEPARATOR_REGEX = /\n\s*===\s*\n/;
        const messageParts = SEPARATOR_REGEX.test(displayText)
          ? displayText
              .split(SEPARATOR_REGEX)
              .map((p) => p.trim())
              .filter(Boolean)
          : [displayText];

        // 最初のパートは既存のthinkingMsgを編集して送信
        const firstChunks = splitMessage(messageParts[0], DISCORD_SAFE_LENGTH);
        await thinkingMsg.edit(firstChunks[0] || '✅');
        const ch = channel as { send: (content: string) => Promise<unknown> };
        // 最初のパートの残りチャンク
        for (let i = 1; i < firstChunks.length; i++) {
          await ch.send(firstChunks[i]);
        }
        // 2つ目以降のパートは新規メッセージとして送信
        for (let p = 1; p < messageParts.length; p++) {
          const chunks = splitMessage(messageParts[p], DISCORD_SAFE_LENGTH);
          for (const chunk of chunks) {
            await ch.send(chunk);
          }
        }

        if (filePaths.length > 0) {
          await (
            channel as { send: (options: { files: { attachment: string }[] }) => Promise<unknown> }
          ).send({
            files: filePaths.map((fp) => ({ attachment: fp })),
          });
        }

        return result;
      } catch (error) {
        if (error instanceof Error && error.message === 'Request cancelled by user') {
          await thinkingMsg.edit('🛑 タスクを停止しました');
        } else {
          const errorMsg = error instanceof Error ? error.message : String(error);
          let errorDetail: string;
          if (errorMsg.includes('timed out')) {
            errorDetail = `⏱️ タイムアウトしました`;
          } else if (errorMsg.includes('Process exited unexpectedly')) {
            errorDetail = `💥 AIプロセスが予期せず終了しました`;
          } else if (errorMsg.includes('Circuit breaker')) {
            errorDetail = '🔌 AIプロセスが一時停止中です';
          } else {
            errorDetail = `❌ エラー: ${errorMsg.slice(0, 200)}`;
          }
          await thinkingMsg.edit(errorDetail);
        }
        throw error;
      }
    });
  }

  // Slackボットを起動
  if (config.slack.enabled) {
    await startSlackBot({
      config,
      agentRunner,
      skills,
      reloadSkills: () => {
        skills = loadSkills(workdir);
        return skills;
      },
      scheduler,
    });
    console.log('[xangi] Slack bot started');
  }

  const webChatEnabled = process.env.WEB_CHAT_ENABLED === 'true';
  if (!config.discord.enabled && !config.slack.enabled && !webChatEnabled && !config.line.enabled) {
    console.error(
      '[xangi] No chat platform enabled. Set DISCORD_TOKEN, SLACK_BOT_TOKEN/SLACK_APP_TOKEN, WEB_CHAT_ENABLED=true, or LINE_CHANNEL_ACCESS_TOKEN+LINE_CHANNEL_SECRET'
    );
    process.exit(1);
  }

  // スケジューラの全ジョブを開始
  scheduler.startAll(config.scheduler);

  // シャットダウン時にスケジューラを停止し、dataDir ロックを解放
  const shutdown = async () => {
    console.log('[xangi] Shutting down scheduler...');
    scheduler.stopAll();
    if (releaseDataDirLock) {
      try {
        await releaseDataDirLock();
      } catch {
        // 解放に失敗しても次起動時に stale 検出で回収される
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  skills: Skill[]
): Promise<void> {
  const focusedValue = interaction.options.getFocused().toLowerCase();

  const filtered = skills
    .filter(
      (skill) =>
        skill.name.toLowerCase().includes(focusedValue) ||
        skill.description.toLowerCase().includes(focusedValue)
    )
    .slice(0, 25) // Discord制限: 最大25件
    .map((skill) => ({
      name: `${skill.name} - ${skill.description.slice(0, 50)}`,
      value: skill.name,
    }));

  await interaction.respond(filtered);
}

async function handleSkill(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>,
  channelId: string
) {
  const skillName = interaction.options.getString('name', true);
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `スキル「${skillName}」を実行してください。${args ? `引数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const appSessionId = ensureSession(channelId, { platform: 'discord' });
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
      appSessionId,
    });

    setSession(channelId, newSessionId);
    const chunks = splitMessage(result, DISCORD_SAFE_LENGTH);
    await interaction.editReply(chunks[0] || '✅');
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (error) {
    console.error('[xangi] Error:', error);
    await interaction.editReply('エラーが発生しました');
  }
}

async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>,
  channelId: string,
  skillName: string
) {
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `スキル「${skillName}」を実行してください。${args ? `引数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const appSessionId = ensureSession(channelId, { platform: 'discord' });
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
      appSessionId,
    });

    setSession(channelId, newSessionId);
    const chunks = splitMessage(result, DISCORD_SAFE_LENGTH);
    await interaction.editReply(chunks[0] || '✅');
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (error) {
    console.error('[xangi] Error:', error);
    await interaction.editReply('エラーが発生しました');
  }
}

async function processPrompt(
  message: Message,
  agentRunner: AgentRunner,
  prompt: string,
  skipPermissions: boolean,
  channelId: string,
  config: ReturnType<typeof loadConfig>
): Promise<string | null> {
  let replyMessage: Message | null = null;
  const toolHistory: string[] = []; // ツール実行履歴（stop時にも参照するため関数スコープ）
  let lastStreamedText = ''; // エラー時に途中テキストを残すため関数スコープ
  // xangi-events 用 ID（fire-and-forget なのでエラーで本業を止めない）
  const threadId = threadIdFor('discord', channelId);
  const turnId = turnIdFor('discord', message.id);
  const channelName = 'name' in message.channel ? (message.channel as { name: string }).name : null;
  const threadLabel = channelName ? `#${channelName}` : 'DM';
  const eventCtx = {
    threadId,
    turnId,
    threadLabel,
    platform: 'discord' as const,
    userText: message.content || undefined,
  };
  try {
    // チャンネル・ユーザー情報をプロンプトに付与
    const userInfo = `[発言者: ${message.author.displayName ?? message.author.username} (ID: ${message.author.id})]`;
    if (channelName) {
      prompt = `[プラットフォーム: Discord]\n[チャンネル: #${channelName} (ID: ${channelId})]\n${userInfo}\n${prompt}`;
    } else {
      prompt = `${userInfo}\n${prompt}`;
    }

    console.log(`[xangi] Processing message in channel ${channelId}`);
    await message.react('👀').catch(() => {});

    const sessionId = getSession(channelId);
    const appSessionId = ensureSession(channelId, { platform: 'discord' });
    const useStreaming = config.discord.streaming ?? true;
    const showThinking = config.discord.showThinking ?? true;

    // !skip プレフィックスの場合、ワンショットランナーを使用
    // （persistent-runner はプロセス起動時の権限設定を変えられないため）
    const defaultSkip = config.agent.config.skipPermissions ?? false;
    const needsSkipRunner = skipPermissions && !defaultSkip;
    const runner: AgentRunner = needsSkipRunner
      ? new ClaudeCodeRunner(config.agent.config)
      : agentRunner;

    if (needsSkipRunner) {
      console.log(`[xangi] Using one-shot skip runner for channel ${channelId}`);
    }

    // 最初のメッセージを送信
    const showButtons = config.discord.showButtons ?? true;
    replyMessage = await message.reply({
      content: '🤔 考え中.',
      ...(showButtons && { components: [createProcessingButtons()] }),
    });

    // タイムアウト UI の自動更新対象として登録 (runner.timeout-* で edit される)
    // runner が agentRunner (DynamicRunnerManager) 経由のときのみ — needsSkipRunner で
    // 別個に作った ClaudeCodeRunner には timeout イベントが流れないのでスキップ
    if (showButtons && !needsSkipRunner) {
      discordProcessingMessages.set(channelId, { message: replyMessage });
    }

    let result: string;
    let newSessionId: string;

    if (useStreaming && showThinking && !needsSkipRunner) {
      // ストリーミング + 思考表示モード（persistent-runner のみ）
      let lastUpdateTime = 0;
      let pendingUpdate = false;
      let firstTextReceived = false;

      // 最初のテキストが届くまで考え中アニメーション
      // テキスト編集と同時に [Stop][延長][⏱ MM:SS] を再生成して残り時間を反映する
      // (Discord edit は components 省略で既存維持だが、ラベル更新したいので毎回付ける)
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        if (firstTextReceived) return;
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        const toolDisplay = toolHistory.length > 0 ? '\n' + toolHistory.join('\n') : '';
        const editPayload: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] } = {
          content: `🤔 考え中${dots}${toolDisplay}`,
        };
        if (showButtons && !needsSkipRunner) {
          editPayload.components = [
            createProcessingButtons(getDiscordTimeoutInfoFor(agentRunner, channelId)),
          ];
        }
        replyMessage!.edit(editPayload).catch(() => {});
      }, 1000);

      let streamResult: { result: string; sessionId: string };
      try {
        streamResult = await runWithBubbleEvents(
          agentRunner,
          prompt,
          eventCtx,
          {
            onText: (_chunk, fullText) => {
              lastStreamedText = fullText;
              if (!firstTextReceived) {
                firstTextReceived = true;
                clearInterval(thinkingInterval);
              }
              const now = Date.now();
              if (now - lastUpdateTime >= STREAM_UPDATE_INTERVAL_MS && !pendingUpdate) {
                pendingUpdate = true;
                lastUpdateTime = now;
                const streamPayload: {
                  content: string;
                  components?: ActionRowBuilder<ButtonBuilder>[];
                } = { content: (fullText + ' ▌').slice(0, DISCORD_MAX_LENGTH) };
                if (showButtons && !needsSkipRunner) {
                  streamPayload.components = [
                    createProcessingButtons(getDiscordTimeoutInfoFor(agentRunner, channelId)),
                  ];
                }
                replyMessage!
                  .edit(streamPayload)
                  .catch((err) => {
                    console.error('[xangi] Failed to edit message:', err.message);
                  })
                  .finally(() => {
                    pendingUpdate = false;
                  });
              }
            },
            onToolUse: (toolName, toolInput) => {
              // ツール実行履歴に追加
              const inputSummary = formatToolInput(toolName, toolInput);
              toolHistory.push(`🔧 ${toolName}${inputSummary}`);
              const toolDisplay = toolHistory.join('\n');
              const toolPayload: {
                content: string;
                components?: ActionRowBuilder<ButtonBuilder>[];
              } = {
                content: firstTextReceived
                  ? `${lastStreamedText || ''}\n\n${toolDisplay} ▌`.slice(0, DISCORD_MAX_LENGTH)
                  : `🤔 考え中...\n${toolDisplay}`,
              };
              if (showButtons && !needsSkipRunner) {
                toolPayload.components = [
                  createProcessingButtons(getDiscordTimeoutInfoFor(agentRunner, channelId)),
                ];
              }
              replyMessage!.edit(toolPayload).catch(() => {});
            },
          },
          {
            skipPermissions,
            sessionId,
            channelId,
            appSessionId,
          }
        );
      } finally {
        clearInterval(thinkingInterval);
      }
      result = streamResult.result;
      newSessionId = streamResult.sessionId;
    } else {
      // 非ストリーミング or ワンショットskipランナー
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        const editPayload: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] } = {
          content: `🤔 考え中${dots}`,
        };
        if (showButtons && !needsSkipRunner) {
          editPayload.components = [
            createProcessingButtons(getDiscordTimeoutInfoFor(agentRunner, channelId)),
          ];
        }
        replyMessage!.edit(editPayload).catch(() => {});
      }, 1000);

      try {
        const runResult = await runWithBubbleEvents(
          runner,
          prompt,
          eventCtx,
          {},
          {
            skipPermissions,
            sessionId,
            channelId,
            appSessionId,
          }
        );
        result = runResult.result;
        newSessionId = runResult.sessionId;
      } finally {
        clearInterval(thinkingInterval);
      }
    }

    setSession(channelId, newSessionId);
    incrementMessageCount(appSessionId);
    // transcript の最後の user / assistant エントリに Discord の messageId を
    // 紐付ける。これがあれば後で messageUpdate / messageDelete から jsonl を
    // 逆引きできる (PR ②)。runner 側を触らず post-hoc で attach する戦略。
    try {
      const tWorkdir = config.agent.config.workdir || process.cwd();
      attachPlatformMessageIdToLast(tWorkdir, appSessionId, 'user', message.id);
      if (replyMessage) {
        attachPlatformMessageIdToLast(tWorkdir, appSessionId, 'assistant', replyMessage.id);
      }
    } catch (err) {
      console.warn('[xangi] Failed to attach platform message ids:', err);
    }
    // 最初のメッセージでタイトル自動設定（既にタイトル付き or 抽出できなければ何もしない）
    const existingEntry = getSessionEntry(appSessionId);
    if (existingEntry && !existingEntry.title) {
      const titleCandidate = stripPromptMetadata(prompt).slice(0, 50);
      if (titleCandidate) {
        updateSessionTitle(appSessionId, titleCandidate);
      }
    }
    console.log(
      `[xangi] Response length: ${result.length}, session: ${newSessionId.slice(0, 8)}...`
    );

    // ファイルパスを抽出して添付送信
    const filePaths = extractFilePaths(result);
    const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

    // === セパレータで明示的に分割（content-digest等で複数投稿を1応答に含める用途）
    // LLMが前後に空白や余分な改行を入れることがあるため、正規表現で緩くマッチ
    const SEPARATOR_REGEX = /\n\s*===\s*\n/;
    const messageParts = SEPARATOR_REGEX.test(displayText)
      ? displayText
          .split(SEPARATOR_REGEX)
          .map((p) => p.trim())
          .filter(Boolean)
      : [displayText];

    // 最初のパートは既存のreplyMessageを編集して送信
    const firstChunks = splitMessage(messageParts[0], DISCORD_SAFE_LENGTH);
    await replyMessage!.edit({
      content: firstChunks[0] || '✅',
      ...(showButtons && { components: [createCompletedButtons()] }),
    });
    if ('send' in message.channel) {
      const channel = message.channel as unknown as {
        send: (content: string) => Promise<unknown>;
      };
      // 最初のパートの残りチャンク
      for (let i = 1; i < firstChunks.length; i++) {
        await channel.send(firstChunks[i]);
      }
      // 2つ目以降のパートは新規メッセージとして送信
      for (let p = 1; p < messageParts.length; p++) {
        const chunks = splitMessage(messageParts[p], DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    }

    if (filePaths.length > 0 && 'send' in message.channel) {
      try {
        await (
          message.channel as unknown as {
            send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
          }
        ).send({
          files: filePaths.map((fp) => ({ attachment: fp })),
        });
        console.log(`[xangi] Sent ${filePaths.length} file(s) to Discord`);
      } catch (err) {
        console.error('[xangi] Failed to send files:', err);
      }
    }

    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'Request cancelled by user') {
      console.log('[xangi] Request cancelled by user');
      const toolDisplay = toolHistory.length > 0 ? '\n' + toolHistory.join('\n') + '\n' : '';
      const prefix = lastStreamedText ? lastStreamedText + '\n\n' : '';
      await replyMessage
        ?.edit({
          content: `${prefix}🛑 停止しました${toolDisplay}`.slice(0, DISCORD_MAX_LENGTH),
          components: [],
        })
        .catch(() => {});
      return null;
    }
    console.error('[xangi] Error:', error);

    // エラーの種類を判別して詳細メッセージを生成
    const errorMsg = error instanceof Error ? error.message : String(error);
    let errorDetail: string;
    if (errorMsg.includes('timed out')) {
      errorDetail = `⏱️ タイムアウトしました（${Math.round((config.agent.config.timeoutMs ?? 300000) / 1000)}秒）`;
    } else if (errorMsg.includes('Process exited unexpectedly')) {
      errorDetail = `💥 AIプロセスが予期せず終了しました: ${errorMsg}`;
    } else if (errorMsg.includes('Circuit breaker')) {
      errorDetail =
        '🔌 AIプロセスが連続でクラッシュしたため一時停止中です。しばらくしてから再試行してください';
    } else {
      errorDetail = `❌ エラーが発生しました: ${errorMsg.slice(0, 200)}`;
    }

    // エラー詳細を表示（途中のテキスト・ツール履歴を残す）
    const toolDisplay = toolHistory.length > 0 ? '\n' + toolHistory.join('\n') : '';
    const prefix = lastStreamedText ? lastStreamedText + '\n\n' : '';
    const errorMessage = `${prefix}${errorDetail}${toolDisplay}`.slice(0, DISCORD_MAX_LENGTH);
    if (replyMessage) {
      await replyMessage.edit({ content: errorMessage, components: [] }).catch(() => {});
    } else {
      await message.reply(errorMessage).catch(() => {});
    }

    // エラー後にエージェントへ自動フォローアップ（タイムアウト・サーキットブレーカー時は除く）
    // タイムアウト時のフォローアップは壊れたセッションにさらに負荷をかけるだけで、
    // 再びタイムアウト→Circuit breaker発動→チャンネルが長時間ロックされる原因になる
    if (!errorMsg.includes('Circuit breaker') && !errorMsg.includes('timed out')) {
      try {
        console.log('[xangi] Sending error follow-up to agent');
        const sessionId = getSession(channelId);
        if (sessionId) {
          const followUpPrompt =
            '先ほどの処理がエラー（タイムアウト等）で中断されました。途中まで行った作業内容と現在の状況を簡潔に報告してください。';
          const followUpAppId = getActiveSessionId(channelId);
          const followUpResult = await agentRunner.run(followUpPrompt, {
            skipPermissions,
            sessionId,
            channelId,
            appSessionId: followUpAppId,
          });
          if (followUpResult.result) {
            setSession(channelId, followUpResult.sessionId);
            const followUpText = followUpResult.result.slice(0, DISCORD_SAFE_LENGTH);
            if ('send' in message.channel) {
              await (
                message.channel as unknown as {
                  send: (content: string) => Promise<unknown>;
                }
              ).send(`📋 **エラー前の作業報告:**\n${followUpText}`);
            }
          }
        }
      } catch (followUpError) {
        console.error('[xangi] Error follow-up failed:', followUpError);
      }
    }

    return null;
  } finally {
    // 👀 リアクションを削除
    await message.reactions.cache
      .find((r) => r.emoji.name === '👀')
      ?.users.remove(message.client.user?.id)
      .catch((err) => {
        console.error('[xangi] Failed to remove 👀 reaction:', err.message || err);
      });
  }
}

// ─── Schedule Handlers ──────────────────────────────────────────────

async function handleScheduleCommand(
  interaction: ChatInputCommandInteraction,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean }
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  switch (subcommand) {
    case 'add': {
      const input = interaction.options.getString('input', true);
      const parsed = parseScheduleInput(input);
      if (!parsed) {
        await interaction.reply({
          content:
            '❌ 入力を解析できませんでした\n\n' +
            '**対応フォーマット:**\n' +
            '• `30分後 メッセージ` — 相対時間\n' +
            '• `15:00 メッセージ` — 時刻指定\n' +
            '• `毎日 9:00 メッセージ` — 毎日定時\n' +
            '• `毎週月曜 10:00 メッセージ` — 週次\n' +
            '• `cron 0 9 * * * メッセージ` — cron式',
          ephemeral: true,
        });
        return;
      }

      try {
        const targetChannel = parsed.targetChannelId || channelId;
        const schedule = scheduler.add({
          ...parsed,
          channelId: targetChannel,
          platform: 'discord' as Platform,
        });

        const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
        const typeLabel = getTypeLabel(schedule.type, {
          expression: schedule.expression,
          runAt: schedule.runAt,
          channelInfo,
        });

        await interaction.reply(
          `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
        );
      } catch (error) {
        await interaction.reply({
          content: `❌ ${error instanceof Error ? error.message : 'エラーが発生しました'}`,
          ephemeral: true,
        });
      }
      return;
    }

    case 'list': {
      // 全スケジュールを表示（チャンネルでフィルタしない）
      const schedules = scheduler.list();
      const content = formatScheduleList(schedules, schedulerConfig);
      if (content.length <= DISCORD_MAX_LENGTH) {
        await interaction.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        await interaction.reply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      }
      return;
    }

    case 'remove': {
      const id = interaction.options.getString('id', true);
      const removed = scheduler.remove(id);
      await interaction.reply(
        removed ? `🗑️ スケジュール \`${id}\` を削除しました` : `❌ ID \`${id}\` が見つかりません`
      );
      return;
    }

    case 'toggle': {
      const id = interaction.options.getString('id', true);
      const schedule = scheduler.toggle(id);
      if (schedule) {
        const status = schedule.enabled ? '✅ 有効' : '⏸️ 無効';
        await interaction.reply(`${status} に切り替えました: \`${id}\``);
      } else {
        await interaction.reply(`❌ ID \`${id}\` が見つかりません`);
      }
      return;
    }
  }
}

main().catch(console.error);
