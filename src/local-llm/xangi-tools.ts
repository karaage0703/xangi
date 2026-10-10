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
    'Fetch channel history. Omit channel to use the current channel. Results return to context and are not sent to Discord.',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID (defaults to the current channel)' },
      count: { type: 'string', description: 'Number to fetch (default 10, maximum 100)' },
      offset: { type: 'string', description: 'Offset into older messages' },
    },
  },
  execute: commandExecutor('discord_history', ['channel', 'count', 'offset'], true),
};

const discordMessageHandler: ToolHandler = {
  name: 'discord_message',
  description:
    'Fetch the full, untruncated Discord message using its ID from history. Omit channel to use the current channel.',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID (defaults to the current channel)' },
      'message-id': { type: 'string', description: 'Message ID to fetch' },
    },
    required: ['message-id'],
  },
  execute: commandExecutor('discord_message', ['message-id', 'channel'], true),
};

const discordSendHandler: ToolHandler = {
  name: 'discord_send',
  description: 'Send a message to the specified channel.',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID' },
      message: { type: 'string', description: 'Message to send' },
    },
    required: ['channel', 'message'],
  },
  execute: commandExecutor('discord_send', ['channel', 'message']),
};

const discordChannelsHandler: ToolHandler = {
  name: 'discord_channels',
  description: 'List channels in a server.',
  parameters: {
    type: 'object',
    properties: {
      guild: { type: 'string', description: 'Server (guild) ID' },
    },
    required: ['guild'],
  },
  execute: commandExecutor('discord_channels', ['guild']),
};

const discordSearchHandler: ToolHandler = {
  name: 'discord_search',
  description: 'Search the latest 100 messages in a channel.',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID' },
      keyword: { type: 'string', description: 'Search keyword' },
    },
    required: ['channel', 'keyword'],
  },
  execute: commandExecutor('discord_search', ['channel', 'keyword']),
};

const discordEditHandler: ToolHandler = {
  name: 'discord_edit',
  description: 'Edit your own message.',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID' },
      'message-id': { type: 'string', description: 'Message ID' },
      content: { type: 'string', description: 'New message content' },
    },
    required: ['channel', 'message-id', 'content'],
  },
  execute: commandExecutor('discord_edit', ['channel', 'message-id', 'content']),
};

const discordDeleteHandler: ToolHandler = {
  name: 'discord_delete',
  description: 'Delete your own message.',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID' },
      'message-id': { type: 'string', description: 'Message ID' },
    },
    required: ['channel', 'message-id'],
  },
  execute: commandExecutor('discord_delete', ['channel', 'message-id']),
};

const discordThreadRenameHandler: ToolHandler = {
  name: 'discord_thread_rename',
  description:
    'Rename a Discord thread when the user requests it. Omit channel to use the current thread.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'New thread title (1–100 characters)' },
      channel: { type: 'string', description: 'Thread ID (defaults to the current thread)' },
    },
    required: ['name'],
  },
  execute: commandExecutor('discord_thread_rename', ['name', 'channel']),
};

const discordThreadLeaveHandler: ToolHandler = {
  name: 'discord_thread_leave',
  description:
    "Remove the specified user from a thread (equivalent to Discord's Leave Thread: removes it from that user's sidebar). Omit channel to use the current thread. user is required; when the speaker wants to leave, pass the speaker's user ID.",
  parameters: {
    type: 'object',
    properties: {
      user: {
        type: 'string',
        description:
          "User ID to remove (required; for the speaker to leave, pass the speaker's ID)",
      },
      channel: { type: 'string', description: 'Thread ID (defaults to the current thread)' },
    },
    required: ['user'],
  },
  execute: commandExecutor('discord_thread_leave', ['user', 'channel']),
};

// ─── Schedule Tools ─────────────────────────────────────────────────

const scheduleListHandler: ToolHandler = {
  name: 'schedule_list',
  description: 'List schedules.',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: commandExecutor('schedule_list'),
};

function schedulePlatformEnv(platform?: ChatPlatform): Record<string, string> | undefined {
  return platform === 'discord' ||
    platform === 'slack' ||
    platform === 'telegram' ||
    platform === 'line'
    ? { XANGI_PLATFORM: platform }
    : undefined;
}

type XangiCommandRunner = (args: string[], env?: Record<string, string>) => Promise<ToolResult>;

export function createScheduleAddHandler(
  defaultPlatform?: ChatPlatform,
  executeCommand: XangiCommandRunner = runXangiCmd
): ToolHandler {
  return {
    name: 'schedule_add',
    description:
      'Add a schedule. Omit channel and platform to send to the current conversation. Examples: "30分後 ミーティング", "15:00 レビュー", "毎日 9:00 おはよう", "cron 0 9 * * * おはよう"',
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Schedule input (e.g. "毎日 9:00 おはよう")',
        },
        channel: {
          type: 'string',
          description:
            'Actual destination ID for another conversation (omit for the current conversation)',
        },
        platform: {
          type: 'string',
          description: 'Platform (discord/slack/telegram/line)',
          enum: ['discord', 'slack', 'telegram', 'line'],
        },
      },
      required: ['input'],
    },
    async execute(args, context): Promise<ToolResult> {
      const flags: Record<string, string> = { input: String(args.input) };
      if (args.channel) flags.channel = String(args.channel);
      if (args.platform) flags.platform = String(args.platform);
      return executeCommand(['schedule_add', ...flagsToArgs(flags)], {
        ...schedulePlatformEnv(defaultPlatform),
        ...currentChannelEnv(context.channelId),
      });
    },
  };
}

const scheduleUpdateHandler: ToolHandler = {
  name: 'schedule_update',
  description:
    'Update a schedule while preserving its ID. Unspecified fields are retained. Use message to change only the body, or input to also change its time or type.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Schedule ID' },
      input: {
        type: 'string',
        description: 'Natural-language input updating time, type, and body together',
      },
      message: { type: 'string', description: 'New body without changing time or type' },
      channel: { type: 'string', description: 'New destination channel ID' },
      platform: {
        type: 'string',
        description: 'New platform (channel is also required when changing it)',
        enum: ['discord', 'slack', 'telegram', 'web', 'line'],
      },
    },
    required: ['id'],
  },
  execute: commandExecutor('schedule_update', ['id', 'input', 'message', 'channel', 'platform']),
};

const scheduleRemoveHandler: ToolHandler = {
  name: 'schedule_remove',
  description: 'Delete a schedule.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Schedule ID' },
    },
    required: ['id'],
  },
  execute: commandExecutor('schedule_remove', ['id']),
};

const scheduleToggleHandler: ToolHandler = {
  name: 'schedule_toggle',
  description: 'Toggle a schedule on or off.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Schedule ID' },
    },
    required: ['id'],
  },
  execute: commandExecutor('schedule_toggle', ['id']),
};

// ─── Media Tool ─────────────────────────────────────────────────────

const mediaSendHandler: ToolHandler = {
  name: 'media_send',
  description: 'Send a file to a Discord channel.',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID' },
      file: { type: 'string', description: 'File path' },
    },
    required: ['channel', 'file'],
  },
  execute: commandExecutor('media_send', ['channel', 'file']),
};

// ─── System Tools ───────────────────────────────────────────────────

const systemRestartHandler: ToolHandler = {
  name: 'system_restart',
  description:
    'Restart xangi (only if an administrator set XANGI_SELF_LIFECYCLE=restart-only in .env).',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: commandExecutor('system_restart'),
};

const webStatusHandler: ToolHandler = {
  name: 'web_status',
  description:
    'Get the current Web UI address, bind, port, and HTTP status for Chat and Workspace.',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: commandExecutor('web_status'),
};

const extensionUninstallHandler: ToolHandler = {
  name: 'extension_uninstall',
  description:
    'After approved workspace cleanup, stop and unlink the extension in the current xangi instance, then verify completion.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Extension ID to remove' },
    },
    required: ['id'],
  },
  execute: commandExecutor('extension_uninstall', ['id']),
};

function createRuntimeSettingsHandler(defaultPlatform?: ChatPlatform): ToolHandler {
  return {
    name: 'runtime_settings',
    description:
      'Inspect or change permitted runtime settings when explicitly requested by the user. Do not execute arbitrary slash commands.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Setting name',
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
          description: 'Action',
          enum: ['status', 'set', 'reset'],
        },
        value: { type: 'string', description: 'Setting value' },
        backend: { type: 'string', description: 'Backend for the backend setting' },
        model: { type: 'string', description: 'Model for the backend setting' },
        effort: { type: 'string', description: 'Effort for the backend setting' },
        scope: {
          type: 'string',
          description: 'Scope of the backend setting (default: channel)',
          enum: ['channel', 'global'],
        },
        channel: { type: 'string', description: 'Channel ID to configure' },
        platform: {
          type: 'string',
          description: 'Target platform',
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
    'Fetch conversation history for the current Web Chat pane. Only available in Web sessions. Results return to context and are not sent to Web.',
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'string', description: 'Number to fetch (default 10)' },
      session: { type: 'string', description: 'Session ID (defaults to the current pane)' },
      'max-chars': { type: 'string', description: 'Maximum characters per message (default 500)' },
    },
  },
  execute: commandExecutor('web_history', ['count', 'session', 'max-chars'], true),
};

const progressCardHandler: ToolHandler = {
  name: 'progress_card',
  description:
    "Update the current session's progress card. Use only when the plan or current step changes during a long, multi-step task.",
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'array',
        description: 'Steps replacing the entire card',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'Short task step' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
          },
          required: ['step', 'status'],
        },
      },
      note: { type: 'string', description: 'Short note shown only when needed' },
      clear: { type: 'boolean', description: 'Remove the existing card' },
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
    'Fetch conversation history for the current Slack channel. Only available in Slack sessions. Results return to context and are not sent to Slack.',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID (defaults to the current channel)' },
      count: { type: 'string', description: 'Number to fetch (default 10, maximum 100)' },
    },
  },
  execute: commandExecutor('slack_history', ['channel', 'count'], true),
};

const slackSendHandler: ToolHandler = {
  name: 'slack_send',
  description: 'Send a message to the specified Slack channel. Set thread-ts to reply in a thread.',
  parameters: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Slack channel ID (defaults to the current channel)',
      },
      message: { type: 'string', description: 'Message to send' },
      'thread-ts': { type: 'string', description: 'Thread ts to reply to (optional)' },
    },
    required: ['message'],
  },
  execute: commandExecutor('slack_send', ['message', 'channel', 'thread-ts'], true),
};

const slackChannelsHandler: ToolHandler = {
  name: 'slack_channels',
  description: 'List Slack channels.',
  parameters: {
    type: 'object',
    properties: {
      types: {
        type: 'string',
        description:
          'Channel types to fetch (e.g. public_channel,private_channel; defaults to both)',
      },
      limit: { type: 'string', description: 'Number to fetch (default 100, maximum 1000)' },
    },
  },
  execute: commandExecutor('slack_channels', ['types', 'limit']),
};

const slackSearchHandler: ToolHandler = {
  name: 'slack_search',
  description: 'Search messages in a Slack channel, starting with the most recent.',
  parameters: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Slack channel ID (defaults to the current channel)',
      },
      keyword: { type: 'string', description: 'Search keyword' },
      count: {
        type: 'string',
        description: 'Number of messages to search (default 15, maximum 100)',
      },
    },
    required: ['keyword'],
  },
  execute: commandExecutor('slack_search', ['keyword', 'channel', 'count'], true),
};

const slackEditHandler: ToolHandler = {
  name: 'slack_edit',
  description: 'Edit your own Slack message. Use ts as the Slack message ID.',
  parameters: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Slack channel ID (defaults to the current channel)',
      },
      'message-ts': { type: 'string', description: 'Slack message ts' },
      content: { type: 'string', description: 'New message content' },
    },
    required: ['message-ts', 'content'],
  },
  execute: commandExecutor('slack_edit', ['message-ts', 'content', 'channel'], true),
};

const slackDeleteHandler: ToolHandler = {
  name: 'slack_delete',
  description: 'Delete your own Slack message. Use ts as the Slack message ID.',
  parameters: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Slack channel ID (defaults to the current channel)',
      },
      'message-ts': { type: 'string', description: 'Slack message ts' },
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
    discordThreadRenameHandler,
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
