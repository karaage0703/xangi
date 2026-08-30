import type { AgentBackend, Config, EffortLevel } from './config.js';
import { getBackendDisplayName } from './agent-runner.js';
import type { BackendResolver, ChannelOverride } from './backend-resolver.js';
import {
  getSupportedEffortLevels,
  requiresExplicitModelForEffort,
  supportsEffort,
} from './backend-effort.js';
import type { Scheduler } from './scheduler.js';
import { parseScheduleInput } from './scheduler.js';
import { loadSettings, formatSettings } from './settings.js';
import { loadSkills, type Skill } from './skills.js';
import { executeModelsCommand, MODELS_COMMAND_USAGE } from './models-command.js';
import { discoverBackendModels, type BackendModelDiscovery } from './backend-models.js';

export interface WebCommandDefinition {
  name: string;
  description: string;
  usage: string;
  category: 'session' | 'skills' | 'settings' | 'system';
  options?: WebCommandOption[];
}

export interface WebCommandChoice {
  name: string;
  value: string;
  description?: string;
}

export interface WebCommandOption {
  name: string;
  description: string;
  type: 'subcommand' | 'string';
  required?: boolean;
  choices?: WebCommandChoice[];
  options?: WebCommandOption[];
}

export const WEB_COMMANDS: WebCommandDefinition[] = [
  {
    name: 'new',
    description: '新しいセッションを開始',
    usage: '/new',
    category: 'session',
  },
  {
    name: 'retitle',
    description: '現在のWeb会話タイトルをAIで再生成',
    usage: '/retitle',
    category: 'session',
  },
  {
    name: 'stop',
    description: '実行中のタスクを停止',
    usage: '/stop',
    category: 'session',
  },
  {
    name: 'extend',
    description: '実行中タスクの残り時間を延長',
    usage: '/extend',
    category: 'session',
  },
  {
    name: 'skill',
    description: '利用可能なスキルを表示・実行',
    usage: '/skill [name] [args]',
    category: 'skills',
    options: [
      {
        name: 'name',
        description: 'スキル名',
        type: 'string',
        required: false,
      },
      {
        name: 'args',
        description: '引数',
        type: 'string',
      },
    ],
  },
  {
    name: 'settings',
    description: '現在の設定を表示',
    usage: '/settings',
    category: 'settings',
  },
  {
    name: 'models',
    description: '利用可能なモデル一覧を表示',
    usage: MODELS_COMMAND_USAGE,
    category: 'settings',
    options: [
      {
        name: 'backend',
        description: 'バックエンド（省略時はすべて）',
        type: 'string',
      },
    ],
  },
  {
    name: 'backend',
    description: 'バックエンド設定を表示・変更',
    usage: '/backend show|set|reset ...',
    category: 'settings',
    options: [
      {
        name: 'show',
        description: '現在のバックエンド設定を表示',
        type: 'subcommand',
      },
      {
        name: 'set',
        description: 'バックエンドと任意のモデルを設定',
        type: 'subcommand',
        options: [
          {
            name: 'type',
            description: 'バックエンド',
            type: 'string',
            required: true,
          },
          {
            name: 'model',
            description: 'モデル名（任意）',
            type: 'string',
          },
        ],
      },
      {
        name: 'reset',
        description: 'デフォルトへ戻す',
        type: 'subcommand',
      },
    ],
  },
  {
    name: 'llmmode',
    description: 'Local LLMモードを表示・変更',
    usage: '/llmmode show|agent|chat|default',
    category: 'settings',
    options: [
      {
        name: 'mode',
        description: 'Local LLMモード',
        type: 'string',
        required: true,
        choices: [
          { name: '現在の設定を表示', value: 'show' },
          { name: 'agent（全機能）', value: 'agent' },
          { name: 'chat（純粋な会話）', value: 'chat' },
          { name: 'デフォルトへ戻す', value: 'default' },
        ],
      },
    ],
  },
  {
    name: 'schedule',
    description: 'スケジュールを追加・一覧・削除・切替',
    usage: '/schedule add|list|remove|toggle ...',
    category: 'settings',
    options: [
      {
        name: 'add',
        description: 'スケジュールを追加',
        type: 'subcommand',
        options: [
          {
            name: 'input',
            description: '例: 30分後 確認する',
            type: 'string',
            required: true,
          },
        ],
      },
      {
        name: 'list',
        description: 'スケジュール一覧を表示',
        type: 'subcommand',
      },
      {
        name: 'remove',
        description: 'スケジュールを削除',
        type: 'subcommand',
        options: [
          {
            name: 'id',
            description: 'スケジュールID',
            type: 'string',
            required: true,
          },
        ],
      },
      {
        name: 'toggle',
        description: 'スケジュールの有効/無効を切替',
        type: 'subcommand',
        options: [
          {
            name: 'id',
            description: 'スケジュールID',
            type: 'string',
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: 'restart',
    description: 'xangiを再起動',
    usage: '/restart',
    category: 'system',
  },
  {
    name: 'help',
    description: 'コマンド一覧を表示',
    usage: '/help',
    category: 'system',
  },
];

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
  const selectedModel = discoveredModels.find((model) => model.id === ctx.selectedModel);
  const supportedEfforts = ctx.selectedBackend
    ? getSupportedEffortLevels(ctx.selectedBackend).filter(
        (effort) =>
          !selectedModel?.supportedEfforts?.length ||
          selectedModel.supportedEfforts.includes(effort)
      )
    : [];
  const scheduleChoices =
    ctx.appSessionId && ctx.scheduler
      ? ctx.scheduler.list(undefined, 'web').map((schedule) => ({
          name: `${schedule.enabled ? '有効' : '無効'}: ${schedule.message}`,
          value: schedule.id,
        }))
      : [];

  const visibleCommands = WEB_COMMANDS.filter((command) => {
    if (command.name === 'settings' || command.name === 'llmmode') {
      return ctx.config?.features?.runtimeSettings !== false;
    }
    if (command.name === 'models' || command.name === 'backend') {
      return ctx.config?.features?.backendSwitching !== false;
    }
    if (command.name === 'schedule') return ctx.config?.scheduler.enabled !== false;
    if (command.name === 'restart') return ctx.config?.features?.lifecycle !== false;
    return true;
  });

  return visibleCommands.map((command) => {
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
          if (ctx.selectedModel !== undefined && supportedEfforts.length > 0) {
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
      }
    }
    if (copy.name === 'models' && copy.options?.[0]) {
      copy.options[0].choices = backendChoices;
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
}

export type WebCommandResult =
  | { kind: 'message'; message: string }
  | { kind: 'chat'; message: string; displayMessage: string; skipPermissions?: boolean }
  | { kind: 'skills'; skills: Array<Pick<Skill, 'name' | 'description'>> }
  | { kind: 'action'; action: 'new' | 'retitle' | 'stop' | 'extend' | 'restart'; message?: string };

export interface WebCommandContext {
  appSessionId?: string;
  workdir: string;
  config?: Config;
  resolver?: BackendResolver;
  backendDefault?: ChannelOverride;
  backendDefaultSource?: string;
  selectedBackend?: AgentBackend;
  selectedModel?: string;
  modelDiscovery?: BackendModelDiscovery;
  discoverModels?: typeof discoverBackendModels;
  scheduler?: Scheduler;
  skillsRef?: { current: Skill[] };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function commandHelp(): string {
  return [
    '## Web Chat コマンド',
    '',
    ...WEB_COMMANDS.map((command) => `- \`${command.usage}\` — ${command.description}`),
    '',
    '`/` を入力するか、入力欄のコマンドボタンから選択できます。',
  ].join('\n');
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
  const channelId = requireSession(ctx);
  const subcommand = args[0] || 'show';

  if (subcommand === 'show') {
    const resolved = resolver.resolve(channelId, ctx.backendDefault);
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
    throw new Error('使い方: /backend show|set|reset');
  }

  const backend = args[1] as AgentBackend | undefined;
  if (!backend || !resolver.isBackendSelectable(backend)) {
    throw new Error(
      `利用可能なバックエンドを指定してください: ${resolver.getSelectableBackends().join(', ')}`
    );
  }

  let model: string | undefined;
  let effort: EffortLevel | undefined;
  for (let index = 2; index < args.length; index++) {
    if (args[index] === '--model') model = args[++index];
    else if (args[index].startsWith('--model=')) model = args[index].slice('--model='.length);
    else if (args[index] === '--effort') effort = args[++index] as EffortLevel;
    else if (args[index].startsWith('--effort=')) {
      effort = args[index].slice('--effort='.length) as EffortLevel;
    } else if (!model) model = args[index];
  }
  if (model === 'default') model = undefined;
  if ((effort as string | undefined) === 'default') effort = undefined;

  if (effort && !supportsEffort(backend, effort)) {
    throw new Error(
      `${backend} の effort は ${getSupportedEffortLevels(backend).join(', ') || '未対応'} です`
    );
  }
  if (effort && requiresExplicitModelForEffort(backend) && !model) {
    throw new Error(`${backend} で effort を指定するにはモデルも指定してください`);
  }

  if (model) {
    const discovery = await (ctx.discoverModels ?? discoverBackendModels)(backend);
    if (discovery.status !== 'available') {
      throw new Error(discovery.message || `${backend}のモデル一覧を取得できません`);
    }
    const selected = discovery.models.find((candidate) => candidate.id === model);
    if (!selected) throw new Error(`モデル \`${model}\` は現在の候補にありません`);
    if (
      effort &&
      selected.supportedEfforts?.length &&
      !selected.supportedEfforts.includes(effort)
    ) {
      throw new Error(
        `モデル \`${model}\` のeffortは ${selected.supportedEfforts.join(', ')} です`
      );
    }
  }

  resolver.setChannelOverride(channelId, { backend, model, effort });
  return {
    kind: 'message',
    message: `${getBackendDisplayName(backend)}${model ? ` / ${model}` : ''}${effort ? ` / effort=${effort}` : ''} に切り替えました。次の送信から適用されます。`,
  };
}

function handleLlmMode(args: string[], ctx: WebCommandContext): WebCommandResult {
  const resolver = requireResolver(ctx);
  const channelId = requireSession(ctx);
  const mode = args[0] || 'show';
  if (mode === 'show') {
    const resolved = resolver.resolve(channelId, ctx.backendDefault);
    const startupMode = process.env.LOCAL_LLM_MODE || 'agent';
    return {
      kind: 'message',
      message: `Local LLMモード: \`${resolved.localLlmMode || startupMode}\``,
    };
  }
  if (mode === 'default') {
    resolver.setChannelLocalLlmMode(channelId, null);
    return { kind: 'message', message: 'Local LLMモードをデフォルトへ戻しました。' };
  }
  if (mode !== 'agent' && mode !== 'chat') {
    throw new Error('使い方: /llmmode show|agent|chat|default');
  }
  resolver.setChannelLocalLlmMode(channelId, mode);
  return { kind: 'message', message: `Local LLMモードを \`${mode}\` に設定しました。` };
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
      message: `スケジュールを追加しました。\n- ID: \`${schedule.id}\`\n- 内容: ${schedule.message}`,
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
  const tokens = tokenize(input.trim());
  const commandName = (tokens.shift() || '').replace(/^\//, '').toLowerCase();

  if (!WEB_COMMANDS.some((command) => command.name === commandName)) {
    throw new Error(`Unknown command: /${commandName}`);
  }

  if (
    ((commandName === 'settings' || commandName === 'llmmode') &&
      ctx.config?.features?.runtimeSettings === false) ||
    ((commandName === 'models' || commandName === 'backend') &&
      ctx.config?.features?.backendSwitching === false) ||
    (commandName === 'schedule' && ctx.config?.scheduler.enabled === false) ||
    (commandName === 'restart' && ctx.config?.features?.lifecycle === false)
  ) {
    throw new Error('この機能は管理者により無効化されています');
  }

  switch (commandName) {
    case 'help':
      return { kind: 'message', message: commandHelp() };
    case 'new':
    case 'retitle':
    case 'stop':
    case 'extend':
      return { kind: 'action', action: commandName };
    case 'restart':
      return {
        kind: 'action',
        action: 'restart',
        message: 'xangiを再起動します。進行中のWeb応答は中断されます。',
      };
    case 'settings':
      return { kind: 'message', message: formatSettings(loadSettings()) };
    case 'models':
      return {
        kind: 'message',
        message: await executeModelsCommand(tokens[0], requireResolver(ctx)),
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
        message: `スキル「${skill.name}」を実行してください。${args ? `引数: ${args}` : ''}`,
      };
    }
    case 'backend':
      return await handleBackend(tokens, ctx);
    case 'llmmode':
      return handleLlmMode(tokens, ctx);
    case 'schedule':
      return handleSchedule(tokens, ctx);
    default:
      throw new Error(`Unknown command: /${commandName}`);
  }
}
