import { parseSecretCommand } from './secret.js';
import { tokenizeCommand } from './chat-command-input.js';
import { executeChatSettings } from './chat-command-settings.js';
import { executeRuntimeSettingsCommand } from './runtime-settings-command.js';
import type { AgentRunner } from './agent-runner.js';
import { getSessionEntry } from './sessions.js';
import { formatModelExecution, latestModelExecution } from './model-execution-display.js';
import type { AgentBackend, Config, EffortLevel } from './config.js';
import { getBackendDisplayName } from './agent-runner.js';
import type { BackendResolver, ChannelOverride } from './backend-resolver.js';
import {
  getSupportedEffortLevels,
  getSupportedEffortLevelsForModel,
  hasUsableModelForEffort,
  supportsEffort,
} from './backend-effort.js';
import type { Scheduler } from './scheduler.js';
import {
  formatScheduleDateTime,
  parseScheduleInput,
  resolveScheduleTimeZone,
} from './scheduler.js';
import { loadSkills, type Skill } from './skills.js';
import { executeModelsCommand } from './models-command.js';
import { discoverBackendModels, type BackendModelDiscovery } from './backend-models.js';

import {
  getChatCommands,
  commandHelp,
  skillCommandAliases,
  skillCommandPrompt,
} from './chat-commands.js';
import type { ChatCommandDefinition, ChatCommandOption } from './chat-commands.js';
export type WebCommandDefinition = ChatCommandDefinition;
export type WebCommandOption = ChatCommandOption;
export const WEB_COMMANDS = getChatCommands('web');

export function getWebCommandDefinitions(ctx: WebCommandContext): WebCommandDefinition[] {
  const skills = loadSkills(ctx.workdir);
  const backendChoices =
    ctx.resolver?.getSelectableBackends().map((backend) => ({
      name: getBackendDisplayName(backend),
      value: backend,
    })) ?? [];
  const discoveredModels = ctx.modelDiscovery?.models ?? [];
  const modelChoices = [
    { name: 'バックエンドのデフォルト', value: '--model=default' },
    ...discoveredModels.map((model) => ({
      name:
        model.displayName && model.displayName !== model.id
          ? `${model.displayName} (${model.id})`
          : model.id,
      value: `--model=${model.id}`,
      description: model.description,
    })),
  ];
  const selectedModel =
    discoveredModels.find((model) => model.id === ctx.selectedModel) ??
    (ctx.selectedModel === undefined
      ? discoveredModels.find((model) => model.isDefault)
      : undefined);
  const supportedEfforts = ctx.selectedBackend
    ? getSupportedEffortLevelsForModel(ctx.selectedBackend, selectedModel)
    : [];
  const scheduleChoices =
    ctx.appSessionId && ctx.scheduler
      ? ctx.scheduler.list(undefined, 'web').map((schedule) => ({
          name: `${schedule.enabled ? '有効' : '無効'}: ${schedule.message}`,
          value: schedule.id,
        }))
      : [];

  const visibleCommands = getChatCommands('web', ctx.config);

  const definitions = visibleCommands.map((command) => {
    const copy = structuredClone(command);
    if (copy.name === 'skill' && copy.options?.[0]) {
      copy.options[0].choices = skills.map((skill) => ({
        name: skill.name,
        value: skill.name,
        description: skill.description,
      }));
    }
    if (copy.name === 'backend') {
      const set = copy.options?.find((option) => option.name === 'set');
      const backendOption = set?.options?.[0];
      if (backendOption) backendOption.choices = backendChoices;
      if (set && backendOption) {
        const scope = set.options?.find((option) => option.name === 'scope');
        set.options = [backendOption];
        if (ctx.selectedBackend && ctx.modelDiscovery) {
          set.options.push({
            name: 'model',
            description:
              ctx.modelDiscovery.status === 'available'
                ? 'モデル'
                : ctx.modelDiscovery.message || 'モデルを取得できません',
            type: 'string',
            choices: modelChoices,
          });
          if (supportedEfforts.length > 0) {
            set.options.push({
              name: 'effort',
              description: 'effort',
              type: 'string',
              choices: [
                { name: 'デフォルト', value: '--effort=default' },
                ...supportedEfforts.map((effort) => ({
                  name: effort,
                  value: `--effort=${effort}`,
                })),
              ],
            });
          }
        }
        if (scope) set.options.push(scope);
      }
    }
    if (copy.name === 'backend') {
      const models = copy.options?.find((option) => option.name === 'models');
      if (models?.options?.[0]) models.options[0].choices = backendChoices;
      for (const sub of copy.options ?? []) {
        for (const option of sub.options ?? [])
          if (option.name === 'scope')
            option.choices = option.choices?.map((choice) => ({
              ...choice,
              value: `--scope=${choice.value}`,
            }));
      }
    }
    if (copy.name === 'agent') {
      const set = copy.options?.find((option) => option.name === 'set');
      if (set?.options?.[0])
        set.options[0].choices = ctx.agents?.map((agent) => ({
          name: agent.name,
          value: agent.id,
        }));
    }
    if (copy.name === 'workspace') {
      const use = copy.options?.find((option) => option.name === 'use');
      if (use?.options?.[0])
        use.options[0].choices = ctx.workspaces?.map((workspace) => ({
          name: workspace.name,
          value: workspace.name,
        }));
    }
    if (copy.name === 'schedule') {
      for (const name of ['remove', 'toggle']) {
        const option = copy.options?.find((candidate) => candidate.name === name);
        if (option?.options?.[0] && scheduleChoices.length > 0) {
          option.options[0].choices = scheduleChoices;
        }
      }
    }
    return copy;
  });
  for (const [name, skill] of skillCommandAliases(skills))
    definitions.push({
      name,
      description: skill.description.slice(0, 100),
      usage: `/${name} [args]`,
      category: 'skills',
      options: [{ name: 'args', description: '引数', type: 'string' }],
    });
  return definitions;
}

export type WebCommandResult =
  | { kind: 'message'; message: string }
  | { kind: 'chat'; message: string; displayMessage: string; skipPermissions?: boolean }
  | { kind: 'skills'; skills: Array<Pick<Skill, 'name' | 'description'>> }
  | { kind: 'session'; sessionId: string }
  | { kind: 'action'; action: 'new' | 'retitle' | 'stop'; message?: string };

export interface WebCommandContext {
  appSessionId?: string;
  workdir: string;
  config?: Config;
  resolver?: BackendResolver;
  agentRunner?: AgentRunner;
  backendDefault?: ChannelOverride;
  backendDefaultSource?: string;
  selectedBackend?: AgentBackend;
  selectedModel?: string;
  agents?: Array<{ id: string; name: string }>;
  workspaces?: Array<{ id: string; name: string }>;
  modelDiscovery?: BackendModelDiscovery;
  discoverModels?: typeof discoverBackendModels;
  scheduler?: Scheduler;
  skillsRef?: { current: Skill[] };
  selectionCommand?: (name: 'agent' | 'workspace', args: string[]) => Promise<WebCommandResult>;
}

function requireSession(ctx: WebCommandContext): string {
  if (!ctx.appSessionId) throw new Error('先にWebセッションを開始してください');
  return `web-chat:${ctx.appSessionId}`;
}

function requireResolver(ctx: WebCommandContext): BackendResolver {
  if (!ctx.resolver) throw new Error('この環境ではバックエンド切替を利用できません');
  return ctx.resolver;
}

function requireScheduler(ctx: WebCommandContext): Scheduler {
  if (!ctx.scheduler) throw new Error('この環境ではスケジューラを利用できません');
  return ctx.scheduler;
}

async function handleBackend(args: string[], ctx: WebCommandContext): Promise<WebCommandResult> {
  const resolver = requireResolver(ctx);
  const subcommand = args[0] || 'status';
  if (subcommand === 'models') {
    if (args.length > 2) throw new Error('使い方: /backend models [type]');
    return {
      kind: 'message',
      message: await executeModelsCommand(args[1], resolver, ctx.discoverModels),
    };
  }
  const values: { model?: string; effort?: string; scope?: string } = {};
  const positional: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split('=', 2);
    if (!['model', 'effort', 'scope'].includes(key)) throw new Error(`不明なオプション: --${key}`);
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${key} の値を指定してください`);
    values[key as keyof typeof values] = value;
  }
  if (values.scope && !['channel', 'global'].includes(values.scope))
    throw new Error('scope は channel または global を指定してください');
  if (subcommand === 'set') {
    if (positional.length < 1 || positional.length > 2)
      throw new Error(
        '使い方: /backend set <type> [--model model] [--effort effort] [--scope channel|global]'
      );
    if (positional[1] && values.model) throw new Error('モデルは一つだけ指定してください');
    values.model ??= positional[1];
  } else if (
    !['status', 'reset'].includes(subcommand) ||
    positional.length ||
    values.model ||
    values.effort
  ) {
    throw new Error('使い方: /backend status|models|set|reset');
  }
  if (values.model === 'default') values.model = undefined;
  if (values.effort === 'default') values.effort = undefined;
  if (values.scope === 'global') {
    return {
      kind: 'message',
      message: await executeRuntimeSettingsCommand(
        {
          name: 'backend',
          action: subcommand,
          scope: 'global',
          platform: 'web',
          backend: subcommand === 'set' ? positional[0] : undefined,
          model: values.model,
          effort: values.effort,
        },
        {
          config: ctx.config,
          resolver,
          agentRunner: ctx.agentRunner,
          modelDiscovery: ctx.discoverModels,
        }
      ),
    };
  }
  const channelId = requireSession(ctx);

  if (subcommand === 'status') {
    const resolved = resolver.resolve(channelId, ctx.backendDefault);
    const entry = ctx.appSessionId ? getSessionEntry(ctx.appSessionId) : undefined;
    const source = resolver.getChannelOverride(channelId)
      ? 'Webセッション設定'
      : ctx.backendDefault
        ? ctx.backendDefaultSource || 'Project設定'
        : 'デフォルト';
    return {
      kind: 'message',
      message: [
        '## 現在のバックエンド設定',
        `- バックエンド: \`${getBackendDisplayName(resolved.backend)}\``,
        `- モデル: ${resolved.model ? `\`${resolved.model}\`` : 'デフォルト'}`,
        `- 直近の実行: ${formatModelExecution(latestModelExecution(entry), entry?.agent)}`,
        `- effort: ${resolved.effort ? `\`${resolved.effort}\`` : 'デフォルト'}`,
        `- ソース: ${source}`,
      ].join('\n'),
    };
  }

  if (subcommand === 'reset') {
    resolver.clearChannelOverride(channelId);
    return {
      kind: 'message',
      message: ctx.backendDefault
        ? `${ctx.backendDefaultSource || 'Project設定'}へ戻しました。`
        : 'バックエンド設定をデフォルトへ戻しました。',
    };
  }

  if (subcommand !== 'set') {
    throw new Error('使い方: /backend status|set|reset');
  }

  const backend = positional[0] as AgentBackend;
  if (!resolver.isBackendSelectable(backend))
    throw new Error(
      `利用可能なバックエンドを指定してください: ${resolver.getSelectableBackends().join(', ')}`
    );
  const model = values.model;
  const effort = values.effort as EffortLevel | undefined;

  if (effort && !supportsEffort(backend, effort)) {
    throw new Error(
      `${backend} の effort は ${getSupportedEffortLevels(backend).join(', ') || '未対応'} です`
    );
  }
  if (effort && !hasUsableModelForEffort(backend, model)) {
    throw new Error(`${backend} で effort を指定するにはモデルも指定してください`);
  }

  if (model || effort) {
    const discovery = await (ctx.discoverModels ?? discoverBackendModels)(backend);
    if (model && discovery.status !== 'available') {
      throw new Error(discovery.message || `${backend}のモデル一覧を取得できません`);
    }
    const selected = model
      ? discovery.models.find((candidate) => candidate.id === model)
      : discovery.models.find((candidate) => candidate.isDefault);
    if (model && !selected) throw new Error(`モデル \`${model}\` は現在の候補にありません`);
    const supportedEfforts = getSupportedEffortLevelsForModel(backend, selected);
    if (effort && !supportedEfforts.includes(effort)) {
      throw new Error(
        `モデル \`${selected?.id ?? model}\` のeffortは ${supportedEfforts.join(', ') || '未対応'} です`
      );
    }
  }

  resolver.setChannelOverride(channelId, { backend, model, effort });
  return {
    kind: 'message',
    message: `${getBackendDisplayName(backend)}${model ? ` / ${model}` : ''}${effort ? ` / effort=${effort}` : ''} に切り替えました。次の送信から適用されます。`,
  };
}

function handleSchedule(args: string[], ctx: WebCommandContext): WebCommandResult {
  const scheduler = requireScheduler(ctx);
  const subcommand = args[0] || 'list';
  if (subcommand === 'list') {
    const schedules = scheduler.list(undefined, 'web');
    return {
      kind: 'message',
      message:
        schedules.length === 0
          ? 'Webセッション向けスケジュールはありません。'
          : [
              '## Webセッション向けスケジュール',
              ...schedules.map(
                (schedule) =>
                  `- ${schedule.enabled ? '✅' : '⏸️'} \`${schedule.id}\` — ${schedule.message}`
              ),
            ].join('\n'),
    };
  }
  if (subcommand === 'add') {
    const input = args.slice(1).join(' ').trim();
    const parsed = parseScheduleInput(input);
    if (!parsed) throw new Error('日時を解析できません。例: /schedule add 30分後 確認する');
    const schedule = scheduler.add({
      ...parsed,
      channelId: requireSession(ctx).replace(/^web-chat:/, ''),
      platform: 'web',
    });
    return {
      kind: 'message',
      message: [
        'スケジュールを追加しました。',
        `- ID: \`${schedule.id}\``,
        `- 内容: ${schedule.message}`,
        schedule.runAt
          ? `- 実行時刻: ${formatScheduleDateTime(schedule.runAt)}`
          : `- タイムゾーン: ${resolveScheduleTimeZone()}`,
      ].join('\n'),
    };
  }
  if (subcommand === 'remove') {
    const id = args[1];
    if (!id) throw new Error('使い方: /schedule remove <id>');
    return {
      kind: 'message',
      message: scheduler.remove(id) ? `\`${id}\` を削除しました。` : `\`${id}\` は見つかりません。`,
    };
  }
  if (subcommand === 'toggle') {
    const id = args[1];
    if (!id) throw new Error('使い方: /schedule toggle <id>');
    const schedule = scheduler.toggle(id);
    return {
      kind: 'message',
      message: schedule
        ? `\`${id}\` を${schedule.enabled ? '有効' : '無効'}にしました。`
        : `\`${id}\` は見つかりません。`,
    };
  }
  throw new Error('使い方: /schedule add|list|remove|toggle');
}

export async function executeWebCommand(
  input: string,
  ctx: WebCommandContext
): Promise<WebCommandResult> {
  const tokens = tokenizeCommand(input.trim());
  const commandName = (tokens.shift() || '').replace(/^\//, '').toLowerCase();

  const definitions = getChatCommands('web', ctx.config);
  if (!definitions.some((command) => command.name === commandName)) {
    if (WEB_COMMANDS.some((command) => command.name === commandName))
      throw new Error('この機能は管理者により無効化されています');
    const alias = skillCommandAliases(loadSkills(ctx.workdir)).get(commandName);
    if (alias)
      return {
        kind: 'chat',
        displayMessage: input,
        message: skillCommandPrompt(alias, tokens.join(' ')),
      };
    throw new Error(`Unknown command: /${commandName}. /help で使えるコマンドを確認してください`);
  }

  switch (commandName) {
    case 'secret':
      if (!parseSecretCommand(input)) throw new Error('使い方: /secret on|off|status');
      return { kind: 'chat', message: input, displayMessage: input };
    case 'help':
      return { kind: 'message', message: commandHelp('web', ctx.config) };
    case 'new':
    case 'retitle':
    case 'stop':
      return { kind: 'action', action: commandName };
    case 'settings':
      if (tokens.length > 2) throw new Error('使い方: /settings [item] [value]');
      return {
        kind: 'message',
        message:
          (await executeChatSettings(
            tokens[0],
            tokens[1],
            {
              platform: 'web',
              channelId: ctx.appSessionId ? `web-chat:${ctx.appSessionId}` : undefined,
              backendDefault: ctx.backendDefault,
            },
            {
              config: ctx.config,
              resolver: ctx.resolver!,
              agentRunner: ctx.agentRunner,
              modelDiscovery: ctx.discoverModels,
            }
          )) + '\n[詳細設定・Team管理を開く](/settings)',
      };
    case 'skill': {
      const skillName = tokens.shift();
      const skills = loadSkills(ctx.workdir);
      if (ctx.skillsRef) ctx.skillsRef.current = skills;
      if (!skillName) {
        return {
          kind: 'skills',
          skills: skills.map(({ name, description }) => ({ name, description })),
        };
      }
      const skill = skills.find((candidate) => candidate.name === skillName);
      if (!skill) throw new Error(`スキル \`${skillName}\` は見つかりません`);
      const args = tokens.join(' ');
      return {
        kind: 'chat',
        displayMessage: input,
        message: skillCommandPrompt(skill, args),
      };
    }
    case 'backend':
      return await handleBackend(tokens, ctx);
    case 'agent':
    case 'workspace':
      if (!ctx.selectionCommand) throw new Error('この環境では担当・作業場所を切り替えられません');
      return ctx.selectionCommand(commandName, tokens);
    case 'schedule':
      return handleSchedule(tokens, ctx);
    default:
      throw new Error(`Unknown command: /${commandName}`);
  }
}
