import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { AgentRunner } from './agent-runner.js';
import type { BackendResolver } from './backend-resolver.js';
import type { Config } from './config.js';
import type { WorkspaceRegistry } from './workspace-registry.js';
import { commandHelp, getChatCommands, skillCommandAliases } from './chat-commands.js';
import { tokenizeCommand } from './chat-command-input.js';
import { executeChatSettings } from './chat-command-settings.js';
import { executeRuntimeSettingsCommand } from './runtime-settings-command.js';
import { channelAgent, listSelectableAgents } from './agent-selection.js';
import { getActiveSessionId, getSessionEntry } from './sessions.js';
import { loadSkills, formatSkillList, type Skill } from './skills.js';
import { formatScheduleList, parseScheduleInput, type Scheduler } from './scheduler.js';
import { markdownToSlackMrkdwn } from './slack-mrkdwn.js';

type Respond = (response: { text: string; response_type: 'ephemeral' }) => Promise<unknown>;
interface SlackCommandDependencies {
  config: Config;
  resolver: BackendResolver;
  agentRunner: AgentRunner;
  registry?: WorkspaceRegistry;
  scheduler?: Scheduler;
  registrationSkills: Skill[];
  fallbackSkills: () => Skill[];
  newConversation: (channel: string) => void;
  stopConversation: (channel: string) => Promise<string>;
  backend: (channel: string, text: string) => Promise<string>;
  secret: (
    command: { channel_id: string; user_id: string; text: string },
    respond: Respond,
    client: WebClient
  ) => Promise<void>;
  runSkill: (
    channel: string,
    skill: string,
    args: string,
    triggerId: string,
    client: WebClient
  ) => Promise<void>;
}

async function currentSkills(channel: string, deps: SlackCommandDependencies): Promise<Skill[]> {
  if (!deps.registry) return deps.fallbackSkills();
  const id = getActiveSessionId(channel);
  const entry = id ? getSessionEntry(id) : undefined;
  const agent = channelAgent('slack', channel);
  const workspace = entry?.workspacePath
    ? await deps.registry.resolveSnapshot(entry.workspaceId || 'default', entry.workspacePath)
    : entry?.workspaceId
      ? await deps.registry.resolveById(entry.workspaceId)
      : agent
        ? await deps.registry.resolveById(agent.workspaceId || 'default')
        : await deps.registry.resolve('slack', channel);
  return loadSkills(workspace.path);
}

async function workspaceCommand(
  channel: string,
  args: string[],
  deps: SlackCommandDependencies
): Promise<string> {
  const registry = deps.registry;
  if (!registry) throw new Error('Workspace registry is unavailable');
  const action = args[0] || 'status';
  const valid =
    (['status', 'list', 'reset'].includes(action) && args.length <= 1) ||
    (action === 'use' && args.length === 2) ||
    (action === 'set' && args.length === 3);
  if (!valid) throw new Error('使い方: /workspace status|list|use <name>|set <name> <path>|reset');
  if (action === 'list')
    return registry
      .list()
      .map((workspace) => `${workspace.name}: ${workspace.path}`)
      .join('\n');
  if (action === 'status') {
    const configured = await registry.resolve('slack', channel);
    const agent = channelAgent('slack', channel);
    const agentWorkspace = agent
      ? await registry.resolveById(agent.workspaceId || 'default')
      : undefined;
    const id = getActiveSessionId(channel);
    const entry = id ? getSessionEntry(id) : undefined;
    return [
      `チャンネル設定: ${configured.name}\n${configured.path}`,
      ...(agentWorkspace ? [`担当Agentの作業場所: ${agentWorkspace.path}`] : []),
      ...(entry?.workspacePath ? [`現在のチャンネル会話: ${entry.workspacePath}`] : []),
      '設定変更は次の /new から反映します。既存スレッドの作業場所は保持します。',
    ].join('\n');
  }
  let selected;
  if (action === 'reset') {
    await registry.resetBinding('slack', channel);
    selected = await registry.resolve('slack', channel);
  } else {
    selected =
      action === 'set' ? await registry.register(args[1], args[2]) : registry.getByName(args[1]);
    if (!selected) throw new Error(`Workspace not found: ${args[1]}`);
    selected = await registry.bind('slack', channel, selected.id);
  }
  return `${selected.name} を設定しました。次の /new から ${selected.path} を使います。`;
}

function scheduleCommand(channel: string, args: string[], deps: SlackCommandDependencies): string {
  const scheduler = deps.scheduler;
  if (!scheduler) throw new Error('この環境ではスケジューラを利用できません');
  const action = args[0] || 'list';
  if (action === 'list' && args.length <= 1)
    return formatScheduleList(scheduler.list(undefined, 'slack'), deps.config.scheduler);
  if (action === 'add') {
    const parsed = parseScheduleInput(args.slice(1).join(' '));
    if (!parsed) throw new Error('日時を解析できません。例: /schedule add 30分後 確認する');
    // Slack slash payloads address the channel, not an existing message thread.
    if (parsed.targetChannelId && parsed.targetChannelId !== channel)
      throw new Error('別チャンネルへの予定は対象チャンネルで登録してください');
    const schedule = scheduler.add({ ...parsed, platform: 'slack', channelId: channel });
    return `スケジュールを追加しました。ID: ${schedule.id}\n${schedule.message}`;
  }
  if (['remove', 'toggle'].includes(action) && args.length === 2) {
    if (scheduler.get(args[1])?.platform !== 'slack')
      throw new Error('Slackのスケジュールが見つかりません');
    if (action === 'remove') {
      scheduler.remove(args[1]);
      return `${args[1]} を削除しました。`;
    }
    const schedule = scheduler.toggle(args[1]);
    return `${args[1]} を${schedule?.enabled ? '有効' : '無効'}にしました。`;
  }
  throw new Error('使い方: /schedule add|list|remove <id>|toggle <id>');
}

/** Register exactly the shared catalog and supported direct-skill aliases, never retired handlers. */
export function registerSlackCommands(
  app: Pick<App, 'command'>,
  deps: SlackCommandDependencies
): void {
  const definitions = getChatCommands('slack', deps.config);
  const aliases = skillCommandAliases(deps.registrationSkills);
  for (const name of [...definitions.map((command) => command.name), ...aliases.keys()]) {
    app.command(`/${name}`, async ({ command, ack, respond, client }) => {
      // Acknowledge before any filesystem, model discovery, or network operation.
      await ack();
      const reply = (text: string) =>
        respond({ text: markdownToSlackMrkdwn(text), response_type: 'ephemeral' });
      if (
        !deps.config.slack.allowedUsers?.some((user) => user === '*' || user === command.user_id)
      ) {
        await reply('許可されていないユーザーです');
        return;
      }
      try {
        const enabled = getChatCommands('slack', deps.config).some(
          (command) => command.name === name
        );
        if (!enabled && !aliases.has(name))
          throw new Error('この機能は管理者により無効化されています');
        const args = tokenizeCommand(command.text.trim());
        const channel = command.channel_id;
        switch (name) {
          case 'help':
            if (args.length) throw new Error('使い方: /help');
            await reply(
              commandHelp('slack', deps.config) +
                '\nSlackスレッドには独立したタイトルがないため /retitle は対象外です。ネイティブコマンドと個別スキルにはSlack App側の登録が必要です。'
            );
            return;
          case 'secret':
            if (args.length !== 1 || !['on', 'off', 'status'].includes(args[0]))
              throw new Error('使い方: /secret on|off|status');
            await deps.secret(command, respond, client);
            return;
          case 'new':
            if (args.length) throw new Error('使い方: /new');
            deps.newConversation(channel);
            await reply('新しいセッションを開始しました。');
            return;
          case 'stop':
            if (args.length) throw new Error('使い方: /stop');
            await reply(await deps.stopConversation(channel));
            return;
          case 'workspace':
            await reply(await workspaceCommand(channel, args, deps));
            return;
          case 'schedule':
            await reply(scheduleCommand(channel, args, deps));
            return;
          case 'agent': {
            const action = args[0] || 'status';
            if (action === 'list' && args.length <= 1) {
              await reply(
                listSelectableAgents()
                  .map((agent) => `${agent.name}: ${agent.id}`)
                  .join('\n') || '登録済みのエージェントはありません'
              );
              return;
            }
            if (
              !(action === 'set' && args.length === 2) &&
              !(['status', 'reset'].includes(action) && args.length <= 1)
            )
              throw new Error('使い方: /agent list|status|set <id>|reset');
            await reply(
              await executeRuntimeSettingsCommand(
                { name: 'agent', action, value: args[1], channelId: channel, platform: 'slack' },
                deps
              )
            );
            return;
          }
          case 'backend':
            await reply(await deps.backend(channel, command.text));
            return;
          case 'settings':
            if (args.length > 2) throw new Error('使い方: /settings [item] [value]');
            await reply(
              await executeChatSettings(
                args[0],
                args[1],
                { platform: 'slack', channelId: channel },
                deps
              )
            );
            return;
          case 'autoreply':
          case 'threadmode': {
            const value = args[0] || 'status';
            if (args.length > 1 || !['status', 'on', 'off', 'default'].includes(value))
              throw new Error(`使い方: /${name} status|on|off|default`);
            await reply(
              await executeRuntimeSettingsCommand(
                {
                  name,
                  value,
                  action: value === 'status' ? 'status' : value === 'default' ? 'reset' : 'set',
                  platform: 'slack',
                  channelId: channel,
                },
                deps
              )
            );
            return;
          }
        }
        const skills = await currentSkills(channel, deps);
        const skill =
          name === 'skill'
            ? skills.find((skill) => skill.name === args[0])
            : skillCommandAliases(skills).get(name);
        if (name === 'skill' && !args.length) {
          await reply(formatSkillList(skills));
          return;
        }
        if (!skill)
          throw new Error('スキルが現在のWorkspaceにありません。/skill で一覧を確認してください');
        await deps.runSkill(
          channel,
          skill.name,
          (name === 'skill' ? args.slice(1) : args).join(' '),
          command.trigger_id,
          client
        );
      } catch (error) {
        await reply(error instanceof Error ? error.message : String(error));
      }
    });
  }
}
