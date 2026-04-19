/**
 * xangiコマンドのLocal LLM向けToolHandler
 *
 * CLIスクリプト (xangi-cmd.ts) を exec で呼び出す。
 * Discord接続時のみ discord_* ツールを追加。
 */
import { join } from 'path';
import type { ToolHandler, ToolResult } from './types.js';

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
  async execute(args, context): Promise<ToolResult> {
    const flags: Record<string, string> = {};
    if (args.channel) flags.channel = String(args.channel);
    if (args.count) flags.count = String(args.count);
    if (args.offset) flags.offset = String(args.offset);
    const env = context.channelId ? { XANGI_CHANNEL_ID: context.channelId } : undefined;
    return runXangiCmd(['discord_history', ...flagsToArgs(flags)], env);
  },
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
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_send',
      '--channel',
      String(args.channel),
      '--message',
      String(args.message),
    ]);
  },
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
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['discord_channels', '--guild', String(args.guild)]);
  },
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
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_search',
      '--channel',
      String(args.channel),
      '--keyword',
      String(args.keyword),
    ]);
  },
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
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_edit',
      '--channel',
      String(args.channel),
      '--message-id',
      String(args['message-id']),
      '--content',
      String(args.content),
    ]);
  },
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
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_delete',
      '--channel',
      String(args.channel),
      '--message-id',
      String(args['message-id']),
    ]);
  },
};

// ─── Schedule Tools ─────────────────────────────────────────────────

const scheduleListHandler: ToolHandler = {
  name: 'schedule_list',
  description: 'スケジュール一覧を表示する。',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(): Promise<ToolResult> {
    return runXangiCmd(['schedule_list']);
  },
};

const scheduleAddHandler: ToolHandler = {
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
        description: 'プラットフォーム（discord/slack）',
        enum: ['discord', 'slack'],
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
    return runXangiCmd(['schedule_add', ...flagsToArgs(flags)]);
  },
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
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['schedule_remove', '--id', String(args.id)]);
  },
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
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['schedule_toggle', '--id', String(args.id)]);
  },
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
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'media_send',
      '--channel',
      String(args.channel),
      '--file',
      String(args.file),
    ]);
  },
};

// ─── System Tools ───────────────────────────────────────────────────

const systemRestartHandler: ToolHandler = {
  name: 'system_restart',
  description: 'xangiを再起動する（autoRestartが有効な場合のみ）。',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(): Promise<ToolResult> {
    return runXangiCmd(['system_restart']);
  },
};

const systemSettingsHandler: ToolHandler = {
  name: 'system_settings',
  description: 'xangiの設定を変更または表示する。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '設定キー（省略で一覧表示）' },
      value: { type: 'string', description: '設定値' },
    },
  },
  async execute(args): Promise<ToolResult> {
    const cliArgs = ['system_settings'];
    if (args.key) {
      cliArgs.push('--key', String(args.key));
      if (args.value !== undefined) cliArgs.push('--value', String(args.value));
    }
    return runXangiCmd(cliArgs);
  },
};

// ─── Export ─────────────────────────────────────────────────────────

/** Discord接続時に追加するツール */
export function getDiscordTools(): ToolHandler[] {
  return [
    discordHistoryHandler,
    discordSendHandler,
    discordChannelsHandler,
    discordSearchHandler,
    discordEditHandler,
    discordDeleteHandler,
    mediaSendHandler,
  ];
}

/** スケジュール関連ツール */
export function getScheduleTools(): ToolHandler[] {
  return [scheduleListHandler, scheduleAddHandler, scheduleRemoveHandler, scheduleToggleHandler];
}

/** システム関連ツール */
export function getSystemTools(): ToolHandler[] {
  return [systemRestartHandler, systemSettingsHandler];
}

/** 全xangiツール（プラットフォーム問わず） */
export function getAllXangiTools(): ToolHandler[] {
  return [...getDiscordTools(), ...getScheduleTools(), ...getSystemTools()];
}
