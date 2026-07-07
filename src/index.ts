import { Client, GatewayIntentBits, Events, Partials, REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { requestApproval, setApprovalEnabled } from './approval.js';
import { getBackendDisplayName } from './agent-runner.js';
import { BackendResolver } from './backend-resolver.js';
import { DynamicRunnerManager } from './dynamic-runner.js';
import { loadSkills } from './skills.js';
import { startSlackBot } from './slack.js';
import { initSettings, loadSettings } from './settings.js';
import lockfile from 'proper-lockfile';
import { Scheduler } from './scheduler.js';
import { initSessions } from './sessions.js';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { startWebChat } from './web-chat.js';
import { startLineBot } from './line.js';
import { formatTelegramError, startTelegramBot } from './telegram.js';
import { getEventsConfig } from './events-emitter.js';
import { startInterInstanceChat, getInterChatConfig } from './inter-instance-chat/index.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { registerDiscordTimeoutUi } from './discord/ui.js';
import {
  buildSlashCommands,
  createInteractionHandler,
  type SkillsRef,
} from './discord/slash-commands.js';
import { registerDiscordMessageHandlers } from './discord/message-handler.js';
import { finalizeActiveStreams } from './stream-finalizer.js';
import { registerDiscordSchedulerBridge } from './discord/scheduler-bridge.js';
import { runShutdownCleanup } from './shutdown.js';
import { getSelfLifecyclePermission } from './self-lifecycle.js';
dotenvConfig({ override: true });

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

async function main() {
  const config = loadConfig();

  // 許可リストのチェック（"*" で全員許可、カンマ区切りで複数ユーザー対応）
  const discordAllowed = config.discord.allowedUsers || [];
  const slackAllowed = config.slack.allowedUsers || [];
  const lineAllowed = config.line.allowedUsers || [];
  const telegramAllowed = config.telegram.allowedUsers || [];

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
  if (config.telegram.enabled && telegramAllowed.length === 0) {
    console.error('[xangi] Error: TELEGRAM_ALLOWED_USER must be set (use "*" to allow everyone)');
    process.exit(1);
  }

  if (config.discord.enabled) {
    if (discordAllowed.includes('*')) {
      console.log('[xangi] Discord: All users are allowed');
    } else {
      console.log(`[xangi] Discord: Allowed users: ${discordAllowed.join(', ')}`);
    }
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
  if (telegramAllowed.includes('*')) {
    console.log('[xangi] Telegram: All users are allowed');
  } else if (telegramAllowed.length > 0) {
    console.log(`[xangi] Telegram: Allowed users: ${telegramAllowed.join(', ')}`);
  }

  // バックエンドリゾルバー & 動的ランナーマネージャーを作成
  const resolver = new BackendResolver(config);
  const agentRunner = new DynamicRunnerManager(config, resolver);
  const backendName = getBackendDisplayName(config.agent.backend);
  console.log(
    `[xangi] Using ${backendName} as agent backend (platform: ${config.agent.platform ?? 'all'})`
  );

  // スキルを読み込み（`/skills` 再読込と共有する可変参照）
  const workdir = config.agent.config.workdir || process.cwd();
  const skillsRef: SkillsRef = { current: loadSkills(workdir) };
  console.log(`[xangi] Loaded ${skillsRef.current.length} skills from ${workdir}`);

  // dataDir（永続データの保存先）を決定
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');

  // dataDir を排他ロック
  // 同じ dataDir を複数の xangi インスタンスで共有すると sessions.json の
  // 取り合いが起き、在庫が消える事故になる（過去事例: dev/borot 同時稼働で
  // 新規 web セッションが古い in-memory state で上書き消去）。
  const releaseDataDirLock = await acquireDataDirLock(dataDir);

  // 設定を初期化（dataDir 配下の settings.json を使用）
  initSettings(dataDir);
  loadSettings();
  console.log(`[xangi] Self lifecycle permission: ${getSelfLifecyclePermission()}`);

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

  // Telegram Bot 起動。接続待ちはバックグラウンドで再試行し、他媒体の起動を妨げない。
  // startTelegramBot は最初の await より前に scheduler sender/runner を登録する。
  if (config.telegram.enabled) {
    void startTelegramBot({
      config,
      agentRunner,
      scheduler,
    }).catch((err) => {
      console.error(`[xangi] Failed to start Telegram bot: ${formatTelegramError(err)}`);
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

  // ツールサーバー起動（Claude Codeからcurlで叩くAPI）
  // イベントトリガー（POST /api/trigger）は scheduler の agentRunner 経路を再利用
  const { startToolServer } = await import('./tool-server.js');
  const { EventTrigger, loadTriggerConfig } = await import('./event-trigger.js');
  startToolServer({ eventTrigger: new EventTrigger(loadTriggerConfig(), scheduler) });

  // Discord ボット: トークン未設定 (Web オンリーモード等) では Client を生成しない。
  // 生成だけでも discord.js の内部リソースを確保するし、login しない Client が
  // 残っているのは紛らわしいため、有効時のみ生成・配線する (issue #173)
  if (config.discord.enabled) {
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

    // runner の timeout-* イベントを Discord メッセージ更新に紐付け
    registerDiscordTimeoutUi(agentRunner);

    // スラッシュコマンド定義（基本 + 設定で有効化されるコマンド + スキル個別コマンド）
    const commands = buildSlashCommands(config, skillsRef.current);

    // スラッシュコマンド登録
    client.once(Events.ClientReady, async (c) => {
      console.log(`[xangi] Ready! Logged in as ${c.user.tag}`);

      // ツール承認サーバー起動（Claude Code PreToolUseフック用）
      const { startApprovalServer } = await import('./approval-server.js');
      startApprovalServer(async (toolName, toolInput, dangerDescription) => {
        // 最初のメンションなし応答チャンネルに承認メッセージを送信
        const approvalChannelId = Object.entries(
          loadSettings().discordAutoReplyChannels ?? {}
        ).find(([, enabled]) => enabled)?.[0];
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

    // スラッシュコマンド・ボタン・オートコンプリート処理
    client.on(
      Events.InteractionCreate,
      createInteractionHandler({ config, resolver, agentRunner, scheduler, workdir, skillsRef })
    );

    // Discord APIエラーでプロセスが落ちないようにハンドリング
    client.on('error', (error) => {
      console.error('[xangi] Discord client error:', error.message);
    });

    // メッセージ系イベント (MessageCreate / MessageUpdate / MessageDelete) を登録
    registerDiscordMessageHandlers({ client, config, agentRunner, workdir });

    // Discordボットを起動
    await client.login(config.discord.token);
    console.log('[xangi] Discord bot started');

    // スケジューラに Discord 送信関数とエージェント実行関数を登録
    registerDiscordSchedulerBridge({ scheduler, client, config, agentRunner });
  } // if (config.discord.enabled)

  // Slackボットを起動
  if (config.slack.enabled) {
    await startSlackBot({
      config,
      agentRunner,
      skills: skillsRef.current,
      reloadSkills: () => {
        skillsRef.current = loadSkills(workdir);
        return skillsRef.current;
      },
      scheduler,
    });
    console.log('[xangi] Slack bot started');
  }

  const webChatEnabled = process.env.WEB_CHAT_ENABLED === 'true';
  if (
    !config.discord.enabled &&
    !config.slack.enabled &&
    !webChatEnabled &&
    !config.line.enabled &&
    !config.telegram.enabled
  ) {
    console.error(
      '[xangi] No chat platform enabled. Set DISCORD_TOKEN, SLACK_BOT_TOKEN/SLACK_APP_TOKEN, WEB_CHAT_ENABLED=true, LINE_CHANNEL_ACCESS_TOKEN+LINE_CHANNEL_SECRET, or TELEGRAM_BOT_TOKEN'
    );
    process.exit(1);
  }

  // スケジューラの全ジョブを開始
  scheduler.startAll(config.scheduler);

  // シャットダウン時にスケジューラを停止し、dataDir ロックを解放
  const shutdown = () =>
    runShutdownCleanup({
      stopScheduler: () => scheduler.stopAll(),
      finalizeActiveStreams,
      releaseDataDirLock,
      exit: (code) => process.exit(code),
    });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
