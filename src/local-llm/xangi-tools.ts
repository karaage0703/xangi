/**
 * xangiコマンドのLocal LLM向けToolHandler
 *
 * CLIスクリプト (xangi-cmd.ts) を exec で呼び出す。
 * Discord接続時のみ discord_* ツールを追加。
 */
import { join } from 'path';
import type { ToolHandler, ToolResult } from './types.js';
import type { ChatPlatform } from '../prompts/index.js';
import { featureControlsFromEnv } from '../feature-controls.js';

const CMD_TIMEOUT_MS = 30_000;

/**
 * xangi-cmd.js を実行してToolResultを返す
 */
async function runXangiCmd(args: string[], env?: Record<string, string>): Promise<ToolResult> {
  const cp = await import('child_process');
  const { promisify } = await import('util');
  const execFile = promisify(cp.execFile);

  // dist/cli/xangi-cmd.js のパスを解決
  const cmdPath = join(
    import.meta.url.replace('file://', '').replace(/\/local-llm\/xangi-tools\.js$/, ''),
    'cli',
    'xangi-cmd.js'
  );

  try {
    const { stdout, stderr } = await execFile('node', [cmdPath, ...args], {
      timeout: CMD_TIMEOUT_MS,
      env: { ...process.env, ...env },
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    return { success: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: [e.stdout, e.stderr].filter(Boolean).join('\n').trim(),
      error: e.message ?? String(err),
    };
  }
}

/**
 * フラグをCLI引数に変換
 */
function flagsToArgs(flags: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined && value !== '') {
      args.push(`--${key}`, value);
    }
  }
  return args;
}

function stringFlags(
  args: Record<string, unknown>,
  keys: string[],
  initial: Record<string, string> = {}
): Record<string, string> {
  for (const key of keys) if (args[key] !== undefined) initial[key] = String(args[key]);
  return initial;
}

function currentChannelEnv(channelId?: string): Record<string, string> | undefined {
  return channelId ? { XANGI_CHANNEL_ID: channelId } : undefined;
}

function runFlagCommand(
  command: string,
  args: Record<string, unknown>,
  keys: string[] = [],
  initial: Record<string, string> = {},
  channelId?: string
): Promise<ToolResult> {
  return runXangiCmd(
    [command, ...flagsToArgs(stringFlags(args, keys, initial))],
    currentChannelEnv(channelId)
  );
}

function commandExecutor(
  command: string,
  keys: string[] = [],
  useCurrentChannel = false
): ToolHandler['execute'] {
  return (args, context) =>
    runFlagCommand(command, args, keys, {}, useCurrentChannel ? context.channelId : undefined);
}

// ─── Discord Tools ──────────────────────────────────────────────────

const discordHistoryHandler: ToolHandler = {
  name: 'discord_history',
  description:
    'チャンネルの履歴を取得する。channel省略時は現在のチャンネルを使う。結果はDiscordに送信されず、コンテキストに返る。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID（省略時は現在のチャンネル）' },
      count: { type: 'string', description: '取得件数（デフォルト10、最大100）' },
      offset: { type: 'string', description: 'オフセット（古いメッセージに遡る）' },
    },
  },
  execute: commandExecutor('discord_history', ['channel', 'count', 'offset'], true),
};

const discordMessageHandler: ToolHandler = {
  name: 'discord_message',
  description:
    '履歴に表示されたメッセージIDを使い、特定のDiscordメッセージ本文を省略せず取得する。channel省略時は現在のチャンネルを使う。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID（省略時は現在のチャンネル）' },
      'message-id': { type: 'string', description: '取得するメッセージID' },
    },
    required: ['message-id'],
  },
  execute: commandExecutor('discord_message', ['message-id', 'channel'], true),
};

const discordSendHandler: ToolHandler = {
  name: 'discord_send',
  description: '指定チャンネルにメッセージを送信する。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID' },
      message: { type: 'string', description: '送信するメッセージ' },
    },
    required: ['channel', 'message'],
  },
  execute: commandExecutor('discord_send', ['channel', 'message']),
};

const discordChannelsHandler: ToolHandler = {
  name: 'discord_channels',
  description: 'サーバーのチャンネル一覧を取得する。',
  parameters: {
    type: 'object',
    properties: {
      guild: { type: 'string', description: 'サーバー（ギルド）ID' },
    },
    required: ['guild'],
  },
  execute: commandExecutor('discord_channels', ['guild']),
};

const discordSearchHandler: ToolHandler = {
  name: 'discord_search',
  description: 'チャンネル内のメッセージを検索する（最新100件から）。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID' },
      keyword: { type: 'string', description: '検索キーワード' },
    },
    required: ['channel', 'keyword'],
  },
  execute: commandExecutor('discord_search', ['channel', 'keyword']),
};

const discordEditHandler: ToolHandler = {
  name: 'discord_edit',
  description: '自分のメッセージを編集する。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID' },
      'message-id': { type: 'string', description: 'メッセージID' },
      content: { type: 'string', description: '新しいメッセージ内容' },
    },
    required: ['channel', 'message-id', 'content'],
  },
  execute: commandExecutor('discord_edit', ['channel', 'message-id', 'content']),
};

const discordDeleteHandler: ToolHandler = {
  name: 'discord_delete',
  description: '自分のメッセージを削除する。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID' },
      'message-id': { type: 'string', description: 'メッセージID' },
    },
    required: ['channel', 'message-id'],
  },
  execute: commandExecutor('discord_delete', ['channel', 'message-id']),
};

const discordThreadLeaveHandler: ToolHandler = {
  name: 'discord_thread_leave',
  description:
    'スレッドから指定ユーザーを退出させる（Discordの「このスレッドを退出」と同じ＝そのユーザーのサイドバーから消える）。channel 省略時は現在のスレッドが対象。user は必須で、自分を退出させたい場合は発言者のユーザーIDを渡す。',
  parameters: {
    type: 'object',
    properties: {
      user: { type: 'string', description: '退出させるユーザーID（必須。自分＝発言者のIDを渡す）' },
      channel: { type: 'string', description: 'スレッドID（省略時は現在のスレッド）' },
    },
    required: ['user'],
  },
  execute: commandExecutor('discord_thread_leave', ['user', 'channel']),
};

// ─── Schedule Tools ─────────────────────────────────────────────────

const scheduleListHandler: ToolHandler = {
  name: 'schedule_list',
  description: 'スケジュール一覧を表示する。',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: commandExecutor('schedule_list'),
};

function schedulePlatformEnv(platform?: ChatPlatform): Record<string, string> | undefined {
  return platform === 'discord' || platform === 'slack' || platform === 'telegram'
    ? { XANGI_PLATFORM: platform }
    : undefined;
}

function createScheduleAddHandler(defaultPlatform?: ChatPlatform): ToolHandler {
  return {
    name: 'schedule_add',
    description:
      'スケジュールを追加する。例: "30分後 ミーティング", "15:00 レビュー", "毎日 9:00 おはよう", "cron 0 9 * * * おはよう"',
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'スケジュール設定（例: "毎日 9:00 おはよう"）',
        },
        channel: { type: 'string', description: '送信先チャンネルID' },
        platform: {
          type: 'string',
          description: 'プラットフォーム（discord/slack/telegram）',
          enum: ['discord', 'slack', 'telegram'],
        },
      },
      required: ['input', 'channel'],
    },
    async execute(args): Promise<ToolResult> {
      const flags: Record<string, string> = {
        input: String(args.input),
        channel: String(args.channel),
      };
      if (args.platform) flags.platform = String(args.platform);
      return runXangiCmd(
        ['schedule_add', ...flagsToArgs(flags)],
        schedulePlatformEnv(defaultPlatform)
      );
    },
  };
}

const scheduleUpdateHandler: ToolHandler = {
  name: 'schedule_update',
  description:
    '既存スケジュールをIDを維持したまま更新する。未指定項目は保持される。本文だけならmessage、日時・種別も変えるならinputを指定する。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'スケジュールID' },
      input: {
        type: 'string',
        description: '日時・種別・本文をまとめて更新する自然言語設定',
      },
      message: { type: 'string', description: '日時・種別を変えずに更新する本文' },
      channel: { type: 'string', description: '新しい送信先チャンネルID' },
      platform: {
        type: 'string',
        description: '新しいプラットフォーム（変更時はchannelも必須）',
        enum: ['discord', 'slack', 'telegram', 'web'],
      },
    },
    required: ['id'],
  },
  execute: commandExecutor('schedule_update', ['id', 'input', 'message', 'channel', 'platform']),
};

const scheduleRemoveHandler: ToolHandler = {
  name: 'schedule_remove',
  description: 'スケジュールを削除する。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'スケジュールID' },
    },
    required: ['id'],
  },
  execute: commandExecutor('schedule_remove', ['id']),
};

const scheduleToggleHandler: ToolHandler = {
  name: 'schedule_toggle',
  description: 'スケジュールの有効/無効を切り替える。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'スケジュールID' },
    },
    required: ['id'],
  },
  execute: commandExecutor('schedule_toggle', ['id']),
};

// ─── Media Tool ─────────────────────────────────────────────────────

const mediaSendHandler: ToolHandler = {
  name: 'media_send',
  description: 'ファイルをDiscordチャンネルに送信する。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID' },
      file: { type: 'string', description: 'ファイルパス' },
    },
    required: ['channel', 'file'],
  },
  execute: commandExecutor('media_send', ['channel', 'file']),
};

// ─── System Tools ───────────────────────────────────────────────────

const systemRestartHandler: ToolHandler = {
  name: 'system_restart',
  description:
    'xangiを再起動する（管理者が.envでXANGI_SELF_LIFECYCLE=restart-onlyを設定している場合のみ）。',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: commandExecutor('system_restart'),
};

const webStatusHandler: ToolHandler = {
  name: 'web_status',
  description: '現在のWeb UIアクセス先、bind、port、Chat・WorkspaceのHTTP状態を取得する。',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: commandExecutor('web_status'),
};

const extensionUninstallHandler: ToolHandler = {
  name: 'extension_uninstall',
  description:
    '承認済みのworkspace cleanup後、現在のxangi instanceでextensionを停止・unlinkして完了状態を検証する。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '削除するextension ID' },
    },
    required: ['id'],
  },
  execute: commandExecutor('extension_uninstall', ['id']),
};

function createRuntimeSettingsHandler(defaultPlatform?: ChatPlatform): ToolHandler {
  return {
    name: 'runtime_settings',
    description:
      'ユーザーが明示した場合に、許可されたランタイム設定を確認・変更する。任意のスラッシュコマンドは実行しない。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '設定名',
          enum: [
            'backend',
            'llmmode',
            'autoreply',
            'notify',
            'threadmode',
            'replysuggestions',
            'respondtobots',
          ],
        },
        action: {
          type: 'string',
          description: '操作',
          enum: ['show', 'set', 'reset'],
        },
        value: { type: 'string', description: '設定値' },
        backend: { type: 'string', description: 'backend設定時のbackend' },
        model: { type: 'string', description: 'backend設定時のmodel' },
        effort: { type: 'string', description: 'backend設定時のeffort' },
        scope: {
          type: 'string',
          description: 'backend設定の範囲（既定: channel）',
          enum: ['channel', 'global'],
        },
        channel: { type: 'string', description: '設定対象チャンネルID' },
        platform: {
          type: 'string',
          description: '対象プラットフォーム',
          enum: ['discord', 'slack', 'web', 'line', 'telegram'],
        },
      },
      required: ['name', 'action'],
    },
    async execute(args, context): Promise<ToolResult> {
      const flags = stringFlags(
        args,
        ['value', 'backend', 'model', 'effort', 'scope', 'channel', 'platform'],
        {
          name: String(args.name),
          action: String(args.action),
        }
      );
      const env: Record<string, string> = {};
      if (context.channelId) env.XANGI_CHANNEL_ID = context.channelId;
      if (defaultPlatform) env.XANGI_PLATFORM = defaultPlatform;
      return runXangiCmd(
        ['runtime_settings', ...flagsToArgs(flags)],
        Object.keys(env).length > 0 ? env : undefined
      );
    },
  };
}

// ─── History Tools ──────────────────────────────────────────────────

/**
 * web_history: 現在の Web Chat ペインの履歴を取得する。
 * Web 経由で runner が起動された時、XANGI_CHANNEL_ID=web-chat:<appSessionId> が
 * セットされているのを web-history-cmd が拾う。
 */
const webHistoryHandler: ToolHandler = {
  name: 'web_history',
  description:
    '現在のWeb Chatペインの会話履歴を取得する。Web経由のセッションでのみ動作。結果はWebに送信されず、コンテキストに返る。',
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'string', description: '取得件数（デフォルト10）' },
      session: { type: 'string', description: 'セッションID（省略時は現在のペイン）' },
      'max-chars': { type: 'string', description: '1メッセージあたり最大文字数（デフォルト500）' },
    },
  },
  execute: commandExecutor('web_history', ['count', 'session', 'max-chars'], true),
};

const progressCardHandler: ToolHandler = {
  name: 'progress_card',
  description:
    '現在のセッションの進捗カードを更新する。複数ステップの長い作業で、計画や現在位置が変わった時だけ使う。',
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'array',
        description: 'カード全体を置き換えるステップ一覧',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string', description: '短い作業ステップ' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
          },
          required: ['step', 'status'],
        },
      },
      note: { type: 'string', description: '必要な時だけ表示する短い補足' },
      clear: { type: 'boolean', description: '既存カードを削除する' },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const flags: Record<string, string> = {};
    if (args.plan !== undefined) flags['plan-json'] = JSON.stringify(args.plan);
    if (args.note !== undefined) flags.note = String(args.note);
    if (args.clear === true) flags.clear = 'true';
    const env = context.channelId ? { XANGI_CHANNEL_ID: context.channelId } : undefined;
    return runXangiCmd(['progress_card', ...flagsToArgs(flags)], env);
  },
};

/**
 * slack_history: 現在の Slack チャンネルの履歴を取得する。
 * Slack 経由で runner が起動された時、XANGI_CHANNEL_ID=<channelId> がセットされる。
 */
const slackHistoryHandler: ToolHandler = {
  name: 'slack_history',
  description:
    '現在のSlackチャンネルの会話履歴を取得する。Slack経由のセッションでのみ動作。結果はSlackに送信されず、コンテキストに返る。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルID（省略時は現在のチャンネル）' },
      count: { type: 'string', description: '取得件数（デフォルト10、最大100）' },
    },
  },
  execute: commandExecutor('slack_history', ['channel', 'count'], true),
};

const slackSendHandler: ToolHandler = {
  name: 'slack_send',
  description: '指定Slackチャンネルにメッセージを送信する。thread-ts指定でスレッド返信もできる。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'SlackチャンネルID（省略時は現在のチャンネル）' },
      message: { type: 'string', description: '送信するメッセージ' },
      'thread-ts': { type: 'string', description: '返信先スレッドのts（任意）' },
    },
    required: ['message'],
  },
  execute: commandExecutor('slack_send', ['message', 'channel', 'thread-ts'], true),
};

const slackChannelsHandler: ToolHandler = {
  name: 'slack_channels',
  description: 'Slackチャンネル一覧を取得する。',
  parameters: {
    type: 'object',
    properties: {
      types: {
        type: 'string',
        description: '取得対象（例: public_channel,private_channel。デフォルトは両方）',
      },
      limit: { type: 'string', description: '取得件数（デフォルト100、最大1000）' },
    },
  },
  execute: commandExecutor('slack_channels', ['types', 'limit']),
};

const slackSearchHandler: ToolHandler = {
  name: 'slack_search',
  description: 'Slackチャンネル内のメッセージを検索する（最新メッセージから）。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'SlackチャンネルID（省略時は現在のチャンネル）' },
      keyword: { type: 'string', description: '検索キーワード' },
      count: { type: 'string', description: '検索対象件数（デフォルト15、最大100）' },
    },
    required: ['keyword'],
  },
  execute: commandExecutor('slack_search', ['keyword', 'channel', 'count'], true),
};

const slackEditHandler: ToolHandler = {
  name: 'slack_edit',
  description: 'Slack上の自分のメッセージを編集する。SlackのメッセージIDはtsを使う。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'SlackチャンネルID（省略時は現在のチャンネル）' },
      'message-ts': { type: 'string', description: 'Slackメッセージts' },
      content: { type: 'string', description: '新しいメッセージ内容' },
    },
    required: ['message-ts', 'content'],
  },
  execute: commandExecutor('slack_edit', ['message-ts', 'content', 'channel'], true),
};

const slackDeleteHandler: ToolHandler = {
  name: 'slack_delete',
  description: 'Slack上の自分のメッセージを削除する。SlackのメッセージIDはtsを使う。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'SlackチャンネルID（省略時は現在のチャンネル）' },
      'message-ts': { type: 'string', description: 'Slackメッセージts' },
    },
    required: ['message-ts'],
  },
  execute: commandExecutor('slack_delete', ['message-ts', 'channel'], true),
};

// ─── Export ─────────────────────────────────────────────────────────

/** Discord接続時に追加するツール */
export function getDiscordTools(): ToolHandler[] {
  return [
    discordHistoryHandler,
    discordMessageHandler,
    discordSendHandler,
    discordChannelsHandler,
    discordSearchHandler,
    discordEditHandler,
    discordDeleteHandler,
    discordThreadLeaveHandler,
    mediaSendHandler,
  ];
}

/** Web接続時に追加するツール */
export function getWebTools(): ToolHandler[] {
  return [webHistoryHandler, mediaSendHandler];
}

/** Slack接続時に追加するツール */
export function getSlackTools(): ToolHandler[] {
  return [
    slackHistoryHandler,
    slackSendHandler,
    slackChannelsHandler,
    slackSearchHandler,
    slackEditHandler,
    slackDeleteHandler,
  ];
}

/** スケジュール関連ツール */
export function getScheduleTools(platform?: ChatPlatform): ToolHandler[] {
  if (process.env.SCHEDULER_ENABLED === 'false') return [];
  return [
    scheduleListHandler,
    createScheduleAddHandler(platform),
    scheduleUpdateHandler,
    scheduleRemoveHandler,
    scheduleToggleHandler,
  ];
}

/** システム関連ツール */
export function getSystemTools(platform?: ChatPlatform): ToolHandler[] {
  const features = featureControlsFromEnv();
  const tools = [webStatusHandler];
  if (features.lifecycle) tools.push(systemRestartHandler);
  if (features.runtimeSettings || features.backendSwitching) {
    tools.push(createRuntimeSettingsHandler(platform));
  }
  return tools;
}

/** Extension lifecycle関連ツール */
export function getExtensionTools(): ToolHandler[] {
  return [extensionUninstallHandler];
}

/** 履歴取得ツール (web_history / slack_history)。プラットフォームに応じてランナーが呼ぶ */
export function getHistoryTools(): ToolHandler[] {
  return [webHistoryHandler, slackHistoryHandler];
}

/** 全xangiツール（プラットフォーム問わず） */
export function getAllXangiTools(): ToolHandler[] {
  return [
    ...getDiscordTools(),
    ...getSlackTools(),
    webHistoryHandler,
    progressCardHandler,
    ...getScheduleTools(),
    ...getSystemTools(),
    ...getExtensionTools(),
  ];
}

/** 実行プラットフォームに応じたxangiツール */
export function getXangiTools(platform?: ChatPlatform): ToolHandler[] {
  const commonTools = [
    progressCardHandler,
    ...getScheduleTools(platform),
    ...getSystemTools(platform),
    ...getExtensionTools(),
  ];

  if (platform === 'web') {
    return [...getWebTools(), ...commonTools];
  }

  if (platform === 'discord') {
    return [...getDiscordTools(), ...commonTools];
  }

  if (platform === 'slack') {
    return [...getSlackTools(), ...commonTools];
  }

  if (platform === 'line' || platform === 'telegram') {
    return commonTools;
  }

  return getAllXangiTools();
}
