import { attachDedicatedAgentSettingsHandler } from './agent-connection-settings.js';
import type { RuntimeSettingsDependencies } from './runtime-settings-command.js';
import { receiveConnectionApi, removeConnectionApi } from './agent-connection-http.js';
import { attachParentRestartHandler } from './agent-connection-restart.js';
import { systemCmd } from './cli/system-cmd.js';
import {
  AgentConnectionScheduleClient,
  registerAgentConnectionScheduleRelay,
} from './agent-connection-schedules.js';
import type { AgentRunContext, Schedule } from './scheduler.js';
import { fork, type ChildProcess } from 'node:child_process';
import { open, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentConnectionStore,
  agentConnectionStatus,
  type AgentConnection,
} from './agent-connections.js';
import { writePrivateJsonFile } from './setup/private-json-file.js';
import { acquireDataDirLock } from './data-dir-lock.js';
import { ProjectCatalog } from './project-catalog.js';
import type { WorkspaceRegistry } from './workspace-registry.js';
import { DEFAULT_TEAM_AGENT_ID } from './teams.js';
import { workChannelConnection, type ConnectionRoute } from './agent-work-channel-routing.js';
import {
  connectDedicatedDiscordWork,
  deliverWorkPost,
  registerSharedWorkInput,
  type InputRequest,
  type WorkerWorkRequest,
} from './agent-connection-work.js';
import {
  createAgentWorkThread,
  registerDiscordWorkRoute,
  workThreadTransport,
  type WorkThread,
  type WorkTransport,
} from './agent-work.js';
import { AgentRunStore } from './agent-runs.js';
import { agentConnectionMonitor } from './agent-connection-monitor.js';
import { readEnvFile } from './env-file.js';

/** Each transport gets its own sessions, tools, scheduler and platform globals. */
export function connectionEnvironment(
  connection: AgentConnection,
  dataDir: string,
  workdir: string,
  base: NodeJS.ProcessEnv = process.env,
  saved: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(DISCORD_|SLACK_|LINE_|TELEGRAM_)/.test(key) && /TOKEN|SECRET|BOT_ID|USER/.test(key))
      delete env[key];
    if (
      /^XANGI_(TOOL_SERVER|REMOTE_WORKER|SETUP_|EXTENSION_|INTER_CHAT|EVENTS_|REMOTE_PLATFORM|INSTANCE_ID)/.test(
        key
      )
    )
      delete env[key];
  }
  Object.assign(env, {
    DATA_DIR: dataDir,
    WORKSPACE_PATH: workdir,
    XANGI_AGENT_CONNECTION_ID: connection.id,
    XANGI_CONNECTION_AGENT_ID: connection.agentId,
    WEB_CHAT_ENABLED: 'false',
    XANGI_SELF_LIFECYCLE: 'off',
    CHANNEL_OVERRIDES: '{}',
    XANGI_ENV_PATH: join(dataDir, '.env'),
    XANGI_INSTANCE_ID: `connection-${connection.id}`,
    ...(connection.platform === 'discord'
      ? { DISCORD_TOKEN: connection.botToken, DISCORD_ALLOWED_USER: connection.allowedUsers }
      : {
          SLACK_BOT_TOKEN: connection.botToken,
          SLACK_APP_TOKEN: connection.appToken,
          SLACK_ALLOWED_USER: connection.allowedUsers,
        }),
  });
  if (connection.platform === 'discord') {
    // Only these preferences belong to a dedicated Discord Bot's private env file.
    if (saved.XANGI_GLOBAL_BACKEND_OVERRIDE === 'true' && saved.AGENT_BACKEND) {
      env.AGENT_BACKEND = saved.AGENT_BACKEND;
      for (const key of ['AGENT_MODEL', 'AGENT_EFFORT']) {
        if (saved[key] === undefined) delete env[key];
        else env[key] = saved[key];
      }
    }
    if (saved.RESPOND_TO_BOTS_ENABLED !== undefined)
      env.RESPOND_TO_BOTS_ENABLED = saved.RESPOND_TO_BOTS_ENABLED;
  }
  return env;
}

/** Preserve TS loaders, but never let Node reload the parent's env file. */
export function connectionExecArgv(argv: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (/^--env-file(?:-if-exists)?=/.test(argv[i])) continue;
    if (/^--env-file(?:-if-exists)?$/.test(argv[i])) {
      i++;
      continue;
    }
    result.push(argv[i]);
  }
  return result;
}

export class AgentConnectionRuntimes {
  private children = new Set<ChildProcess>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopping = false;
  private connections: AgentConnection[] = [];
  private connectionRoutes: ConnectionRoute[] = [];
  private relayedThreads = new Map<string, { owner: string; runId: string; thread: WorkThread }>();
  private clients = new Map<
    string,
    {
      child: ChildProcess;
      client: AgentConnectionScheduleClient;
      work: ReturnType<typeof connectDedicatedDiscordWork>;
    }
  >();
  private unregisterScheduleRelay?: () => void;
  private unregisterWorkRoute?: () => void;
  constructor(
    private dataDir: string,
    private workdir: string,
    private registry: WorkspaceRegistry,
    private options: { entry?: string; runtimeSettings?: RuntimeSettingsDependencies } = {}
  ) {}

  async start(connections?: AgentConnection[]) {
    connections ??= await new AgentConnectionStore(this.dataDir).read();
    this.connections = connections;
    this.connectionRoutes = connections.map(({ id, agentId, platform, enabled }) => ({
      id,
      agentId,
      platform,
      enabled,
    }));
    this.unregisterScheduleRelay = registerAgentConnectionScheduleRelay(
      (agentId, platform, prompt, destination, schedule, context) => {
        const matching = connections.filter(
          (c) => c.agentId === agentId && c.platform === platform
        );
        if (!matching.length) return undefined;
        const enabled = matching.filter((c) => c.enabled);
        if (enabled.length !== 1)
          return Promise.reject(
            new Error(
              enabled.length
                ? '担当に同じサービスの専用Botが複数あります。予定配信には専用Botを1つだけ有効にしてください'
                : '担当の専用Botは無効です。接続設定を確認してください'
            )
          );
        return this.runSchedule(enabled[0], prompt, destination, schedule, context);
      }
    );
    this.unregisterWorkRoute = registerDiscordWorkRoute((target) => {
      const connection =
        'agentId' in target
          ? workChannelConnection(connections, 'discord', target.agentId)
          : connections.find(
              (candidate) =>
                candidate.id === target.connectionId &&
                candidate.platform === 'discord' &&
                candidate.enabled
            );
      if (!connection) return undefined;
      const work = async () => {
        const active = await this.readyConnection(connection.id);
        return active.work.transport;
      };
      const transport: WorkTransport = {
        create: async (...args) => (await work()).create(...args),
        send: async (...args) => (await work()).send(...args),
        progress: async (...args) => (await work()).progress(...args),
        begin: async (...args) => (await work()).begin?.(...args),
        end: async (...args) => (await work()).end?.(...args),
        updateTimeout: async (...args) => (await work()).updateTimeout?.(...args),
      };
      return {
        connectionId: connection.id,
        transport,
        ready: async () => {
          await this.readyConnection(connection.id);
        },
      };
    });
    registerSharedWorkInput((request) => this.relayWorkInput(request));
    for (const connection of connections) {
      try {
        for (const { id, workThread } of this.storedWorkRoutes(connection.id)) {
          if (workThread?.relayed)
            this.relayedThreads.set(workThread.threadId, {
              owner: connection.id,
              runId: id,
              thread: workThread,
            });
        }
      } catch {
        console.warn(`[agent-connections] ${connection.id}: could not restore work thread routes`);
      }
    }
    const tokens = new Set<string>();
    for (const c of connections.filter((c) => c.enabled)) {
      // Never connect a token twice, even if the state file was edited manually.
      const keys = [`${c.platform}:${c.botToken}`, ...(c.appToken ? [`app:${c.appToken}`] : [])];
      if (
        keys.some((key) => tokens.has(key)) ||
        c.botToken ===
          process.env[c.platform === 'discord' ? 'DISCORD_TOKEN' : 'SLACK_BOT_TOKEN'] ||
        (c.platform === 'slack' && c.appToken === process.env.SLACK_APP_TOKEN)
      ) {
        agentConnectionStatus.set(c.id, 'failed');
        continue;
      }
      keys.forEach((key) => tokens.add(key));
      await this.launch(c);
    }
  }

  private async launch(connection: AgentConnection, attempt = 0): Promise<void> {
    if (this.stopping) return;
    const dataDir = join(this.dataDir, 'agent-connections', connection.id);
    agentConnectionStatus.set(connection.id, 'starting');
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const release = await acquireDataDirLock(dataDir);
      let saved: Record<string, string> = {};
      try {
        if (connection.platform === 'discord') {
          const envPath = join(dataDir, '.env');
          await (await open(envPath, 'a', 0o600)).close();
          saved = readEnvFile(envPath);
        }
        const catalog = new ProjectCatalog(this.dataDir);
        const agent =
          connection.agentId === DEFAULT_TEAM_AGENT_ID
            ? catalog.defaultAgent()
            : catalog.agent(connection.agentId);
        if (!agent) throw new Error('担当エージェントが見つかりません');
        await this.registry.resolveById(agent.workspaceId || 'default');
        const raw = JSON.parse(await readFile(join(this.dataDir, 'project-catalog.json'), 'utf8'));
        await writePrivateJsonFile(join(dataDir, 'project-catalog.json'), {
          ...raw,
          projects: [],
          agents: [...catalog.agents(), catalog.defaultAgent()],
        });
        const workspaces = JSON.parse(await readFile(this.registry.registryPath, 'utf8'));
        await writePrivateJsonFile(join(dataDir, 'workspaces.json'), {
          ...workspaces,
          bindings: {},
        });
      } finally {
        await release();
      }
      if (this.stopping) return;
      const log = await open(join(dataDir, 'runtime.log'), 'a', 0o600);
      let child: ChildProcess;
      try {
        const entry =
          this.options.entry ||
          fileURLToPath(
            new URL(import.meta.url.endsWith('.ts') ? './index.ts' : './index.js', import.meta.url)
          );
        child = fork(entry, [], {
          cwd: this.workdir,
          execArgv: connectionExecArgv(process.execArgv),
          env: {
            ...connectionEnvironment(connection, dataDir, this.workdir, process.env, saved),
            XANGI_CONNECTION_PARENT_DATA_DIR: this.dataDir,
            XANGI_CONNECTION_WORK_CHANNEL_ROUTES: JSON.stringify(this.connectionRoutes),
          },
          stdio: ['ignore', log.fd, log.fd, 'ipc'],
        });
      } finally {
        void log.close().catch(() => undefined);
      }
      this.children.add(child);
      attachParentRestartHandler(
        child,
        () => systemCmd('system_restart', {}),
        () => this.stopping
      );
      if (connection.platform === 'discord' && this.options.runtimeSettings)
        attachDedicatedAgentSettingsHandler(
          child,
          connection,
          this.connections,
          this.options.runtimeSettings,
          this.registry,
          () => this.stopping
        );
      const scheduleClient = new AgentConnectionScheduleClient(child, connection.platform);
      const work = connectDedicatedDiscordWork(child, connection, (request) =>
        this.routeWorkerWork(connection, request)
      );
      this.clients.set(connection.id, { child, client: scheduleClient, work });
      child.on('message', (message) => {
        agentConnectionMonitor.receive(connection.id, connection.agentId, message);
        receiveConnectionApi(connection.id, message);
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'agent-connection-ready'
        )
          agentConnectionStatus.set(connection.id, 'ready');
      });
      child.on('error', () => agentConnectionStatus.set(connection.id, 'failed'));
      child.once('close', () => {
        agentConnectionMonitor.remove(connection.id);
        removeConnectionApi(connection.id);
        this.children.delete(child);
        if (this.clients.get(connection.id)?.child === child) this.clients.delete(connection.id);
        agentConnectionStatus.set(connection.id, this.stopping ? 'stopped' : 'failed');
        this.retry(connection, attempt);
      });
    } catch {
      agentConnectionStatus.set(connection.id, 'failed');
      console.error(
        `[agent-connections] ${connection.id}: startup failed; check Agent/workspace and private runtime state`
      );
      this.retry(connection, attempt);
    }
  }

  private async runSchedule(
    connection: AgentConnection,
    prompt: string,
    destination: string,
    schedule?: Schedule,
    context?: AgentRunContext
  ): Promise<string> {
    const active = await this.readyConnection(connection.id);
    return active.client.run(prompt, destination, schedule, context);
  }

  private relayWorkInput(request: InputRequest, poster?: string): Promise<unknown> | undefined {
    const route = this.relayedThreads.get(request.threadId);
    if (!route) return undefined;
    if (request.action === 'lookup')
      return Promise.resolve(route.thread.connectionId === poster ? 'accept' : 'ignore');
    if (route.thread.connectionId !== poster)
      return request.action === 'input' ? Promise.resolve(null) : undefined;
    return this.readyConnection(route.owner).then(({ work }) => work.input(request));
  }

  private async routeWorkerWork(
    connection: AgentConnection,
    request: InputRequest | WorkerWorkRequest
  ) {
    if ('threadId' in request) {
      if (connection.platform !== 'discord') return undefined;
      return this.relayWorkInput(request, connection.id);
    }
    if (request.action === 'defaults') return this.options.runtimeSettings?.resolver.resolve();
    if (request.action === 'publish') {
      const run = this.storedWorkRoutes(connection.id).find(({ id }) => id === request.runId);
      if (!run?.agentId) throw new Error('作業が見つかりません');
      const existing = [...this.relayedThreads.values()].find(
        (route) => route.owner === connection.id && route.runId === run.id
      );
      if (existing) return existing.thread;
      // The IPC connection identifies the requester independently of the run's assignee.
      const requester =
        connection.platform === 'discord'
          ? (await this.readyConnection(connection.id)).work.transport
          : undefined;
      const created = await createAgentWorkThread(run.agentId, request.title, request.text, {
        platform: 'discord',
        requester,
        requesterAgentId:
          connection.platform === 'discord' && connection.agentId === request.requesterAgentId
            ? undefined
            : request.requesterAgentId,
      });
      if (!created) return undefined;
      const thread: WorkThread = { ...created, relayed: true };
      this.relayedThreads.set(thread.threadId, { owner: connection.id, runId: run.id, thread });
      return thread;
    }

    const route = this.relayedThreads.get(request.post.thread.threadId);
    if (!route || route.owner !== connection.id)
      throw new Error('作業スレッドの実行元が一致しません');
    const transport = workThreadTransport(route.thread);
    if (!transport) throw new Error('Discordの作業スレッドに接続できません');
    return deliverWorkPost(transport, { ...request.post, thread: route.thread });
  }

  private storedWorkRoutes(connectionId: string) {
    return AgentRunStore.storedWorkRoutes(join(this.dataDir, 'agent-connections', connectionId));
  }

  private async readyConnection(connectionId: string) {
    const active = this.clients.get(connectionId);
    if (!active || this.stopping)
      throw new Error('担当の専用Botは起動していません。再起動後の接続状態を確認してください');
    if (agentConnectionStatus.get(connectionId) !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          active.child.off('message', ready);
          active.child.off('close', closed);
          if (error) reject(error);
          else resolve();
        };
        const ready = (message: unknown) => {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'agent-connection-ready'
          )
            finish();
        };
        const closed = () => finish(new Error('担当の専用Botが接続前に終了しました'));
        const timer = setTimeout(
          () => finish(new Error('担当の専用Botが接続されていません。接続状態を確認してください')),
          60_000
        );
        timer.unref();
        active.child.on('message', ready);
        active.child.once('close', closed);
      });
    }
    return active;
  }

  private retry(connection: AgentConnection, attempt: number) {
    // 5 + 10 + 20 + 40 seconds also covers the 60s lock lease after a hard kill.
    // Auth/configuration errors remain bounded rather than restarting forever.
    if (this.stopping || attempt >= 4) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        void this.launch(connection, attempt + 1);
      },
      5_000 * 2 ** attempt
    );
    timer.unref();
    this.timers.add(timer);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unregisterScheduleRelay?.();
    this.unregisterWorkRoute?.();
    registerSharedWorkInput(undefined);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
            timer.unref();
            child.once('close', () => {
              clearTimeout(timer);
              resolve();
            });
            child.kill('SIGTERM');
          })
      )
    );
  }
}
