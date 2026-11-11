import type { Config } from './config.js';
import type { Skill } from './skills.js';

export interface ChatCommandDefinition {
  name: string;
  description: string;
  usage: string;
  category: 'session' | 'skills' | 'settings' | 'system';
  options?: ChatCommandOption[];
}

export interface ChatCommandChoice {
  name: string;
  value: string;
  description?: string;
}

export interface ChatCommandOption {
  name: string;
  description: string;
  type: 'subcommand' | 'string';
  required?: boolean;
  autocomplete?: boolean;
  choices?: ChatCommandChoice[];
  options?: ChatCommandOption[];
}

export const CHAT_SETTING_ITEMS = [
  'notify',
  'replysuggestions',
  'respondtobots',
  'llmmode',
  'llmeffort',
] as const;

const scopeOption: ChatCommandOption = {
  name: 'scope',
  description: '設定範囲（省略時はこの会話・チャンネル）',
  type: 'string',
  choices: [
    { name: '現在の会話・チャンネル', value: 'channel' },
    { name: '全体の既定値', value: 'global' },
  ],
};

export const CHAT_COMMANDS: ChatCommandDefinition[] = [
  {
    name: 'secret',
    description: 'シークレット会話を開始・終了・確認',
    usage: '/secret on|off|status',
    category: 'session',
    options: [
      {
        name: 'mode',
        description: '操作',
        type: 'string',
        required: true,
        choices: [
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
          { name: 'status', value: 'status' },
        ],
      },
    ],
  },
  {
    name: 'new',
    description: '新しいセッションを開始',
    usage: '/new',
    category: 'session',
  },
  {
    name: 'retitle',
    description: '現在の会話タイトルをAIで再生成',
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
    name: 'skill',
    description: '利用可能なスキルを表示・実行',
    usage: '/skill [name] [args]',
    category: 'skills',
    options: [
      {
        name: 'name',
        description: 'スキル名',
        type: 'string',
        autocomplete: true,
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
    usage: '/settings [item] [value]',
    category: 'settings',
    options: [
      {
        name: 'item',
        description: '設定項目（省略時は概要）',
        type: 'string',
        choices: CHAT_SETTING_ITEMS.map((value) => ({ name: value, value })),
      },
      { name: 'value', description: '設定値（省略時はstatus、defaultで解除）', type: 'string' },
    ],
  },
  {
    name: 'backend',
    description: 'バックエンド設定を表示・変更',
    usage: '/backend status|models|set|reset ...',
    category: 'settings',
    options: [
      {
        name: 'models',
        description: 'モデル一覧',
        type: 'subcommand',
        options: [
          {
            name: 'type',
            description: 'バックエンド（省略時はすべて）',
            type: 'string',
            autocomplete: true,
          },
        ],
      },
      {
        name: 'status',
        description: '現在のバックエンド設定を表示',
        type: 'subcommand',
        options: [scopeOption],
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
            autocomplete: true,
            required: true,
          },
          {
            name: 'model',
            description: 'モデル名（任意）',
            type: 'string',
            autocomplete: true,
          },
          { name: 'effort', description: 'effort', type: 'string', autocomplete: true },
          scopeOption,
        ],
      },
      {
        name: 'reset',
        description: 'デフォルトへ戻す',
        type: 'subcommand',
        options: [scopeOption],
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
    name: 'help',
    description: 'コマンド一覧を表示',
    usage: '/help',
    category: 'system',
  },
  {
    name: 'agent',
    description: '会話の担当Agentを確認・切替',
    usage: '/agent list|status|set <id>|reset',
    category: 'settings',
    options: [
      { name: 'list', description: '登録済みAgent', type: 'subcommand' },
      { name: 'status', description: '現在の担当', type: 'subcommand' },
      {
        name: 'set',
        description: '担当を切替・新しい会話を開始',
        type: 'subcommand',
        options: [
          {
            name: 'id',
            description: 'Agent名またはID',
            type: 'string',
            required: true,
            autocomplete: true,
          },
        ],
      },
      { name: 'reset', description: '担当指定を解除', type: 'subcommand' },
    ],
  },
  {
    name: 'workspace',
    description: '作業場所を確認・切替',
    usage: '/workspace status|list|use <name>|set <name> <path>|reset',
    category: 'settings',
    options: [
      { name: 'status', description: '現在の作業場所', type: 'subcommand' },
      { name: 'list', description: '登録済みWorkspace', type: 'subcommand' },
      {
        name: 'use',
        description: '登録済みWorkspaceへ切替',
        type: 'subcommand',
        options: [
          {
            name: 'name',
            description: 'Workspace名',
            type: 'string',
            required: true,
            autocomplete: true,
          },
        ],
      },
      {
        name: 'set',
        description: '既存ディレクトリを登録して切替',
        type: 'subcommand',
        options: [
          { name: 'name', description: '表示名', type: 'string', required: true },
          {
            name: 'path',
            description: '既存ディレクトリの絶対パス',
            type: 'string',
            required: true,
          },
        ],
      },
      { name: 'reset', description: '既定へ戻す', type: 'subcommand' },
    ],
  },
  ...(['autoreply', 'threadmode'] as const).map((name): ChatCommandDefinition => ({
    name,
    description: name === 'autoreply' ? 'メンションなし応答' : 'スレッド返信',
    usage: `/${name} status|on|off|default`,
    category: 'settings',
    options: [
      {
        name: 'mode',
        description: 'モード',
        type: 'string',
        required: true,
        choices: [
          { name: 'status', value: 'status' },
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
          { name: 'default', value: 'default' },
        ],
      },
    ],
  })),
];

export type CommandPlatform = 'discord' | 'web' | 'slack';

export function getChatCommands(
  platform: CommandPlatform,
  config?: Config
): ChatCommandDefinition[] {
  return CHAT_COMMANDS.filter(({ name }) => {
    if (name === 'retitle' && platform === 'slack') return false;
    if (name === 'autoreply' || name === 'threadmode') {
      if (platform === 'web') return false;
      if (config?.features?.runtimeSettings === false) return false;
      return Boolean(
        name === 'autoreply'
          ? config?.discord?.allowAutoreplyCommand
          : config?.discord?.allowThreadModeCommand
      );
    }
    if (name === 'workspace') return config?.features?.workspaceSwitching !== false;
    if (name === 'agent')
      return (
        config?.features?.workspaceSwitching !== false &&
        config?.features?.runtimeSettings !== false &&
        config?.features?.backendSwitching !== false
      );
    if (name === 'settings') return config?.features?.runtimeSettings !== false;
    if (name === 'backend') return config?.features?.backendSwitching !== false;
    if (name === 'schedule') return config?.scheduler?.enabled !== false;
    return true;
  });
}

// Retired built-ins stay reserved so a skill cannot accidentally restore an old operation.
export const RESERVED_COMMAND_NAMES = new Set([
  ...CHAT_COMMANDS.map(({ name }) => name),
  'extend',
  'models',
  'llmmode',
  'llmeffort',
  'team',
  'restart',
  'notify',
  'replysuggestions',
  'respondtobots',
  'skip',
]);

export function skillCommandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

export function skillCommandAliases(skills: Skill[]): Map<string, Skill> {
  const aliases = new Map<string, Skill>();
  const ambiguous = new Set<string>();
  for (const skill of skills) {
    const name = skillCommandName(skill.name);
    if (!name || RESERVED_COMMAND_NAMES.has(name) || ambiguous.has(name)) continue;
    if (aliases.has(name)) {
      aliases.delete(name);
      ambiguous.add(name);
    } else aliases.set(name, skill);
  }
  return aliases;
}

export function skillCommandPrompt(skill: Skill, args: string): string {
  return `Run the skill "${skill.name}". ${args ? `Arguments: ${args}` : ''}`;
}

export function commandHelp(platform: CommandPlatform, config?: Config): string {
  return [
    'コマンド一覧',
    ...getChatCommands(platform, config).map((c) => `• ${c.usage} — ${c.description}`),
    'スキル: /skill 名前 引数、または /スキル名 引数（直接呼び出しにない名前は /skill で選択）',
    '設定の詳細・Team管理はWebの設定画面から操作できます。',
  ].join('\n');
}
