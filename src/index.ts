import { Client, GatewayIntentBits, Events, Partials, REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { getBackendDisplayName } from './agent-runner.js';
import { BackendResolver } from './backend-resolver.js';
import { DynamicRunnerManager } from './dynamic-runner.js';
import { loadSkills } from './skills.js';
import { startSlackBot } from './slack.js';
import { initSettings, loadSettings } from './settings.js';
import { Scheduler, type Platform } from './scheduler.js';
import { initSessions } from './sessions.js';
import { join, resolve } from 'path';
import { realpathSync } from 'fs';
import { initTranscriptStorage } from './transcript-logger.js';
import { WorkspaceRegistry } from './workspace-registry.js';
import { config as dotenvConfig } from 'dotenv';
import { startWebChat } from './web-chat.js';
import { startLineBot } from './line.js';
import { startTelegramBot } from './telegram.js';
import { getEventsConfig } from './events-emitter.js';
import { startInterInstanceChat, getInterChatConfig } from './inter-instance-chat/index.js';
import { registerDiscordTimeoutUi } from './discord/ui.js';
import {
  buildSlashCommands,
  createInteractionHandler,
  type SkillsRef,
} from './discord/slash-commands.js';
import {
  processReplySuggestion,
  registerDiscordMessageHandlers,
  type DiscordRemoteInputBridge,
} from './discord/message-handler.js';
import { finalizeActiveStreams } from './stream-finalizer.js';
import { registerDiscordSchedulerBridge } from './discord/scheduler-bridge.js';
import { DiscordTurnCoordinator } from './discord/turn-coordinator.js';
import {
  resolveCachedDiscordDestinationLabel,
  warmDiscordScheduleDestinations,
} from './discord/destination-label.js';
import { runShutdownCleanup } from './shutdown.js';
import { processManager } from './process-manager.js';
import { getSelfLifecyclePermission } from './self-lifecycle.js';
import { loadStoredSecrets } from './setup/runtime-secrets.js';
import { applySetupRuntimeEnvFromProcess } from './installer/runtime-config.js';
import { acquireDataDirLock } from './data-dir-lock.js';
import { startPlatformWithRetry } from './platform-startup-retry.js';
import { startAutostartExtensions, stopManagedExtensions } from './extensions.js';
dotenvConfig({ override: true });
await applySetupRuntimeEnvFromProcess();
await loadStoredSecrets();

async function main() {
  const config = loadConfig();
  const workdir = realpathSync(resolve(config.agent.config.workdir || process.cwd()));
  config.agent.config.workdir = workdir;
  await startAutostartExtensions({ workspace: config.agent.config.workdir });
  const discordRemoteInputRef: { current?: DiscordRemoteInputBridge } = {};
  const discordTurnCoordinator = new DiscordTurnCoordinator();
  const destinationLabelResolverRef: {
    current?: (platform: Platform, destinationId: string) => string | undefined;
  } = {};
  const platformStartupTasks: Promise<void>[] = [];

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

  // スキルを読み込み（`/skill` 再読込と共有する可変参照）
  const skillsRef: SkillsRef = { current: loadSkills(workdir) };
  console.log(`[xangi] Loaded ${skillsRef.current.length} skills from ${workdir}`);

  // dataDir（永続データの保存先）を決定
  const dataDir = resolve(process.env.DATA_DIR || join(workdir, '.xangi'));
  initTranscriptStorage(dataDir, workdir);

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

  const configuredWorkspaceRoots = process.env.XANGI_WORKSPACE_ALLOWED_ROOTS?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const workspaceRegistry = await WorkspaceRegistry.open({
    dataDir,
    defaultWorkspacePath: workdir,
    allowedRoots: configuredWorkspaceRoots?.length ? configuredWorkspaceRoots : undefined,
  });

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
    startWebChat({
      agentRunner,
      historyPrefetch: config.historyPrefetch,
      replySuggestions: config.web,
      config,
      resolver,
      scheduler,
      skillsRef,
      discordRemoteInputRef,
      destinationLabelResolverRef,
      workspaceRegistry,
    });
  }

  // LINE Bot 起動 (Tailscale Funnel 等で外部公開して webhook を受ける想定)
  if (config.line.enabled) {
    platformStartupTasks.push(
      startLineBot({
        agentRunner,
        resolver,
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
        completionDisplay: config.completion,
        completionNotifyAfterMs: config.completion.notifyAfterMs,
      }).then(() => {
        console.log('[xangi] LINE bot started');
      })
    );
  }

  // Telegram Bot 起動。一時的な接続失敗は startTelegramBot 内で再試行する。
  // 他platformと同時に開始し、恒久エラーは全体の起動失敗としてservice managerへ伝える。
  if (config.telegram.enabled) {
    platformStartupTasks.push(
      startTelegramBot({
        config,
        agentRunner,
        resolver,
        scheduler,
      }).then(() => {
        console.log('[xangi] Telegram bot started');
      })
    );
  }

  // インスタンス間チャット起動 (INTER_INSTANCE_CHAT_ENABLED=true のときのみ実体起動)
  const interChatCfg = getInterChatConfig();
  if (interChatCfg.enabled) {
    startInterInstanceChat();
  }

  // GitHub認証を初期化（秘密鍵をメモリに読み込む）
  const { initGitHubAuth } = await import('./github-auth.js');
  initGitHubAuth();

  // ツールサーバー起動（Claude Codeからcurlで叩くAPI）
  // イベントトリガー（POST /api/trigger）は scheduler の agentRunner 経路を再利用
  const { startToolServer } = await import('./tool-server.js');
  const { EventTrigger, loadTriggerConfig } = await import('./event-trigger.js');
  startToolServer({
    eventTrigger: new EventTrigger(loadTriggerConfig(), scheduler, { dataDir }),
    backendResolver: resolver,
    config,
    scheduler,
  });

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
    destinationLabelResolverRef.current = (platform, destinationId) =>
      platform === 'discord'
        ? resolveCachedDiscordDestinationLabel(client, destinationId)
        : undefined;

    // runner の timeout-* イベントを Discord メッセージ更新に紐付け
    registerDiscordTimeoutUi(agentRunner);

    // スラッシュコマンド定義（基本 + 設定で有効化されるコマンド + スキル個別コマンド）
    const commands = buildSlashCommands(config, skillsRef.current);

    // スラッシュコマンド登録
    client.once(Events.ClientReady, async (c) => {
      console.log(`[xangi] Ready! Logged in as ${c.user.tag}`);

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

        await warmDiscordScheduleDestinations(client, scheduler.list());

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
      createInteractionHandler({
        config,
        resolver,
        agentRunner,
        scheduler,
        workdir,
        skillsRef,
        workspaceRegistry,
        onReplySuggestion: (interaction, suggestion) =>
          processReplySuggestion(interaction, agentRunner, config, suggestion, workspaceRegistry),
      })
    );

    // Discord APIエラーでプロセスが落ちないようにハンドリング
    client.on('error', (error) => {
      console.error('[xangi] Discord client error:', error.message);
    });

    // メッセージ系イベント (MessageCreate / MessageUpdate / MessageDelete) を登録
    discordRemoteInputRef.current = registerDiscordMessageHandlers({
      client,
      config,
      agentRunner,
      workdir,
      workspaceRegistry,
      turnCoordinator: discordTurnCoordinator,
    });

    // スケジューラに Discord 送信関数とエージェント実行関数を登録
    registerDiscordSchedulerBridge({
      scheduler,
      client,
      config,
      agentRunner,
      workspaceRegistry,
      turnCoordinator: discordTurnCoordinator,
    });

    // Discordの初回接続は他platformと同時に開始。一時的なDNS/接続障害は
    // WebやSlackを止めず、同一process内で回復するまで再試行する。
    platformStartupTasks.push(
      startPlatformWithRetry('Discord', () => client.login(config.discord.token)).then(() => {
        console.log('[xangi] Discord bot started');
      })
    );
  } // if (config.discord.enabled)

  // Slackボットを起動
  if (config.slack.enabled) {
    platformStartupTasks.push(
      startSlackBot({
        config,
        agentRunner,
        resolver,
        skills: skillsRef.current,
        reloadSkills: () => {
          skillsRef.current = loadSkills(workdir);
          return skillsRef.current;
        },
        scheduler,
      }).then(() => {
        console.log('[xangi] Slack bot started');
      })
    );
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

  // Discord/Slackは同時に接続する。一方が再試行中でも他方とWebは利用できる。
  // スケジューラのstartup taskは全ての有効platformのready後に開始する。
  await Promise.all(platformStartupTasks);

  // スケジューラの全ジョブを開始
  scheduler.startAll(config.scheduler);

  // シャットダウン時にスケジューラを停止し、dataDir ロックを解放
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= runShutdownCleanup({
      stopScheduler: () => scheduler.stopAll(),
      finalizeActiveStreams,
      stopAgentProcesses: async () => {
        agentRunner.shutdown();
        await processManager.stopAllAndWait();
      },
      stopExtensions: stopManagedExtensions,
      releaseDataDirLock,
      exit: (code) => process.exit(code),
      hardTimeoutMs: 7_000,
    });
    return shutdownPromise;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[xangi] Fatal startup error:', error);
  process.exit(1);
});
