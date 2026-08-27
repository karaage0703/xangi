/**
 * xangi Tool Server — Claude Code向けHTTPエンドポイント
 *
 * xangiプロセス内で起動し、Discord/Schedule/System操作のHTTP APIを提供。
 * Claude CodeはBashツールでxangi toolを使ってこのサーバーに問い合わせる。
 *
 * ポートはOS自動割り当て（競合なし）。起動後に
 * process.env.XANGI_TOOL_SERVER に接続先URLを設定し、
 * xangi toolを使う子プロセスへ渡す。
 */
import { createServer, type Server } from 'http';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { discordApi } from './cli/discord-api.js';
import { slackApi } from './cli/slack-api.js';
import { scheduleCmd } from './cli/schedule-cmd.js';
import { systemCmd } from './cli/system-cmd.js';
import { webHistoryCmd } from './cli/web-history-cmd.js';
import { slackHistoryCmd } from './cli/slack-history-cmd.js';
import { isGitHubAppEnabled, generateInstallationToken } from './github-auth.js';
import { ValidationError } from './errors.js';
import type { EventTrigger, TriggerRequestBody } from './event-trigger.js';
import { discoverBackendModels } from './backend-models.js';
import type { BackendResolver } from './backend-resolver.js';
import { executeModelsCommand, selectModelForNextTurn } from './models-command.js';
import { formatXangiCmdHelp } from './cli/xangi-cmd-help.js';
import { webStatusCmd } from './web-status.js';
import type { Config } from './config.js';
import type { ChatPlatform } from './prompts/index.js';
import { executeRuntimeSettingsCommand } from './runtime-settings-command.js';
import type { Scheduler } from './scheduler.js';
import { listExtensions, runExtensionAction, type ExtensionAction } from './extensions.js';
import { executeExtensionRequest } from './extension-request.js';
import { updateExtension } from './extension-update.js';
import { finalizeDevelopmentExtensionUninstall } from './extension-catalog.js';

let server: Server | null = null;
let eventTrigger: EventTrigger | null = null;
let backendResolver: BackendResolver | null = null;
let runtimeConfig: Config | null = null;
let scheduleManager: Scheduler | null = null;
let modelDiscovery: typeof discoverBackendModels = discoverBackendModels;
let webStatusCommand: typeof webStatusCmd = webStatusCmd;
let extensionUpdateCommand: typeof updateExtension = updateExtension;
let extensionUninstallCommand: typeof finalizeDevelopmentExtensionUninstall =
  finalizeDevelopmentExtensionUninstall;

interface ToolRequest {
  command: string;
  flags: Record<string, string>;
  context?: {
    channelId?: string;
    platform?: ChatPlatform;
  };
}

/**
 * リクエストボディをパース
 */
async function parseJsonBody<T>(req: import('http').IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString();
  if (!raw) throw new Error('Empty request body');
  return JSON.parse(raw) as T;
}

async function parseBody(req: import('http').IncomingMessage): Promise<ToolRequest> {
  return parseJsonBody<ToolRequest>(req);
}

/**
 * コマンドをルーティングして実行
 */
async function executeCommand(
  command: string,
  flags: Record<string, string>,
  context?: ToolRequest['context']
): Promise<string> {
  if (command.startsWith('discord_') || command === 'media_send') {
    return discordApi(command, flags, context);
  } else if (command.startsWith('slack_') && command !== 'slack_history') {
    return slackApi(command, flags, context);
  } else if (command.startsWith('schedule_')) {
    if (runtimeConfig?.scheduler?.enabled === false) {
      throw new ValidationError('schedule is disabled by SCHEDULER_ENABLED=false');
    }
    return scheduleCmd(command, flags, scheduleManager ?? undefined);
  } else if (command.startsWith('system_')) {
    return systemCmd(command, flags);
  } else if (command === 'help') {
    return formatXangiCmdHelp(flags['topic']);
  } else if (command === 'models') {
    if (runtimeConfig?.features?.backendSwitching === false) {
      throw new ValidationError('models is disabled by BACKEND_SWITCHING_ENABLED=false');
    }
    if (!backendResolver) {
      throw new ValidationError('models is not available on this instance');
    }
    if (flags.use) {
      return selectModelForNextTurn(
        {
          backend: flags.backend,
          model: flags.use,
          effort: flags.effort,
          channelId: flags.channel ?? context?.channelId,
        },
        backendResolver,
        modelDiscovery
      );
    }
    return executeModelsCommand(flags.backend, backendResolver, modelDiscovery);
  } else if (command === 'runtime_settings') {
    if (!backendResolver || !runtimeConfig) {
      throw new ValidationError('runtime_settings is not available on this instance');
    }
    const isBackendSetting = flags.name === 'backend';
    if (isBackendSetting && runtimeConfig.features?.backendSwitching === false) {
      throw new ValidationError('backend switching is disabled by BACKEND_SWITCHING_ENABLED=false');
    }
    if (!isBackendSetting && runtimeConfig.features?.runtimeSettings === false) {
      throw new ValidationError('runtime settings are disabled by RUNTIME_SETTINGS_ENABLED=false');
    }
    return executeRuntimeSettingsCommand(
      {
        name: flags.name,
        action: flags.action,
        value: flags.value,
        backend: flags.backend,
        model: flags.model,
        effort: flags.effort,
        channelId: flags.channel ?? context?.channelId,
        platform: flags.platform ?? context?.platform,
      },
      { config: runtimeConfig, resolver: backendResolver, modelDiscovery }
    );
  } else if (command === 'web_status') {
    return webStatusCommand();
  } else if (command === 'extension_runtime') {
    if (!runtimeConfig) {
      throw new ValidationError('extension_runtime is not available on this instance');
    }
    const action = flags.action as ExtensionAction | undefined;
    if (!action || !['start', 'stop', 'restart', 'status', 'doctor'].includes(action)) {
      throw new ValidationError('extension_runtime requires a lifecycle action');
    }
    const linked = await listExtensions();
    const selected = flags.id ? linked.filter((item) => item.id === flags.id) : linked;
    if (flags.id && selected.length === 0) {
      throw new ValidationError(`Unknown extension: ${flags.id}`);
    }
    const results: string[] = [];
    for (const item of selected) {
      const result = await runExtensionAction(item, action, {
        workspace: runtimeConfig.agent.config.workdir,
      });
      results.push(`${item.id}\t${JSON.stringify(result)}`);
    }
    return results.length ? results.join('\n') : 'No extensions linked';
  } else if (command === 'extension_request') {
    return executeExtensionRequest(flags);
  } else if (command === 'extension_update') {
    if (!runtimeConfig) {
      throw new ValidationError('extension_update is not available on this instance');
    }
    if (!flags.id || !flags.to) {
      throw new ValidationError('extension_update requires --id and --to');
    }
    const id = flags.id;
    const targetCommitSha = flags.to;
    const result = await extensionUpdateCommand({
      id,
      expectedCommitSha: targetCommitSha,
      workspace: runtimeConfig.agent.config.workdir || process.cwd(),
      acceptManifestChanges: flags['accept-manifest-changes'] === 'true',
    });
    return JSON.stringify(result);
  } else if (command === 'extension_uninstall') {
    if (!runtimeConfig) {
      throw new ValidationError('extension_uninstall is not available on this instance');
    }
    if (!flags.id) {
      throw new ValidationError('extension_uninstall requires --id');
    }
    return JSON.stringify(await extensionUninstallCommand(flags.id));
  } else if (command === 'trigger') {
    if (!eventTrigger) {
      throw new ValidationError('Trigger is not available on this instance');
    }
    const body: TriggerRequestBody = {
      channel: flags.channel ?? context?.channelId,
      message: flags.message,
      source: flags.source,
      platform: flags.platform,
    };
    const result = await eventTrigger.handleLocal(body);
    if (result.status >= 400) {
      throw new ValidationError(String(result.body.error ?? 'Trigger failed'));
    }
    return `✅ トリガーを発火しました (id: ${result.body.triggerId}, source: ${result.body.source})`;
  } else if (command === 'trigger_status') {
    if (!eventTrigger) {
      throw new ValidationError('Trigger is not available on this instance');
    }
    const triggerId = flags.id?.trim();
    if (!triggerId) throw new ValidationError('--id is required');
    const result = eventTrigger.getReceipt(triggerId);
    if (result.status >= 400) {
      throw new ValidationError(String(result.body.error ?? 'Trigger status failed'));
    }
    return JSON.stringify(result.body.receipt, null, 2);
  } else if (command === 'web_history') {
    // 現ペイン解決のために context.channelId を env で渡す
    // (`web-chat:<appSessionId>` 形式)
    const previousChannel = process.env.XANGI_CHANNEL_ID;
    if (context?.channelId) {
      process.env.XANGI_CHANNEL_ID = context.channelId;
    }
    try {
      return webHistoryCmd(flags);
    } finally {
      if (previousChannel === undefined) {
        delete process.env.XANGI_CHANNEL_ID;
      } else {
        process.env.XANGI_CHANNEL_ID = previousChannel;
      }
    }
  } else if (command === 'slack_history') {
    // 現Slackチャンネル解決のために context.channelId を env で渡す。
    const previousChannel = process.env.XANGI_CHANNEL_ID;
    if (context?.channelId) {
      process.env.XANGI_CHANNEL_ID = context.channelId;
    }
    try {
      return slackHistoryCmd(flags);
    } finally {
      if (previousChannel === undefined) {
        delete process.env.XANGI_CHANNEL_ID;
      } else {
        process.env.XANGI_CHANNEL_ID = previousChannel;
      }
    }
  } else {
    throw new ValidationError(`Unknown command: ${command}`);
  }
}

/** 前回使用ポートの保存先 (dataDir/tool-server-port) */
function toolServerPortFile(): string {
  const workdir = process.env.WORKSPACE_PATH || process.cwd();
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  return join(dataDir, 'tool-server-port');
}

/**
 * 起動時に使うポートを決める。
 * 1. XANGI_TOOL_SERVER_PORT 環境変数（固定ポート運用）
 * 2. 前回起動時に使ったポート（dataDir に保存）
 * 3. どちらも無ければ 0 = OS 自動割り当て
 *
 * 再起動でポートが変わると、resume されたエージェントセッションが
 * 古い XANGI_TOOL_SERVER を参照して xangi-cmd が接続失敗する
 * （シェル環境のスナップショットに旧 URL が残るため）。
 * 前回ポートを再利用することでこの再起動アーティファクトを防ぐ。
 */
export function resolvePreferredToolServerPort(env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env.XANGI_TOOL_SERVER_PORT ?? '');
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535) return fromEnv;
  // テスト実行時は前回ポートを参照しない（実環境の dataDir を読まない）
  if (env.VITEST) return 0;
  try {
    const saved = Number(readFileSync(toolServerPortFile(), 'utf-8').trim());
    if (Number.isInteger(saved) && saved > 0 && saved <= 65535) return saved;
  } catch {
    // 初回起動・ファイル無しなど → 自動割り当て
  }
  return 0;
}

/** 採用したポートを次回再起動用に保存する（失敗しても致命的でない） */
function persistToolServerPort(port: number): void {
  // テスト実行時は実環境の dataDir に書き込まない
  if (process.env.VITEST) return;
  try {
    const file = toolServerPortFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(port), 'utf-8');
  } catch (e) {
    console.warn('[tool-server] Failed to persist port:', e);
  }
}

/**
 * Tool Serverを起動（前回ポート再利用 → 使用中なら自動割り当てにフォールバック）
 *
 * options.eventTrigger を渡すと POST /api/trigger（外部イベントによる
 * エージェントターン起動）と xangi-cmd trigger が有効になる。
 */
export function startToolServer(options?: {
  eventTrigger?: EventTrigger | null;
  backendResolver?: BackendResolver | null;
  config?: Config | null;
  scheduler?: Scheduler | null;
  modelDiscovery?: typeof discoverBackendModels;
  webStatusCommand?: typeof webStatusCmd;
  extensionUpdateCommand?: typeof updateExtension;
  extensionUninstallCommand?: typeof finalizeDevelopmentExtensionUninstall;
}): void {
  eventTrigger = options?.eventTrigger ?? null;
  backendResolver = options?.backendResolver ?? null;
  runtimeConfig = options?.config ?? null;
  scheduleManager = options?.scheduler ?? null;
  modelDiscovery = options?.modelDiscovery ?? discoverBackendModels;
  webStatusCommand = options?.webStatusCommand ?? webStatusCmd;
  extensionUpdateCommand = options?.extensionUpdateCommand ?? updateExtension;
  extensionUninstallCommand =
    options?.extensionUninstallCommand ?? finalizeDevelopmentExtensionUninstall;
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // ヘルスチェック
    if (req.url === '/health') {
      const addr = server?.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', port }));
      return;
    }

    // GitHub App トークン生成エンドポイント
    if (req.url === '/github-token' && req.method === 'GET') {
      if (!isGitHubAppEnabled()) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'GitHub App is not configured' }));
        return;
      }
      try {
        const token = await generateInstallationToken();
        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(200);
        res.end(token);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[tool-server] GitHub token generation failed: ${message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // イベントトリガーエンドポイント（外部イベント → エージェントターン起動）
    if (req.url === '/api/trigger' && req.method === 'POST') {
      if (!eventTrigger) {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: 'Trigger is not available' }));
        return;
      }
      try {
        const body = await parseJsonBody<TriggerRequestBody>(req);
        const result = await eventTrigger.handleHttp(body, req.headers.authorization);
        res.writeHead(result.status);
        res.end(JSON.stringify(result.body));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    const triggerStatusMatch = req.url?.match(/^\/api\/trigger\/([^/?]+)$/);
    if (triggerStatusMatch && req.method === 'GET') {
      if (!eventTrigger) {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: 'Trigger is not available' }));
        return;
      }
      let triggerId: string;
      try {
        triggerId = decodeURIComponent(triggerStatusMatch[1]);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'Invalid trigger ID encoding' }));
        return;
      }
      const result = eventTrigger.handleStatusHttp(triggerId, req.headers.authorization);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
      return;
    }

    // ツール実行エンドポイント
    if (req.url === '/api/execute' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { command, flags, context } = body;

        if (!command) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'command is required' }));
          return;
        }

        console.log(`[tool-server] ${command} ${JSON.stringify(flags || {})}`);
        const result = await executeCommand(command, flags || {}, context);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // ValidationError はクライアント入力の問題なので 400、それ以外は 500。
        // name ベースで判定する（vitest 等で module が二重ロードされても安全）
        const isValidation =
          err instanceof ValidationError ||
          (err instanceof Error && err.name === 'ValidationError');
        const status = isValidation ? 400 : 500;
        console.error(`[tool-server] Error (${status}): ${message}`);
        res.writeHead(status);
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // 前回ポートを優先し、使用中 (EADDRINUSE) なら自動割り当てにフォールバック
  const preferred = resolvePreferredToolServerPort();
  let fellBack = false;

  server.on('error', (err: NodeJS.ErrnoException) => {
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && preferred !== 0 && !fellBack) {
      fellBack = true;
      console.warn(
        `[tool-server] Port ${preferred} unavailable (${err.code}), falling back to auto-assign`
      );
      server?.listen(0, '0.0.0.0');
      return;
    }
    console.error('[tool-server] Server error:', err);
  });

  server.on('listening', () => {
    const addr = server!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const serverUrl = `http://127.0.0.1:${port}`;
    process.env.XANGI_TOOL_SERVER = serverUrl;
    persistToolServerPort(port);

    console.log(`[tool-server] Listening on http://0.0.0.0:${port}`);
  });

  server.listen(preferred, '0.0.0.0');
}

/**
 * Tool Serverを停止
 */
export function stopToolServer(): void {
  if (server) {
    server.close();
    server = null;
    delete process.env.XANGI_TOOL_SERVER;
  }
  runtimeConfig = null;
  scheduleManager = null;
}
